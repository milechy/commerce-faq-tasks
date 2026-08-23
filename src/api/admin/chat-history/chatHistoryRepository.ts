// src/api/admin/chat-history/chatHistoryRepository.ts
// Phase38: 会話履歴DB永続化リポジトリ（Step1: 保存 / Step2: 取得）

import { getPool } from "../../../lib/db";
import type { RagSource } from "../../../agent/types";
import type { TrafficSource } from "../../../lib/traffic/trafficSource";
import { createNotification } from "../../../lib/notifications";

// GID 1216970103691946 (PR-6): outcome_recorded_by にこの接頭辞が入っている行は
// 自動記録(events→conversion→outcomeブリッジ)であることを示す。人手記録(email文字列)
// と語彙的に衝突しない。recordOutcome はこれを見て通知を抑止する。
export const AUTO_OUTCOME_RECORDED_BY = "system:cv_bridge";
function isAutomatedRecordedBy(recordedBy: string | null): boolean {
  return recordedBy === AUTO_OUTCOME_RECORDED_BY;
}

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
  /**
   * GID 1216970103691946: セッション作成経路の判定結果(実ユーザー/E2E/chat-test/デモ)。
   * chat_sessions.metadata.source に「セッション新規作成時のみ」記録する(2回目以降の
   * メッセージでは既存値を保持し、上書きしない)。省略時は 'user' 扱い(既存呼び出し元との
   * 後方互換のため。呼び出し元がトラフィック種別を判定できない場合の安全側デフォルト)。
   */
  trafficSource?: TrafficSource;
  /**
   * G6: widget EventTracker が生成する visitor_id(localStorage 'r2c_vid')。
   * chat_sessions.visitor_id に「セッション新規作成時のみ」記録する(trafficSource と
   * 同じ理由。2回目以降のメッセージでは既存値を保持する)。テナントを跨いで衝突しうる
   * ため、単独ではキーにせず必ず (tenant_id, visitor_id) の複合で扱うこと。
   */
  visitorId?: string;
}

/**
 * ユーザー/アシスタントのメッセージをDBに永続化する。
 * chat_sessions を upsert し、chat_messages に INSERT する。
 * 呼び出し元は fire-and-forget (.catch のみ) で使うこと。
 */
export async function saveMessage(params: SaveMessageParams): Promise<void> {
  const pool = getPool();

  // 1. chat_sessions を upsert（Phase46: variant情報も記録 / GID 1216970103691946: source記録）
  // metadata.source はセッション新規作成時(INSERT)にのみ確定させ、2回目以降のUPDATEでは
  // 既存値を保持する(CASE ... WHEN metadata ? 'source' THEN 既存値 ELSE 新規値)。
  // これにより「最初にどの経路でセッションが作られたか」がぶれずに残る。
  const initialMetadata = JSON.stringify({ source: params.trafficSource ?? "user" });
  await pool.query(
    `INSERT INTO chat_sessions (tenant_id, session_id, last_message_at, message_count, prompt_variant_id, prompt_variant_name, metadata, visitor_id)
     VALUES ($1, $2, NOW(), 1, $3, $4, $5::jsonb, $6)
     ON CONFLICT (tenant_id, session_id) DO UPDATE SET
       last_message_at = NOW(),
       message_count = chat_sessions.message_count + 1,
       prompt_variant_id = COALESCE(chat_sessions.prompt_variant_id, EXCLUDED.prompt_variant_id),
       prompt_variant_name = COALESCE(chat_sessions.prompt_variant_name, EXCLUDED.prompt_variant_name),
       visitor_id = COALESCE(chat_sessions.visitor_id, EXCLUDED.visitor_id),
       metadata = CASE
         WHEN chat_sessions.metadata ? 'source' THEN chat_sessions.metadata
         ELSE COALESCE(chat_sessions.metadata, '{}'::jsonb) || EXCLUDED.metadata
       END`,
    [params.tenantId, params.sessionId, params.promptVariantId ?? null, params.promptVariantName ?? null, initialMetadata, params.visitorId ?? null],
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
  // GID 1216970103691946: e2e/chat-test/実ユーザーを画面上で見分けるため
  source: string | null;
}

const VALID_SORT_BY = ['last_message_at', 'message_count', 'score'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;
const VALID_PERIOD = ['7', '30', '90', 'all'] as const;
const VALID_SENTIMENT = ['positive', 'negative', 'neutral'] as const;

function pickAllowlisted<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function coerceInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface NormalizedSessionListParams {
  limit: number;
  offset: number;
  sort_by: SessionListParams['sort_by'];
  sort_order: SessionListParams['sort_order'];
  period: SessionListParams['period'];
  sentiment: SessionListParams['sentiment'];
}

/**
 * getSessions() が SQL へ文字列補間する period / sort_order 等を、呼び出し元に依存せず
 * allowlist で検証する。呼び出し元は routes.ts の他に agent の LLM 由来引数
 * (actionExecutor.ts) が増えるため、検証をここへ集約する。allowlist 外は例外にせず
 * undefined にフォールバックする(routes.ts の既存挙動を維持するため)。
 *
 * 冪等なので複数箇所(routes.ts / getSessions() 内部)から呼んでよい。
 * search のワイルドカードエスケープだけは非冪等(二重エスケープになる)なため、
 * ここでは扱わず getSessions() 内で SQL 構築の直前に1回だけ適用する。
 */
export function normalizeSessionListParams(raw: {
  limit?: unknown;
  offset?: unknown;
  sort_by?: unknown;
  sort_order?: unknown;
  period?: unknown;
  sentiment?: unknown;
}): NormalizedSessionListParams {
  return {
    limit: Math.max(1, Math.min(coerceInt(raw.limit, 20), 200)),
    offset: Math.max(0, coerceInt(raw.offset, 0)),
    sort_by: pickAllowlisted(raw.sort_by, VALID_SORT_BY),
    sort_order: pickAllowlisted(raw.sort_order, VALID_SORT_ORDER),
    period: pickAllowlisted(raw.period, VALID_PERIOD),
    sentiment: pickAllowlisted(raw.sentiment, VALID_SENTIMENT),
  };
}

// LIKE のワイルドカードを無効化し、意図しない広域一致を防ぐ（Postgres の既定エスケープ文字は \）。
// resolveSessionByShortId (actionExecutor.ts) と同じ規約。非冪等なため呼び出しは1箇所に限る。
function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * セッション一覧を取得する。
 * Phase52b: sort/filter/search/sentiment に対応。
 *
 * 引数は呼び出し元(routes.ts の allowlist 済みの値、または agent 経由の未検証の値)を
 * 問わず、ここで必ず allowlist を再適用する。period と sort_order は下の SQL に
 * 文字列補間されるため、検証を経ない値がここに到達することを絶対に防ぐ。
 */
export async function getSessions(
  params: SessionListParams,
): Promise<{ sessions: SessionSummary[]; total: number; limit: number; offset: number }> {
  const pool = getPool();
  const normalized = normalizeSessionListParams(params);
  const limit = normalized.limit;
  const offset = normalized.offset;
  const sortOrder = (normalized.sort_order ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
  const sortBy = normalized.sort_by ?? 'last_message_at';
  const period = normalized.period;
  const sentiment = normalized.sentiment;

  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.tenantId) {
    args.push(params.tenantId);
    conditions.push(`s.tenant_id = $${args.length}`);
  }

  if (period && period !== 'all') {
    conditions.push(`s.started_at >= NOW() - INTERVAL '${period} days'`);
  }

  if (params.search?.trim()) {
    args.push(`%${escapeLikeWildcards(params.search.trim())}%`);
    conditions.push(`EXISTS (SELECT 1 FROM chat_messages WHERE session_id = s.id AND role = 'user' AND content ILIKE $${args.length})`);
  }

  if (sentiment === 'positive') {
    conditions.push(`EXISTS (SELECT 1 FROM conversation_evaluations WHERE session_id = s.session_id AND score >= 70)`);
  } else if (sentiment === 'negative') {
    conditions.push(`EXISTS (SELECT 1 FROM conversation_evaluations WHERE session_id = s.session_id AND score > 0 AND score < 60)`);
  } else if (sentiment === 'neutral') {
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
       s.metadata->>'source' AS source,
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

  // limit/offset は正規化後の実効値を返す。呼び出し元(routes.ts)がページング応答に
  // 使う値を、渡した引数から独自に再計算せずここから読めるようにするため。
  return { sessions: listResult.rows, total, limit, offset };
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
 * セッションが存在しない（またはtenantIdが一致しない = 越境）場合は null を返す。
 * セッションは存在するが本文が0件の場合は [] を返す。
 * 呼び出し元はこの2つを区別すること（CLAUDE.md 20: 「存在しない」と「空」を同じ値で表現しない）。
 * 越境は必ず null 側に倒す — [] を返すとそのIDのセッションが実在することが漏れる。
 */
export async function getMessages(
  params: MessageListParams,
): Promise<ChatHistoryMessage[] | null> {
  const pool = getPool();

  // テナント所有権を検証 (tenantId が undefined = super_admin → tenant チェック省略)
  let verifiedSessionId: string;
  if (params.tenantId) {
    const sessionResult = await pool.query<{ id: string }>(
      `SELECT id FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
      [params.sessionDbId, params.tenantId],
    );
    if (sessionResult.rows.length === 0) return null;
    verifiedSessionId = sessionResult.rows[0].id;
  } else {
    const sessionResult = await pool.query<{ id: string }>(
      `SELECT id FROM chat_sessions WHERE id = $1`,
      [params.sessionDbId],
    );
    if (sessionResult.rows.length === 0) return null;
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
/**
 * 対応中（未解決）のエスカレーション一覧を返す。
 *
 * limit を渡すと件数を絞る。total は常に「絞る前の実件数」なので、
 * 呼び出し元は「全N件中M件」を正しく表示できる（絞った件数を全件数として
 * 見せてしまう事故を防ぐ）。getSessions() と同じ形に揃えてある。
 * limit 未指定なら従来どおり全件返す。
 */
export async function getActiveEscalations(
  tenantId?: string,
  limit?: number,
): Promise<{ escalations: EscalatedSessionSummary[]; total: number }> {
  const pool = getPool();
  const conditions = ["s.is_escalated = true", "s.escalation_resolved_at IS NULL"];
  const args: unknown[] = [];
  if (tenantId) {
    args.push(tenantId);
    conditions.push(`s.tenant_id = $${args.length}`);
  }
  const whereClause = conditions.join(" AND ");

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM chat_sessions s WHERE ${whereClause}`,
    args,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const listArgs = [...args];
  let limitClause = "";
  if (limit !== undefined) {
    listArgs.push(limit);
    limitClause = ` LIMIT $${listArgs.length}`;
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
     WHERE ${whereClause}
     ORDER BY s.escalated_at DESC${limitClause}`,
    listArgs,
  );
  return { escalations: result.rows, total };
}

/**
 * セッションをエスカレーション状態にする。
 * 既にエスカレーション済みの場合は escalated_at を上書きしない（冪等）。
 *
 * R0-②: 対象セッションが存在しない場合は null を返し、行を新規作成しない。
 * 以前は ON CONFLICT DO NOTHING で無条件に chat_sessions を作成しており、
 * メッセージを一度も送っていない訪問者がボタンを押しただけで
 * message_count=0・metadata未設定の空セッションが量産されていた
 * (本番実測: 未解決エスカレーション320件、全て message_count=0)。
 */
export async function escalateSession(params: {
  tenantId: string;
  sessionId: string;
}): Promise<{ dbSessionId: string; alreadyEscalated: boolean } | null> {
  const pool = getPool();
  const before = await pool.query<{ id: string; is_escalated: boolean }>(
    `SELECT id, is_escalated FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  const row = before.rows[0];
  if (!row) return null;
  const alreadyEscalated = row.is_escalated;
  await pool.query(
    `UPDATE chat_sessions
     SET is_escalated = true,
         escalated_at = COALESCE(escalated_at, NOW()),
         escalation_resolved_at = NULL
     WHERE tenant_id = $1 AND session_id = $2`,
    [params.tenantId, params.sessionId],
  );
  return { dbSessionId: row.id, alreadyEscalated };
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

// ---------------------------------------------------------------------------
// Phase52f: コンバージョン結果(outcome)。routes.ts の PATCH ハンドラと
// agent の record_session_outcome ツールの両方から呼ばれるため、検証・更新・
// 通知の3点セットをここへ集約する(両呼び出し元で片方だけ通知が飛ばない、
// といった劣化を防ぐ)。
// ---------------------------------------------------------------------------

/** テナントの有効な outcome 値一覧。未設定テナントの既定値を単一の情報源にする。 */
export async function getConversionTypes(tenantId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ conversion_types: string[] | null }>(
    `SELECT conversion_types FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0]?.conversion_types ?? ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"];
}

export interface RecordOutcomeParams {
  sessionDbId: string;  // chat_sessions.id (UUID)
  tenantId: string;
  outcome: string;
  recordedBy: string | null;
}

export interface RecordedOutcome {
  outcome: string;
  recordedAt: string;
  recordedBy: string | null;
}

/**
 * outcome を記録し、outcome_recorded 通知を発火する(fire-and-forget)。
 * 呼び出し元は conversion_types との照合を事前に済ませておくこと(この関数自身は検証しない)。
 */
/**
 * セッションのoutcomeを記録する。sessionDbId が存在しない、または tenantId が
 * 一致しない(越境)場合は null を返す(CLAUDE.md 禁止20: 「無い」と「空」を
 * 同じ値で表現しない。以前は rowCount を見ておらず、この場合も無音で成功扱いだった)。
 * recordedBy が AUTO_OUTCOME_RECORDED_BY(自動記録)のときは通知を出さない
 * (CV発生の度に通知が大量発生するのを防ぐ)。
 */
export async function recordOutcome(params: RecordOutcomeParams): Promise<RecordedOutcome | null> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE chat_sessions
     SET outcome = $1, outcome_recorded_at = NOW(), outcome_recorded_by = $2
     WHERE id = $3 AND tenant_id = $4
     RETURNING id`,
    [params.outcome, params.recordedBy, params.sessionDbId, params.tenantId],
  );
  if (result.rows.length === 0) return null;

  if (!isAutomatedRecordedBy(params.recordedBy)) {
    // Phase52h: Trigger 5 — outcome記録通知(人手記録のみ)
    void createNotification({
      recipientRole: 'super_admin',
      type: 'outcome_recorded',
      title: 'コンバージョン結果が記録されました',
      message: `「${params.outcome}」が記録されました`,
      link: '/admin/analytics',
      metadata: { sessionId: params.sessionDbId, outcome: params.outcome, tenantId: params.tenantId },
    });
  }

  return { outcome: params.outcome, recordedAt: new Date().toISOString(), recordedBy: params.recordedBy };
}

export interface SessionOutcome {
  outcome: string | null;
  outcomeRecordedAt: string | null;
  outcomeRecordedBy: string | null;
}

/** 指定セッションの記録済みoutcomeを取得する。存在しなければ null。 */
export async function getSessionOutcome(sessionDbId: string): Promise<SessionOutcome | null> {
  const pool = getPool();
  const result = await pool.query<{ outcome: string | null; outcome_recorded_at: string | null; outcome_recorded_by: string | null }>(
    `SELECT outcome, outcome_recorded_at, outcome_recorded_by FROM chat_sessions WHERE id = $1`,
    [sessionDbId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { outcome: row.outcome, outcomeRecordedAt: row.outcome_recorded_at, outcomeRecordedBy: row.outcome_recorded_by };
}
