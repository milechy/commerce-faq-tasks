// src/api/admin/chat-history/retentionRepository.ts
//
// 会話の保持期間(retention)バッチと、テナント退会時のデータ消去の DB 操作。
// deleteSessionRepository.ts の「TX + option_orders NULL 化 + audit_logs 記録」パターンを踏襲する。
//
// 破壊的操作のため、以下を厳守する:
//   - dryRun=true では一切書き込まず、削除対象の件数だけを数えて返す。
//   - 呼び出し元(バッチ)は CHAT_RETENTION_DAYS / TENANT_PURGE_GRACE_DAYS が未設定なら
//     そもそもこの関数を呼ばない(既定 no-op)。
//   - セッション単位の CASCADE 削除(chat_messages は FK ON DELETE CASCADE)で本文を消す。
//   - option_orders.chat_session_id は FK が無い(発注記録は保持)ため、参照を NULL 化してから
//     セッションを消す(dangling 参照を残さない)。

import { getPool } from "../../../lib/db";
import type { Pool } from "pg";

// audit_logs.tenant_id は NOT NULL。テナント横断の保持バッチはこの疑似テナントで記録する。
const SYSTEM_ACTOR_TENANT = "__system__";

export interface PurgeCounts {
  sessions: number;
  messages: number;
  option_orders_nulled: number;
}

export interface PurgeExpiredParams {
  retentionDays: number;
  dryRun: boolean;
  /** 1 TX で削除するセッション数の上限。巨大な TX とロック保持を避ける。 */
  batchSize?: number;
  actorEmail?: string;
  pool?: Pool;
}

export interface PurgeExpiredResult extends PurgeCounts {
  cutoff: string;
  dryRun: boolean;
  batches: number;
}

/**
 * last_message_at が (now - retentionDays) より古い chat_sessions を削除する。
 * chat_messages は CASCADE で消える。dryRun では件数のみ算出して何も書かない。
 */
export async function purgeExpiredChatData(
  params: PurgeExpiredParams,
): Promise<PurgeExpiredResult> {
  if (!Number.isFinite(params.retentionDays) || params.retentionDays <= 0) {
    throw new Error(`retentionDays must be a positive number, got ${params.retentionDays}`);
  }
  const pool = params.pool ?? getPool();
  const batchSize = params.batchSize && params.batchSize > 0 ? params.batchSize : 500;
  const actorEmail = params.actorEmail ?? "";

  // カットオフは DB 側の NOW() を基準に算出する(アプリ時計とのズレを避ける)。
  const cutoffRes = await pool.query<{ cutoff: string }>(
    `SELECT (NOW() - ($1 || ' days')::interval) AS cutoff`,
    [String(params.retentionDays)],
  );
  const cutoff = cutoffRes.rows[0]?.cutoff ?? "";

  const totals: PurgeCounts = { sessions: 0, messages: 0, option_orders_nulled: 0 };

  // dry-run: 対象を数えるだけ(書き込みなし)。
  if (params.dryRun) {
    const sessRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM chat_sessions WHERE last_message_at < $1`,
      [cutoff],
    );
    const msgRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM chat_messages
        WHERE session_id IN (SELECT id FROM chat_sessions WHERE last_message_at < $1)`,
      [cutoff],
    );
    totals.sessions = parseInt(sessRes.rows[0]?.cnt ?? "0", 10);
    totals.messages = parseInt(msgRes.rows[0]?.cnt ?? "0", 10);
    return { ...totals, cutoff, dryRun: true, batches: 0 };
  }

  let batches = 0;
  // 上限件数ずつ TX で削除する。対象が尽きるまで繰り返す。
  // 無限ループ保険として、削除0件になったら抜ける。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");

      const idsRes = await client.query<{ id: string }>(
        `SELECT id FROM chat_sessions
          WHERE last_message_at < $1
          ORDER BY last_message_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [cutoff, batchSize],
      );
      const ids = idsRes.rows.map((r) => r.id);
      if (ids.length === 0) {
        await client.query("ROLLBACK");
        break;
      }

      const msgCountRes = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ANY($1::uuid[])`,
        [ids],
      );
      const msgCount = parseInt(msgCountRes.rows[0]?.cnt ?? "0", 10);

      const ordersRes = await client.query(
        `UPDATE option_orders SET chat_session_id = NULL WHERE chat_session_id = ANY($1::uuid[])`,
        [ids],
      );
      const ordersNulled = ordersRes.rowCount ?? 0;

      const delRes = await client.query(
        `DELETE FROM chat_sessions WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      const sessDeleted = delRes.rowCount ?? 0;

      // 監査: バッチごとに1件、疑似テナントで集約記録する。
      await client.query(
        `INSERT INTO audit_logs (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          SYSTEM_ACTOR_TENANT,
          "retention_purge",
          "system",
          actorEmail,
          "chat_session_batch",
          `cutoff:${cutoff}`,
          JSON.stringify({
            retention_days: params.retentionDays,
            cutoff,
            affected_counts: {
              chat_sessions: sessDeleted,
              chat_messages: msgCount,
              option_orders_nulled: ordersNulled,
            },
          }),
        ],
      );

      await client.query("COMMIT");
      totals.sessions += sessDeleted;
      totals.messages += msgCount;
      totals.option_orders_nulled += ordersNulled;
      batches += 1;

      // このバッチで上限未満しか取れなければ、対象は尽きている。
      if (ids.length < batchSize) break;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { ...totals, cutoff, dryRun: false, batches };
}

export interface PurgeTenantParams {
  tenantId: string;
  actorRole: string;
  actorEmail: string;
  reason: string;
  dryRun?: boolean;
  pool?: Pool;
}

export interface PurgeTenantResult extends PurgeCounts {
  tenant_id: string;
  dryRun: boolean;
}

/**
 * 指定テナントの会話データ(chat_sessions/chat_messages)を全消去する。
 * テナント退会フローから呼ばれる。TX + audit_logs 記録。
 * dryRun では件数のみ返す。
 */
export async function purgeTenantChatData(
  params: PurgeTenantParams,
): Promise<PurgeTenantResult> {
  const tenantId = params.tenantId;
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("tenantId is required for purgeTenantChatData");
  }
  const pool = params.pool ?? getPool();
  const dryRun = params.dryRun ?? false;

  if (dryRun) {
    const sessRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM chat_sessions WHERE tenant_id = $1`,
      [tenantId],
    );
    const msgRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM chat_messages WHERE tenant_id = $1`,
      [tenantId],
    );
    return {
      tenant_id: tenantId,
      sessions: parseInt(sessRes.rows[0]?.cnt ?? "0", 10),
      messages: parseInt(msgRes.rows[0]?.cnt ?? "0", 10),
      option_orders_nulled: 0,
      dryRun: true,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");

    const msgCountRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM chat_messages WHERE tenant_id = $1`,
      [tenantId],
    );
    const msgCount = parseInt(msgCountRes.rows[0]?.cnt ?? "0", 10);

    const ordersRes = await client.query(
      `UPDATE option_orders SET chat_session_id = NULL
        WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE tenant_id = $1)`,
      [tenantId],
    );
    const ordersNulled = ordersRes.rowCount ?? 0;

    const delRes = await client.query(
      `DELETE FROM chat_sessions WHERE tenant_id = $1`,
      [tenantId],
    );
    const sessDeleted = delRes.rowCount ?? 0;

    // 消去完了時刻を記録(再消去のスキップ判定・監査用)。列が無い環境でも
    // 会話消去自体は成立させたいが、退会フローの一貫性のため同一 TX 内で更新する。
    await client.query(
      `UPDATE tenants SET chat_data_purged_at = NOW() WHERE id = $1`,
      [tenantId],
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        "tenant_chat_data_purge",
        params.actorRole,
        params.actorEmail,
        "tenant",
        tenantId,
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
      sessions: sessDeleted,
      messages: msgCount,
      option_orders_nulled: ordersNulled,
      dryRun: false,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface DueTenantPurge {
  tenant_id: string;
  requested_at: string;
}

/**
 * 消去予約(chat_data_purge_requested_at)から graceDays 以上経過し、まだ消去していない
 * (chat_data_purged_at が予約より前 or NULL)テナントを返す。バッチが消去対象を拾うのに使う。
 */
export async function findTenantsDueForPurge(
  graceDays: number,
  pool?: Pool,
): Promise<DueTenantPurge[]> {
  const p = pool ?? getPool();
  const res = await p.query<{ id: string; chat_data_purge_requested_at: string }>(
    `SELECT id, chat_data_purge_requested_at
       FROM tenants
      WHERE chat_data_purge_requested_at IS NOT NULL
        AND chat_data_purge_requested_at < (NOW() - ($1 || ' days')::interval)
        AND (chat_data_purged_at IS NULL OR chat_data_purged_at < chat_data_purge_requested_at)`,
    [String(graceDays)],
  );
  return res.rows.map((r) => ({
    tenant_id: r.id,
    requested_at: r.chat_data_purge_requested_at,
  }));
}
