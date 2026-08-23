// src/api/hermes-mcp/hermesMcpRepository.ts
// Phase75: Hermes Agent(CVR学習エージェント)向けMCPデータアクセス層
//
// 重要: ここで返すデータは同意済みテナントのみを対象にすること。
// 同意チェック自体はこのファイルでは行わない(呼び出し側 routes.ts の責務)。
// このファイルは「同意済みと確認された tenantId」を渡された前提で動く。
//
// GID 1216978660043409 (PR-17, R8): セッション単位でグループ化して返す
// (旧実装は newest-first LIMIT 200 のフラットなメッセージ列で、会話が途中で
// 切れていた)。第2の取得経路を作らないため、この searchConversations の
// 返却拡張のみで完結させる(新規MCPツールは増やさない)。

import { getPool } from "../../lib/db";
import { userSourceClause } from "../admin/analytics/summaryQueries";
import { redactEmails } from "../../lib/security/piiPatterns";

export interface HermesConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  ragHitCount: number | null;
  ragTopScore: number | null;
  knowledgeGap: boolean | null;
}

export interface HermesPageContextEvent {
  eventType: string;
  pageUrl: string | null;
  referrer: string | null;
  createdAt: string;
}

export interface HermesEvaluation {
  score: number;
  axes: Record<string, unknown> | null;
  usedPrinciples: string[];
  failedPrinciples: string[];
  notes: string | null;
}

export interface HermesConversationSession {
  sessionId: string; // chat_sessions.session_id (アプリ側の文字列ID)
  outcome: string | null;
  isEscalated: boolean;
  promptVariantId: string | null;
  promptVariantName: string | null;
  converted: boolean;
  evaluation: HermesEvaluation | null;
  messages: HermesConversationMessage[];
  // R12: 会話に至るまでのページ行動(page_view/chat_open等)。visitor_id が
  // 未設定(event_tracking機能フラグoff等)のセッションは空配列。
  pageContext: HermesPageContextEvent[];
}

export interface SearchConversationsParams {
  tenantId: string;
  query?: string;
  minJudgeScore?: number;
  convertedOnly?: boolean;
  limit?: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// R12: ページ行動をセッションに結合する際の遡り窓。チャットを開く前の閲覧行動
// (page_view等)を拾うための猶予で、visitor_idの生涯履歴全体には広げない
// (behavioral_events にトラフィックソース列が無く、E2E由来イベントが
// 無関係に再流入しうるため。窓をセッションの実際の会話時間帯に絞ることで
// 実質的に同じ効果を得る)。
const PAGE_CONTEXT_LOOKBACK_HOURS = 6;

/**
 * page_url / referrer からクエリ文字列を落として正規化する(Anti-Slop)。
 * クエリ文字列には会員ID・メールアドレス・検索語等の個人情報が載りうる。
 *
 * パス部分にもメールアドレス(/users/tanaka@example.com/orders 等のURL設計)が
 * 埋め込まれうるため、メール形状の部分文字列のみ伏字化する。電話番号・郵便番号の
 * パターンは適用しない — URLパスには商品ID・注文ID等の数字-数字形式が頻出し、
 * 誤って伏字化するとHermesの分析に必要な識別子が潰れる(outputGuard.tsのPII_PATTERNSは
 * LLM応答の自然文向けで、URLパスとは前提が異なるため流用しない)。
 * これでも「メールを含まないパス埋め込みPII」(例: /users/12345/のような社内ID)は
 * 検出できない。テナントのURL設計に依存するリスクとして残る。
 */
function normalizeUrl(url: string | null): string | null {
  if (!url) return null;
  const qIndex = url.indexOf("?");
  const withoutQuery = qIndex >= 0 ? url.slice(0, qIndex) : url;
  const hIndex = withoutQuery.indexOf("#");
  const withoutFragment = hIndex >= 0 ? withoutQuery.slice(0, hIndex) : withoutQuery;
  return redactEmails(withoutFragment);
}

interface SessionCandidateRow {
  internal_id: string;
  session_id: string;
  visitor_id: string | null;
  outcome: string | null;
  is_escalated: boolean;
  prompt_variant_id: string | null;
  prompt_variant_name: string | null;
  converted: boolean;
  first_message_at: string;
  last_message_at: string;
}

async function fetchSessionCandidates(
  db: ReturnType<typeof getPool>,
  params: SearchConversationsParams,
): Promise<SessionCandidateRow[]> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // 学習データ汚染防止: Hermesにはe2e/chat-test由来のセッションを一切渡さない
  // (userSourceClauseは"AND ..."形式を返すため、conditions配列の要素としてはAND抜きで積む)
  const conditions: string[] = [
    `s.tenant_id = $1`,
    userSourceClause("s").replace(/^AND /, ""),
  ];
  const args: unknown[] = [params.tenantId];

  if (params.query?.trim()) {
    args.push(`%${params.query.trim()}%`);
    conditions.push(
      `EXISTS (SELECT 1 FROM chat_messages m2 WHERE m2.session_id = s.id AND m2.content ILIKE $${args.length})`,
    );
  }

  if (params.minJudgeScore !== undefined) {
    args.push(params.minJudgeScore);
    conditions.push(
      `EXISTS (SELECT 1 FROM conversation_evaluations ce WHERE ce.session_id = s.session_id AND ce.score >= $${args.length})`,
    );
  }

  if (params.convertedOnly) {
    conditions.push(
      `EXISTS (SELECT 1 FROM conversion_attributions ca WHERE ca.session_id = s.id)`,
    );
  }

  args.push(limit);
  const limitPlaceholder = `$${args.length}`;

  const result = await db.query<SessionCandidateRow>(
    `SELECT
       s.id AS internal_id,
       s.session_id,
       s.visitor_id,
       s.outcome,
       s.is_escalated,
       s.prompt_variant_id,
       s.prompt_variant_name,
       EXISTS (SELECT 1 FROM conversion_attributions ca WHERE ca.session_id = s.id) AS converted,
       MIN(m.created_at) AS first_message_at,
       MAX(m.created_at) AS last_message_at
     FROM chat_sessions s
     JOIN chat_messages m ON m.session_id = s.id
     WHERE ${conditions.join(" AND ")}
     GROUP BY s.id
     ORDER BY MAX(m.created_at) DESC
     LIMIT ${limitPlaceholder}`,
    args,
  );

  return result.rows;
}

interface MessageRow {
  internal_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

async function fetchMessagesBySessionIds(
  db: ReturnType<typeof getPool>,
  internalIds: string[],
): Promise<Map<string, HermesConversationMessage[]>> {
  const byInternalId = new Map<string, HermesConversationMessage[]>();
  if (internalIds.length === 0) return byInternalId;

  const result = await db.query<MessageRow>(
    `SELECT session_id AS internal_id, role, content, created_at, metadata
       FROM chat_messages
      WHERE session_id = ANY($1::uuid[])
      ORDER BY created_at ASC`,
    [internalIds],
  );

  for (const row of result.rows) {
    const list = byInternalId.get(row.internal_id) ?? [];
    const meta = row.metadata ?? {};
    list.push({
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ragHitCount: typeof meta["rag_hit_count"] === "number" ? (meta["rag_hit_count"] as number) : null,
      ragTopScore: typeof meta["rag_top_score"] === "number" ? (meta["rag_top_score"] as number) : null,
      knowledgeGap: typeof meta["knowledge_gap"] === "boolean" ? (meta["knowledge_gap"] as boolean) : null,
    });
    byInternalId.set(row.internal_id, list);
  }

  return byInternalId;
}

interface EvaluationRow {
  session_id: string; // TEXT、chat_sessions.session_id と一致
  score: number;
  evaluation_axes: Record<string, unknown> | null;
  used_principles: string[] | null;
  failed_principles: string[] | null;
  notes: string | null;
}

async function fetchEvaluationsBySessionIds(
  db: ReturnType<typeof getPool>,
  tenantId: string,
  sessionIds: string[],
): Promise<Map<string, HermesEvaluation>> {
  const bySessionId = new Map<string, HermesEvaluation>();
  if (sessionIds.length === 0) return bySessionId;

  // conversation_evaluations は UNIQUE(tenant_id, session_id) のため
  // (tenant_id, session_id) の組に対し高々1行(uniq_conv_eval_session)。
  const result = await db.query<EvaluationRow>(
    `SELECT session_id, score, evaluation_axes, used_principles, failed_principles, notes
       FROM conversation_evaluations
      WHERE tenant_id = $1 AND session_id = ANY($2::text[])`,
    [tenantId, sessionIds],
  );

  for (const row of result.rows) {
    bySessionId.set(row.session_id, {
      score: row.score,
      axes: row.evaluation_axes ?? null,
      usedPrinciples: row.used_principles ?? [],
      failedPrinciples: row.failed_principles ?? [],
      notes: row.notes ?? null,
    });
  }

  return bySessionId;
}

interface PageContextRow {
  session_id: string;
  event_type: string;
  page_url: string | null;
  referrer: string | null;
  created_at: string;
}

async function fetchPageContextBySessionIds(
  db: ReturnType<typeof getPool>,
  tenantId: string,
  sessions: SessionCandidateRow[],
): Promise<Map<string, HermesPageContextEvent[]>> {
  const bySessionId = new Map<string, HermesPageContextEvent[]>();

  // visitor_id 未設定のセッション(event_tracking機能フラグoff等)は結合対象外。
  const withVisitor = sessions.filter((s) => s.visitor_id);
  if (withVisitor.length === 0) return bySessionId;

  const result = await db.query<PageContextRow>(
    `WITH session_bounds AS (
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[]
       ) AS t(session_id, visitor_id, window_start, window_end)
     )
     SELECT sb.session_id, be.event_type, be.page_url, be.referrer, be.created_at
       FROM session_bounds sb
       JOIN behavioral_events be
         ON be.tenant_id = $5
        AND be.visitor_id = sb.visitor_id
        AND be.created_at BETWEEN sb.window_start AND sb.window_end
      ORDER BY be.created_at ASC`,
    [
      withVisitor.map((s) => s.session_id),
      withVisitor.map((s) => s.visitor_id as string),
      withVisitor.map(
        (s) => new Date(new Date(s.first_message_at).getTime() - PAGE_CONTEXT_LOOKBACK_HOURS * 3600_000).toISOString(),
      ),
      withVisitor.map((s) => s.last_message_at),
      tenantId,
    ],
  );

  for (const row of result.rows) {
    const list = bySessionId.get(row.session_id) ?? [];
    list.push({
      eventType: row.event_type,
      pageUrl: normalizeUrl(row.page_url),
      referrer: normalizeUrl(row.referrer),
      createdAt: row.created_at,
    });
    bySessionId.set(row.session_id, list);
  }

  return bySessionId;
}

/**
 * 同意済みテナントの会話をセッション単位で検索する。
 * - minJudgeScore: conversation_evaluations.score(TEXTのsession_idで結合) >= 指定値のセッションのみ
 * - convertedOnly: conversion_attributions(UUIDのsession_idで結合)に紐づくセッションのみ
 * - query: いずれかのメッセージが content の ILIKE 部分一致に該当するセッション
 *   (該当メッセージだけでなく、そのセッションの全メッセージを返す。会話が途中で切れないため)
 */
export async function searchConversations(
  params: SearchConversationsParams,
): Promise<HermesConversationSession[]> {
  const db = getPool();

  const sessions = await fetchSessionCandidates(db, params);
  if (sessions.length === 0) return [];

  const [messagesByInternalId, evaluationsBySessionId, pageContextBySessionId] = await Promise.all([
    fetchMessagesBySessionIds(db, sessions.map((s) => s.internal_id)),
    fetchEvaluationsBySessionIds(db, params.tenantId, sessions.map((s) => s.session_id)),
    fetchPageContextBySessionIds(db, params.tenantId, sessions),
  ]);

  return sessions.map((s) => ({
    sessionId: s.session_id,
    outcome: s.outcome,
    isEscalated: s.is_escalated,
    promptVariantId: s.prompt_variant_id,
    promptVariantName: s.prompt_variant_name,
    converted: s.converted,
    evaluation: evaluationsBySessionId.get(s.session_id) ?? null,
    messages: messagesByInternalId.get(s.internal_id) ?? [],
    pageContext: pageContextBySessionId.get(s.session_id) ?? [],
  }));
}
