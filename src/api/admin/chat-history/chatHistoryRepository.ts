// src/api/admin/chat-history/chatHistoryRepository.ts
// Phase38: 会話履歴DB永続化リポジトリ（Step1: 保存 / Step2: 取得）

import { getPool } from "../../../lib/db";
import type { RagSource } from "../../../agent/types";

export interface SaveMessageParams {
  tenantId: string;
  sessionId: string;
  // GID 1216275508391900: "operator" = 有人オペレーターによる返信
  role: "user" | "assistant" | "operator";
  content: string;
  metadata?: Record<string, unknown>;
  /** Phase46: A/Bテスト variant記録 */
  promptVariantId?: string | null;
  promptVariantName?: string | null;
  /**
   * Phase68: 応答生成に使用された RAG チャンク（assistant メッセージのみ）。
   * chat_messages.rag_sources JSONB カラムに配列として保存される。
   * 既存テスト互換のため optional。
   */
  ragSources?: RagSource[];
}

/**
 * ユーザー/アシスタントのメッセージをDBに永続化する。
 * chat_sessions を upsert し、chat_messages に INSERT する。
 * 呼び出し元は fire-and-forget (.catch のみ) で使うこと。
 */
export async function saveMessage(params: SaveMessageParams): Promise<void> {
  const pool = getPool();

  // 1. chat_sessions を upsert（Phase46: variant情報も記録）
  await pool.query(
    `INSERT INTO chat_sessions (tenant_id, session_id, last_message_at, message_count, prompt_variant_id, prompt_variant_name)
     VALUES ($1, $2, NOW(), 1, $3, $4)
     ON CONFLICT (tenant_id, session_id) DO UPDATE SET
       last_message_at = NOW(),
       message_count = chat_sessions.message_count + 1,
       prompt_variant_id = COALESCE(chat_sessions.prompt_variant_id, EXCLUDED.prompt_variant_id),
       prompt_variant_name = COALESCE(chat_sessions.prompt_variant_name, EXCLUDED.prompt_variant_name)`,
    [params.tenantId, params.sessionId, params.promptVariantId ?? null, params.promptVariantName ?? null],
  );

  // 2. chat_sessions の UUID を取得
  const sessionResult = await pool.query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  const dbSessionId = sessionResult.rows[0]?.id;
  if (!dbSessionId) return;

  // 3. メッセージを保存 (Phase68: rag_sources を assistant メッセージのみ記録)
  const ragSourcesJson =
    params.ragSources && params.ragSources.length > 0
      ? JSON.stringify(params.ragSources)
      : null;
  await pool.query(
    `INSERT INTO chat_messages (session_id, tenant_id, role, content, metadata, rag_sources)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      dbSessionId,
      params.tenantId,
      params.role,
      params.content,
      JSON.stringify(params.metadata ?? {}),
      ragSourcesJson,
    ],
  );
}

// ---------------------------------------------------------------------------
// Step2: 取得クエリ
// ---------------------------------------------------------------------------

export interface SessionListParams {
  tenantId?: string;  // 指定なし = 全テナント（super_admin 用）
  limit?: number;     // デフォルト 20
  offset?: number;    // デフォルト 0
  // Phase52b: sort/filter
  sort_by?: 'last_message_at' | 'message_count' | 'score';
  sort_order?: 'asc' | 'desc';
  period?: '7' | '30' | '90' | 'all';
  search?: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
}

export interface SessionSummary {
  id: string;               // DB 内部 UUID
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  first_message_preview: string;  // 最初のユーザーメッセージ先頭 50 文字
  // Phase52f: コンバージョン記録
  outcome: string | null;
  outcome_recorded_at: string | null;
}

/**
 * セッション一覧を取得する。
 * Phase52b: sort/filter/search/sentiment に対応。
 */
export async function getSessions(
  params: SessionListParams,
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(params.limit ?? 20, 200);
  const offset = params.offset ?? 0;
  const sortOrder = (params.sort_order ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
  const sortBy = params.sort_by ?? 'last_message_at';

  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.tenantId) {
    args.push(params.tenantId);
    conditions.push(`s.tenant_id = $${args.length}`);
  }

  if (params.period && params.period !== 'all') {
    conditions.push(`s.started_at >= NOW() - INTERVAL '${params.period} days'`);
  }

  if (params.search?.trim()) {
    args.push(`%${params.search.trim()}%`);
    conditions.push(`EXISTS (SELECT 1 FROM chat_messages WHERE session_id = s.id AND role = 'user' AND content ILIKE $${args.length})`);
  }

  if (params.sentiment === 'positive') {
    conditions.push(`EXISTS (SELECT 1 FROM conversation_evaluations WHERE session_id = s.session_id AND score >= 70)`);
  } else if (params.sentiment === 'negative') {
    conditions.push(`EXISTS (SELECT 1 FROM conversation_evaluations WHERE session_id = s.session_id AND score > 0 AND score < 60)`);
  } else if (params.sentiment === 'neutral') {
    conditions.push(`EXISTS (SELECT 1 FROM conversation_evaluations WHERE session_id = s.session_id AND score >= 60 AND score < 70)`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const orderByClause = (() => {
    if (sortBy === 'score') {
      return `(SELECT score FROM conversation_evaluations WHERE session_id = s.session_id AND score > 0 ORDER BY evaluated_at DESC LIMIT 1) ${sortOrder} NULLS LAST`;
    }
    if (sortBy === 'message_count') return `s.message_count ${sortOrder}`;
    return `s.last_message_at ${sortOrder}`;
  })();

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM chat_sessions s ${whereClause}`,
    args,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const listArgs = [...args, limit, offset];
  const limitPlaceholder = `$${args.length + 1}`;
  const offsetPlaceholder = `$${args.length + 2}`;

  const listResult = await pool.query<SessionSummary>(
    `SELECT
       s.id,
       s.tenant_id,
       s.session_id,
       s.started_at,
       s.last_message_at,
       s.message_count,
       s.outcome,
       s.outcome_recorded_at,
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
     ORDER BY ${orderByClause}
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    listArgs,
  );

  return { sessions: listResult.rows, total };
}

export interface MessageListParams {
  sessionDbId: string;       // chat_sessions.id (UUID)
  tenantId?: string;         // テナント検証用 (undefined = super_admin 無制限)
}

export interface ChatHistoryMessage {
  id: number;
  role: "user" | "assistant" | "operator";
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

  // テナント所有権を検証 (tenantId が undefined = super_admin → tenant チェック省略)
  let verifiedSessionId: string;
  if (params.tenantId) {
    const sessionResult = await pool.query<{ id: string }>(
      `SELECT id FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
      [params.sessionDbId, params.tenantId],
    );
    if (sessionResult.rows.length === 0) return [];
    verifiedSessionId = sessionResult.rows[0].id;
  } else {
    const sessionResult = await pool.query<{ id: string }>(
      `SELECT id FROM chat_sessions WHERE id = $1`,
      [params.sessionDbId],
    );
    if (sessionResult.rows.length === 0) return [];
    verifiedSessionId = sessionResult.rows[0].id;
  }

  const msgResult = await pool.query<ChatHistoryMessage>(
    `SELECT id, role, content, metadata, created_at
     FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [verifiedSessionId],
  );

  return msgResult.rows;
}

// ---------------------------------------------------------------------------
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション
// ---------------------------------------------------------------------------

export interface EscalatedSessionSummary {
  id: string;              // chat_sessions.id (UUID)
  tenant_id: string;
  session_id: string;
  escalated_at: string;
  last_message_at: string;
  message_count: number;
  first_message_preview: string;
}

/** 対応中（未解決）のエスカレーション一覧を取得する。tenantId未指定 = 全テナント（super_admin用）。 */
export async function getActiveEscalations(
  tenantId?: string,
): Promise<EscalatedSessionSummary[]> {
  const pool = getPool();
  const conditions = ["s.is_escalated = true", "s.escalation_resolved_at IS NULL"];
  const args: unknown[] = [];
  if (tenantId) {
    args.push(tenantId);
    conditions.push(`s.tenant_id = $${args.length}`);
  }
  const result = await pool.query<EscalatedSessionSummary>(
    `SELECT
       s.id, s.tenant_id, s.session_id, s.escalated_at, s.last_message_at, s.message_count,
       COALESCE(LEFT(m.content, 80), '') AS first_message_preview
     FROM chat_sessions s
     LEFT JOIN LATERAL (
       SELECT content FROM chat_messages
       WHERE session_id = s.id AND role = 'user'
       ORDER BY created_at DESC LIMIT 1
     ) m ON TRUE
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.escalated_at DESC`,
    args,
  );
  return result.rows;
}

/**
 * セッションをエスカレーション状態にする（存在しなければ chat_sessions を作成）。
 * 既にエスカレーション済みの場合は escalated_at を上書きしない（冪等）。
 */
export async function escalateSession(params: {
  tenantId: string;
  sessionId: string;
}): Promise<{ dbSessionId: string; alreadyEscalated: boolean }> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO chat_sessions (tenant_id, session_id, last_message_at, message_count)
     VALUES ($1, $2, NOW(), 0)
     ON CONFLICT (tenant_id, session_id) DO NOTHING`,
    [params.tenantId, params.sessionId],
  );
  const before = await pool.query<{ id: string; is_escalated: boolean }>(
    `SELECT id, is_escalated FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  const row = before.rows[0];
  const alreadyEscalated = !!row?.is_escalated;
  await pool.query(
    `UPDATE chat_sessions
     SET is_escalated = true,
         escalated_at = COALESCE(escalated_at, NOW()),
         escalation_resolved_at = NULL
     WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  return { dbSessionId: row!.id, alreadyEscalated };
}

/** エスカレーション対応完了をマークする。tenantIdが一致しない場合はfalseを返す。 */
export async function resolveEscalation(params: {
  sessionDbId: string;
  tenantId?: string; // undefined = super_admin（テナント検証省略）
}): Promise<boolean> {
  const pool = getPool();
  const args: unknown[] = [params.sessionDbId];
  let where = "id = $1";
  if (params.tenantId) {
    args.push(params.tenantId);
    where += ` AND tenant_id = $${args.length}`;
  }
  const result = await pool.query(
    `UPDATE chat_sessions SET escalation_resolved_at = NOW() WHERE ${where} RETURNING id`,
    args,
  );
  return (result.rowCount ?? 0) > 0;
}

/** 指定タイムスタンプ以降に投稿された operator ロールのメッセージを返す（ウィジェットのポーリング用）。 */
export async function getNewOperatorMessages(params: {
  tenantId: string;
  sessionId: string;
  since?: string;
}): Promise<ChatHistoryMessage[]> {
  const pool = getPool();
  const sessionResult = await pool.query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  const dbSessionId = sessionResult.rows[0]?.id;
  if (!dbSessionId) return [];

  const args: unknown[] = [dbSessionId];
  let sinceClause = "";
  if (params.since) {
    args.push(params.since);
    sinceClause = ` AND created_at > $${args.length}`;
  }
  const result = await pool.query<ChatHistoryMessage>(
    `SELECT id, role, content, metadata, created_at
     FROM chat_messages
     WHERE session_id = $1 AND role = 'operator'${sinceClause}
     ORDER BY created_at ASC`,
    args,
  );
  return result.rows;
}
