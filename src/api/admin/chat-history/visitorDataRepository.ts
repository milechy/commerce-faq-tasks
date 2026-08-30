// src/api/admin/chat-history/visitorDataRepository.ts
//
// GDPR/個情法の「削除請求」「開示(データポータビリティ)請求」を visitor 単位で処理する。
//
// visitor_id は widget の localStorage 由来(r2c_vid)で、テナントを跨いで衝突しうる。
// そのため必ず (tenant_id, visitor_id) の複合でスコープすること。単独キーにしてはならない
// (migration_visitor_id.sql のコメント参照)。呼び出し元は tenantId を必ず解決してから渡す。
//
// 原理的限界: visitor_id は「セッション新規作成時のみ」記録される(saveMessage)。
// プライベートブラウズや event_tracking 無効テナントでは付与されないため、該当0件が正常。

import { getPool } from "../../../lib/db";
import type { Pool } from "pg";

export interface ExportVisitorParams {
  tenantId: string;
  visitorId: string;
  pool?: Pool;
}

export interface ExportedMessage {
  role: string;
  content: string;
  created_at: string;
  metadata: unknown;
}

export interface ExportedSession {
  session_db_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  outcome: string | null;
  messages: ExportedMessage[];
}

export interface ExportVisitorResult {
  tenant_id: string;
  visitor_id: string;
  exported_at: string;
  session_count: number;
  message_count: number;
  sessions: ExportedSession[];
}

/**
 * visitor の全会話(セッション + 本文)を JSON でエクスポートする(読み取りのみ)。
 * 該当が無い場合は sessions:[] を返す(0件は正常)。
 */
export async function exportVisitorData(
  params: ExportVisitorParams,
): Promise<ExportVisitorResult> {
  const pool = params.pool ?? getPool();
  const { tenantId, visitorId } = params;

  const sessRes = await pool.query<{
    id: string;
    session_id: string;
    started_at: string;
    last_message_at: string;
    message_count: number;
    outcome: string | null;
  }>(
    `SELECT id, session_id, started_at, last_message_at, message_count, outcome
       FROM chat_sessions
      WHERE tenant_id = $1 AND visitor_id = $2
      ORDER BY started_at ASC`,
    [tenantId, visitorId],
  );

  const sessions: ExportedSession[] = [];
  let totalMessages = 0;

  for (const s of sessRes.rows) {
    const msgRes = await pool.query<{
      role: string;
      content: string;
      created_at: string;
      metadata: unknown;
    }>(
      `SELECT role, content, created_at, metadata
         FROM chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC`,
      [s.id],
    );
    totalMessages += msgRes.rows.length;
    sessions.push({
      session_db_id: s.id,
      session_id: s.session_id,
      started_at: s.started_at,
      last_message_at: s.last_message_at,
      message_count: s.message_count,
      outcome: s.outcome,
      messages: msgRes.rows.map((m) => ({
        role: m.role,
        content: m.content,
        created_at: m.created_at,
        metadata: m.metadata,
      })),
    });
  }

  return {
    tenant_id: tenantId,
    visitor_id: visitorId,
    exported_at: new Date().toISOString(),
    session_count: sessions.length,
    message_count: totalMessages,
    sessions,
  };
}

export interface DeleteVisitorParams {
  tenantId: string;
  visitorId: string;
  actorRole: string;
  actorEmail: string;
  reason: string;
  pool?: Pool;
}

export interface DeleteVisitorResult {
  tenant_id: string;
  visitor_id: string;
  affected_counts: {
    chat_sessions: number;
    chat_messages: number;
    option_orders_nulled: number;
  };
}

/**
 * visitor の全会話を削除する(TX + audit_logs)。chat_messages は CASCADE。
 * 該当0件でも成功として counts=0 を返す(冪等・削除請求として妥当)。
 */
export async function deleteVisitorData(
  params: DeleteVisitorParams,
): Promise<DeleteVisitorResult> {
  const pool = params.pool ?? getPool();
  const { tenantId, visitorId } = params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const idsRes = await client.query<{ id: string }>(
      `SELECT id FROM chat_sessions WHERE tenant_id = $1 AND visitor_id = $2 FOR UPDATE`,
      [tenantId, visitorId],
    );
    const ids = idsRes.rows.map((r) => r.id);

    let msgCount = 0;
    let ordersNulled = 0;
    let sessDeleted = 0;

    if (ids.length > 0) {
      const msgCountRes = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ANY($1::uuid[])`,
        [ids],
      );
      msgCount = parseInt(msgCountRes.rows[0]?.cnt ?? "0", 10);

      const ordersRes = await client.query(
        `UPDATE option_orders SET chat_session_id = NULL WHERE chat_session_id = ANY($1::uuid[])`,
        [ids],
      );
      ordersNulled = ordersRes.rowCount ?? 0;

      const delRes = await client.query(
        `DELETE FROM chat_sessions WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      sessDeleted = delRes.rowCount ?? 0;
    }

    // 監査は該当0件でも記録する(「削除請求を受け処理した」事実自体を残すため)。
    await client.query(
      `INSERT INTO audit_logs (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        "delete_visitor_data",
        params.actorRole,
        params.actorEmail,
        "visitor",
        visitorId,
        JSON.stringify({
          reason: params.reason,
          affected_counts: {
            chat_sessions: sessDeleted,
            chat_messages: msgCount,
            option_orders_nulled: ordersNulled,
          },
        }),
      ],
    );

    await client.query("COMMIT");
    return {
      tenant_id: tenantId,
      visitor_id: visitorId,
      affected_counts: {
        chat_sessions: sessDeleted,
        chat_messages: msgCount,
        option_orders_nulled: ordersNulled,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
