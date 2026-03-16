// src/api/admin/chat-history/chatHistoryRepository.ts
// Phase38: 会話履歴DB永続化リポジトリ（Step1: 保存 / Step2: 取得）

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

// ---------------------------------------------------------------------------
// Step2: 取得クエリ
// ---------------------------------------------------------------------------

export interface SessionListParams {
  tenantId?: string;  // 指定なし = 全テナント（super_admin 用）
  limit?: number;     // デフォルト 50
  offset?: number;    // デフォルト 0
}

export interface SessionSummary {
  id: string;               // DB 内部 UUID
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  first_message_preview: string;  // 最初のユーザーメッセージ先頭 50 文字
}

/**
 * セッション一覧を取得する（last_message_at DESC）。
 * first_message_preview は LATERAL JOIN で一括取得する。
 */
export async function getSessions(
  params: SessionListParams,
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  // WHERE 句はテナント指定の有無で分岐
  const whereClause = params.tenantId ? `WHERE s.tenant_id = $1` : "";
  const countArgs: unknown[] = params.tenantId ? [params.tenantId] : [];
  const listArgs: unknown[] = params.tenantId
    ? [params.tenantId, limit, offset]
    : [limit, offset];
  const limitPlaceholder = params.tenantId ? "$2" : "$1";
  const offsetPlaceholder = params.tenantId ? "$3" : "$2";

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM chat_sessions s ${whereClause}`,
    countArgs,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const listResult = await pool.query<SessionSummary>(
    `SELECT
       s.id,
       s.tenant_id,
       s.session_id,
       s.started_at,
       s.last_message_at,
       s.message_count,
       COALESCE(LEFT(m.content, 50), '') AS first_message_preview
     FROM chat_sessions s
     LEFT JOIN LATERAL (
       SELECT content
       FROM chat_messages
       WHERE session_id = s.id AND role = 'user'
       ORDER BY created_at ASC
       LIMIT 1
     ) m ON TRUE
     ${whereClause}
     ORDER BY s.last_message_at DESC
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    listArgs,
  );

  return { sessions: listResult.rows, total };
}

export interface MessageListParams {
  sessionDbId: string;  // chat_sessions.id (UUID)
  tenantId: string;     // テナント検証用
}

export interface ChatHistoryMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * セッション内の全メッセージを created_at ASC で返す。
 * tenantId が一致しない場合は空配列を返す（セキュリティ）。
 */
export async function getMessages(
  params: MessageListParams,
): Promise<ChatHistoryMessage[]> {
  const pool = getPool();

  // テナント所有権を検証
  const sessionResult = await pool.query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
    [params.sessionDbId, params.tenantId],
  );
  if (sessionResult.rows.length === 0) return [];

  const msgResult = await pool.query<ChatHistoryMessage>(
    `SELECT id, role, content, metadata, created_at
     FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [params.sessionDbId],
  );

  return msgResult.rows;
}
