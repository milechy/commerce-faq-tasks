// src/api/admin/chat-history/deleteSessionRepository.ts
// Phase69-1: Right to Erasure — セッション削除（トランザクション + audit_logs 記録）

import { getPool } from "../../../lib/db";

export interface DeleteSessionParams {
  sessionDbId: string;    // chat_sessions.id (UUID)
  tenantId: string | undefined; // undefined = super_admin（テナント縛りなし）
  actorRole: string;
  actorEmail: string;     // NOT NULL: 空文字許容
  reason: string;         // 5–500 文字必須
}

export interface DeleteSessionResult {
  deleted_session_id: string;
  affected_counts: {
    chat_messages: number;
    option_orders_nulled: number;
  };
}

/**
 * チャットセッションをトランザクション内で削除する。
 * - chat_messages: CASCADE DELETE（FK ON DELETE CASCADE）
 * - option_orders.chat_session_id: NULL 化（FK なし、レコードは保持）
 * - audit_logs: 同一 TX 内に記録
 *
 * テナント不一致・未存在時は null を返す（呼び出し元が 404 を返すこと）。
 */
export async function deleteSession(
  params: DeleteSessionParams,
): Promise<DeleteSessionResult | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. セッション取得（テナント所有権チェック + 行ロック）
    // FOR UPDATE で並行削除との競合を防ぐ
    const sessionResult = await client.query<{ id: string; tenant_id: string }>(
      params.tenantId
        ? `SELECT id, tenant_id FROM chat_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`
        : `SELECT id, tenant_id FROM chat_sessions WHERE id = $1 FOR UPDATE`,
      params.tenantId ? [params.sessionDbId, params.tenantId] : [params.sessionDbId],
    );

    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const session = sessionResult.rows[0];
    const effectiveTenantId = session.tenant_id;

    // 2. 削除件数カウント（audit_logs.metadata.affected_counts 用）
    const msgCountResult = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = $1`,
      [session.id],
    );
    const msgCount = parseInt(msgCountResult.rows[0]?.cnt ?? "0", 10);

    const orderCountResult = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM option_orders WHERE chat_session_id = $1`,
      [session.id],
    );
    const orderCount = parseInt(orderCountResult.rows[0]?.cnt ?? "0", 10);

    // 3. option_orders.chat_session_id を NULL 化（レコード自体は保持）
    if (orderCount > 0) {
      await client.query(
        `UPDATE option_orders SET chat_session_id = NULL WHERE chat_session_id = $1`,
        [session.id],
      );
    }

    // 4. chat_sessions 削除（chat_messages は CASCADE DELETE）
    // Phase69-1 fix [MEDIUM]: RETURNING で実際に削除されたことを証明し、
    // audit_logs への記録を削除成功後にのみ行う
    const deleteResult = await client.query<{ id: string }>(
      `DELETE FROM chat_sessions WHERE id = $1 RETURNING id`,
      [session.id],
    );

    if ((deleteResult.rowCount ?? 0) !== 1) {
      // FOR UPDATE 取得後に消えることは通常起き得ないが、防御として
      await client.query("ROLLBACK");
      throw new Error(`Deletion verification failed for session ${session.id}`);
    }

    // 5. audit_logs 記録（削除成功が証明された後のみ）
    const metadata = {
      reason: params.reason,
      affected_counts: {
        chat_messages: msgCount,
        option_orders_nulled: orderCount,
      },
    };

    await client.query(
      `INSERT INTO audit_logs
         (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        effectiveTenantId,
        "delete_chat_session",
        params.actorRole,
        params.actorEmail,
        "chat_session",
        session.id,
        JSON.stringify(metadata),
      ],
    );

    await client.query("COMMIT");

    return {
      deleted_session_id: session.id,
      affected_counts: {
        chat_messages: msgCount,
        option_orders_nulled: orderCount,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
