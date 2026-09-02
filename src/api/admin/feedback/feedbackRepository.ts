// src/api/admin/feedback/feedbackRepository.ts
//
// NOTE(2026-09-02): 旧チャット系フィードバック機能(GET/POST /v1/admin/feedback,
// /threads, /read, /unread-count, /:messageId/flag を提供していた feedbackRoutes.ts)
// はルート登録順序の衝突で到達不能になっており廃止した(Asana GID 1218086285251452)。
// getMessages のみ feedbackAI.ts の会話コンテキスト参照用に残っている。
// feedback_messages テーブル自体はデータ保持のため削除しない。

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
