// src/api/admin/chat-history/chatHistoryRepository.ts
// Phase38: 会話履歴DB永続化リポジトリ

// @ts-ignore
import { Pool } from "pg";

// lazy singleton: DATABASE_URL から Pool を一度だけ作成
let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

export interface SaveMessageParams {
  tenantId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * ユーザー/アシスタントのメッセージをDBに永続化する。
 * chat_sessions を upsert し、chat_messages に INSERT する。
 * 呼び出し元は fire-and-forget (.catch のみ) で使うこと。
 */
export async function saveMessage(params: SaveMessageParams): Promise<void> {
  const pool = getPool();

  // 1. chat_sessions を upsert
  await pool.query(
    `INSERT INTO chat_sessions (tenant_id, session_id, last_message_at, message_count)
     VALUES ($1, $2, NOW(), 1)
     ON CONFLICT (tenant_id, session_id) DO UPDATE SET
       last_message_at = NOW(),
       message_count = chat_sessions.message_count + 1`,
    [params.tenantId, params.sessionId],
  );

  // 2. chat_sessions の UUID を取得
  const sessionResult = await pool.query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  const dbSessionId = sessionResult.rows[0]?.id;
  if (!dbSessionId) return;

  // 3. メッセージを保存
  await pool.query(
    `INSERT INTO chat_messages (session_id, tenant_id, role, content, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      dbSessionId,
      params.tenantId,
      params.role,
      params.content,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}
