// src/api/admin/feedback/feedbackRepository.ts

import { getPool } from "../../../lib/db";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface FeedbackMessage {
  id: number;
  tenant_id: string;
  sender_role: "client_admin" | "super_admin";
  sender_email: string | null;
  content: string;
  is_read: boolean;
  flagged_for_improvement: boolean;
  created_at: string;
}

export interface FeedbackThread {
  tenant_id: string;
  tenant_name: string;
  last_message: string;
  last_message_at: string;
  unread_count: number;
}

// ---------------------------------------------------------------------------
// クエリ
// ---------------------------------------------------------------------------

/** メッセージ一覧取得 */
export async function getMessages(params: {
  tenantId: string;
  limit?: number;
  offset?: number;
  flaggedOnly?: boolean;
}): Promise<{ messages: FeedbackMessage[]; total: number }> {
  const pool = getPool();
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const flagClause = params.flaggedOnly ? " AND flagged_for_improvement = true" : "";

  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM feedback_messages WHERE tenant_id = $1${flagClause}`,
    [params.tenantId]
  );
  const total = parseInt(countRes.rows[0]?.cnt ?? "0", 10);

  const res = await pool.query(
    `SELECT id, tenant_id, sender_role, sender_email, content, is_read, flagged_for_improvement, created_at
     FROM feedback_messages
     WHERE tenant_id = $1${flagClause}
     ORDER BY created_at ASC
     LIMIT $2 OFFSET $3`,
    [params.tenantId, limit, offset]
  );

  return { messages: res.rows as FeedbackMessage[], total };
}

/** 改善フラグのトグル（Super Admin専用） */
export async function flagMessage(messageId: number, flagged: boolean): Promise<FeedbackMessage | null> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE feedback_messages
     SET flagged_for_improvement = $1
     WHERE id = $2
     RETURNING id, tenant_id, sender_role, sender_email, content, is_read, flagged_for_improvement, created_at`,
    [flagged, messageId]
  );
  return (res.rows[0] as FeedbackMessage) ?? null;
}

/** メッセージ送信 */
export async function sendMessage(params: {
  tenantId: string;
  senderRole: "client_admin" | "super_admin";
  senderEmail?: string;
  content: string;
}): Promise<FeedbackMessage> {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO feedback_messages (tenant_id, sender_role, sender_email, content)
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, sender_role, sender_email, content, is_read, flagged_for_improvement, created_at`,
    [params.tenantId, params.senderRole, params.senderEmail ?? null, params.content]
  );
  return res.rows[0] as FeedbackMessage;
}

/** テナント別スレッド一覧（Super Admin用）
 *  各テナントの最新メッセージ + client_admin→super_admin の未読数を返す */
export async function getThreads(): Promise<FeedbackThread[]> {
  const pool = getPool();
  const res = await pool.query(`
    SELECT
      fm.tenant_id,
      latest.last_message,
      latest.last_message_at,
      COALESCE(unread.cnt, 0)::int AS unread_count
    FROM (
      SELECT DISTINCT tenant_id FROM feedback_messages
    ) fm
    JOIN LATERAL (
      SELECT content AS last_message, created_at AS last_message_at
      FROM feedback_messages
      WHERE tenant_id = fm.tenant_id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM feedback_messages
      WHERE tenant_id = fm.tenant_id
        AND sender_role = 'client_admin'
        AND is_read = false
    ) unread ON true
    ORDER BY latest.last_message_at DESC
  `);
  // tenant_name はフロントで解決（テナント一覧APIを使用）
  return (res.rows as Array<{ tenant_id: string; last_message: string; last_message_at: string; unread_count: number }>).map((r) => ({
    tenant_id: r.tenant_id as string,
    tenant_name: r.tenant_id as string, // フロント側で上書き
    last_message: r.last_message as string,
    last_message_at: r.last_message_at as string,
    unread_count: r.unread_count as number,
  }));
}

/** 既読処理: そのテナントの client_admin メッセージを既読にする（Super Admin が読む側） */
export async function markAsRead(tenantId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE feedback_messages
     SET is_read = true
     WHERE tenant_id = $1 AND sender_role = 'client_admin' AND is_read = false`,
    [tenantId]
  );
}

/** Super Admin返信を client_admin 側が既読にする */
export async function markSuperAdminMessagesAsRead(tenantId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE feedback_messages
     SET is_read = true
     WHERE tenant_id = $1 AND sender_role = 'super_admin' AND is_read = false`,
    [tenantId]
  );
}

/** 未読数取得（Super Admin用: client_admin からの未読、client_admin用: super_admin からの未読） */
export async function getUnreadCount(tenantId: string, readerRole: "super_admin" | "client_admin"): Promise<number> {
  const pool = getPool();
  // super_admin が読む → client_admin が送ったものの未読
  // client_admin が読む → super_admin が送ったものの未読
  const senderRole = readerRole === "super_admin" ? "client_admin" : "super_admin";
  const res = await pool.query(
    `SELECT COUNT(*) AS cnt FROM feedback_messages
     WHERE tenant_id = $1 AND sender_role = $2 AND is_read = false`,
    [tenantId, senderRole]
  );
  return parseInt(res.rows[0]?.cnt ?? "0", 10);
}
