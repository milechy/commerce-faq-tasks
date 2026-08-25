// src/api/admin/analytics/summaryQueries.ts

// GET /v1/admin/analytics/summary と /conversions の集計本体。
// HTTPレイヤ(routes.ts)とチャットエージェント(agent/actionExecutor.ts)の両方から
// 同じ数値を取得できるよう、認可・レスポンス整形から切り離してここに置く。

import type { Pool } from "pg";
import { AUTO_OUTCOME_RECORDED_BY } from "../chat-history/chatHistoryRepository";
import { decryptText } from "../../../lib/crypto/textEncrypt";

type Db = Pick<Pool, "query">;

// ---------------------------------------------------------------------------
// GID 1216970103691946: トラフィック汚染対策
//
// E2E/chat-test/デモ由来のセッションが chat_sessions.metadata.source に記録されるように
// なった(src/lib/traffic/trafficSource.ts, src/api/chat/route.ts)。継続率・CV率・
// Judgeスコアなど「実ユーザーの行動」を表す集計指標は source='user' のセッションのみを
// 対象にする。過去データ(metadata.source未設定)は自動的に除外される
// (`metadata->>'source' = 'user'` は NULL に対して常にfalseになるため)。
//
// chat_sessions を直接クエリする箇所は USER_SOURCE_CLAUSE(エイリアス指定)を、
// conversation_evaluations / conversion_attributions など chat_sessions を経由しない
// テーブルは USER_SOURCE_EXISTS(session_id列, tenant_id列)でEXISTS結合して絞り込む。
// ---------------------------------------------------------------------------

/** chat_sessions に直接エイリアス `alias` が張られているクエリに追加する条件。 */
export function userSourceClause(alias: string): string {
  return `AND ${alias}.metadata->>'source' = 'user'`;
}

/**
 * chat_sessions を経由しないテーブル(conversation_evaluations / conversion_attributions 等)
 * から、session_id/tenant_id 経由で実ユーザーのセッションかどうかを判定するEXISTS句。
 * conversation_evaluations.session_id は chat_sessions.session_id (TEXT) と対応し、
 * conversion_attributions.session_id は chat_sessions.id (UUID) と対応するため、
 * どちらの列と突き合わせるかを chatSessionsColumn で指定する。
 */
export function userSourceExists(
  sessionIdExpr: string,
  tenantIdExpr: string,
  chatSessionsColumn: "session_id" | "id" = "session_id",
): string {
  return `AND EXISTS (
             SELECT 1 FROM chat_sessions cs
             WHERE cs.${chatSessionsColumn} = ${sessionIdExpr}
               AND cs.tenant_id = ${tenantIdExpr}
               AND cs.metadata->>'source' = 'user'
           )`;
}

/**
 * period 文字列を SQL INTERVAL 文字列に変換する。
 * 未知の値は "30 days" にフォールバック。
 */
export function periodToInterval(period: string): string {
  switch (period) {
    case "7d":
      return "7 days";
    case "90d":
      return "90 days";
    default:
      return "30 days";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyticsSummaryResponse {
  period: string;
  tenant_id: string | null;
  total_sessions: number;
  avg_judge_score: number | null;
  total_knowledge_gaps: number;
  avg_messages_per_session: number;
  avatar_session_count: number;
  avatar_rate: number;
  prev_total_sessions: number;
  sessions_change_pct: number;
  sentiment_distribution: {
    positive: number;
    negative: number;
    neutral: number;
    total: number;
  };
  // Phase65-3: CV metrics (fixed 30-day window)
  cv_count_30d: number;
  cv_total_value_30d: number;
  cv_types_breakdown: {
    purchase: number;
    inquiry: number;
    reservation: number;
    signup: number;
    other: number;
  };
  cv_fired_status: 'fired' | 'not_fired';
  cv_days_since_first_session: number | null;
}

export interface ConversionSummaryResponse {
  summary: {
    total_sessions: number;
    recorded_outcomes: number;
    recording_rate: number;
    outcomes: Record<string, number>;
  };
  conversion_rate_trend: Array<{
    date: string;
    total: number;
    converted: number;
    rate: number;
  }>;
  technique_effectiveness: Array<{
    technique: string;
    sessions_used: number;
    converted: number;
    conversion_rate: number;
  }>;
  stage_dropout: Record<string, number>;
}

export interface SummaryQueryParams {
  db: Db;
  /** null は全テナント横断(super_admin)。 */
  tenantId: string | null;
  period: string;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export async function fetchAnalyticsSummary({
  db,
  tenantId,
  period,
}: SummaryQueryParams): Promise<AnalyticsSummaryResponse> {
  const interval = periodToInterval(period);

  // Build tenant filter clauses
  const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  const kgTenantClause = tenantId ? "AND tenant_id = $2" : "";
  const params: (string | number)[] = [`${interval}`];
  if (tenantId) params.push(tenantId);

  // Current period: sessions
  const sessionsResult = await db.query(
    `SELECT COUNT(*) AS total_sessions
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval
     ${tenantClause}
     ${userSourceClause("s")}`,
    params,
  );

  // Previous period: sessions
  const prevParams: (string | number)[] = [`${interval}`];
  if (tenantId) prevParams.push(tenantId);
  const prevTenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  const prevSessionsResult = await db.query(
    `SELECT COUNT(*) AS prev_total_sessions
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - 2 * ($1::interval)
       AND s.started_at < NOW() - $1::interval
     ${prevTenantClause}
     ${userSourceClause("s")}`,
    prevParams,
  );

  // Avg judge score (GID 1216970103691946: chat_sessions.metadata.source='user' のみ)
  const evalParams: (string | number)[] = [`${interval}`];
  if (tenantId) evalParams.push(tenantId);
  const evalTenantClause = tenantId ? "AND tenant_id = $2" : "";
  const evalResult = await db.query(
    `SELECT AVG(score) AS avg_judge_score
     FROM conversation_evaluations
     WHERE evaluated_at >= NOW() - $1::interval
       AND score > 0
     ${evalTenantClause}
     ${userSourceExists("conversation_evaluations.session_id", "conversation_evaluations.tenant_id")}`,
    evalParams,
  );

  // Total knowledge gaps
  const kgParams: (string | number)[] = [`${interval}`];
  if (tenantId) kgParams.push(tenantId);
  const kgResult = await db.query(
    `SELECT COUNT(*) AS total_knowledge_gaps
     FROM knowledge_gaps
     WHERE created_at >= NOW() - $1::interval
     ${kgTenantClause}
     ${userSourceExists("knowledge_gaps.session_id", "knowledge_gaps.tenant_id", "id")}`,
    kgParams,
  );

  // Avg messages per session
  const msgParams: (string | number)[] = [`${interval}`];
  if (tenantId) msgParams.push(tenantId);
  const msgTenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  const msgResult = await db.query(
    `SELECT COALESCE(AVG(msg_count), 0) AS avg_messages_per_session
     FROM (
       SELECT s.session_id, COUNT(m.id) AS msg_count
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       WHERE s.started_at >= NOW() - $1::interval
       ${msgTenantClause}
       ${userSourceClause("s")}
       GROUP BY s.session_id
     ) sub`,
    msgParams,
  );

  // Avatar session count — sessions that have a message containing 'livekit'
  const avatarParams: (string | number)[] = [`${interval}`];
  if (tenantId) avatarParams.push(tenantId);
  const avatarTenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  const avatarResult = await db.query(
    `SELECT COUNT(DISTINCT s.session_id) AS avatar_session_count
     FROM chat_sessions s
     JOIN chat_messages m ON m.session_id = s.id
     WHERE s.started_at >= NOW() - $1::interval
       AND (m.content ILIKE '%livekit%' OR m.content ILIKE '%avatar%')
     ${avatarTenantClause}
     ${userSourceClause("s")}`,
    avatarParams,
  );

  const totalSessions = parseInt(
    sessionsResult.rows[0]?.total_sessions ?? "0",
    10,
  );
  const prevTotalSessions = parseInt(
    prevSessionsResult.rows[0]?.prev_total_sessions ?? "0",
    10,
  );
  const avgJudgeScore =
    evalResult.rows[0]?.avg_judge_score != null
      ? parseFloat(evalResult.rows[0].avg_judge_score)
      : null;
  const totalKnowledgeGaps = parseInt(
    kgResult.rows[0]?.total_knowledge_gaps ?? "0",
    10,
  );
  const avgMessagesPerSession = parseFloat(
    msgResult.rows[0]?.avg_messages_per_session ?? "0",
  );
  const avatarSessionCount = parseInt(
    avatarResult.rows[0]?.avatar_session_count ?? "0",
    10,
  );

  // Sentiment distribution
  //
  // GID 1217808492463681 (P0-3): 修正前はこのクエリだけ user フィルタが
  // 無く、テナントの全 chat_messages(e2e/chat-test含む)を数えていた。
  // 同じレスポンス内で total_sessions=13 なのに sentiment_distribution.total
  // =753 という58倍の食い違いが本番で実測されている。他クエリと同じ
  // userSourceExists() で揃える。
  const sentParams: (string | number)[] = [`${interval}`];
  const sentTenantClause = tenantId ? "AND tenant_id = $2" : "";
  if (tenantId) sentParams.push(tenantId);
  const sentimentResult = await db.query(
    `SELECT sentiment->>'label' AS label, COUNT(*)::int AS count
     FROM chat_messages
     WHERE sentiment IS NOT NULL
       AND created_at >= NOW() - $1::interval
     ${sentTenantClause}
     ${userSourceExists("chat_messages.session_id", "chat_messages.tenant_id", "id")}
     GROUP BY sentiment->>'label'`,
    sentParams,
  );

  const avatarRate =
    totalSessions > 0 ? avatarSessionCount / totalSessions : 0;
  const sessionsChangePct =
    prevTotalSessions > 0
      ? ((totalSessions - prevTotalSessions) / prevTotalSessions) * 100
      : 0;

  const sentMap = new Map<string, number>();
  for (const row of sentimentResult.rows) {
    sentMap.set(row.label as string, row.count as number);
  }
  const sentPositive = sentMap.get("positive") ?? 0;
  const sentNegative = sentMap.get("negative") ?? 0;
  const sentNeutral = sentMap.get("neutral") ?? 0;

  // Phase65-3: CV aggregation (30d fixed)
  //
  // GID 1217808492463681 (P0-3・確定した設計判断 D2): `session_id IS NULL OR`
  // の分岐を削除した。この分岐が「session_idが無い旧経路のイベントを誤って
  // 除外しないため」というコメントの意図に反し、実際にはe2eトラフィックの
  // conversion_attributions行(session_idがある行も含め、全てここを通過し得る
  // ものではなく、そもそもこの分岐自体がsession_id IS NULLの行を無条件で
  // 通していた)を全て通過させ、cv-status(/v1/admin/analytics/cv-status、
  // userSourceExists使用)と正反対の値を返していた
  // (本番実測: summary側 cv_count_30d=279 / cv-status側 cv_count_30d=0)。
  // cv-status・crossTenantContext.ts と同じ userSourceExists() に統一する。
  const cvQueryParams: (string | number)[] = [];
  const cvTenantClause = tenantId ? "AND tenant_id = $1" : "";
  if (tenantId) cvQueryParams.push(tenantId);
  const cvResult = await db.query(
    `SELECT
       conversion_type,
       COUNT(*)::int AS count,
       COALESCE(SUM(conversion_value), 0)::numeric AS total_value
     FROM conversion_attributions
     WHERE created_at > NOW() - INTERVAL '30 days'
     ${cvTenantClause}
     ${userSourceExists("conversion_attributions.session_id", "conversion_attributions.tenant_id", "id")}
     GROUP BY conversion_type`,
    cvQueryParams,
  );

  const cvBreakdown = { purchase: 0, inquiry: 0, reservation: 0, signup: 0, other: 0 };
  let cvCount30d = 0;
  let cvTotalValue30d = 0;
  for (const row of cvResult.rows as Array<{ conversion_type: string; count: number; total_value: string }>) {
    const t = row.conversion_type as keyof typeof cvBreakdown;
    const cnt = row.count;
    const val = parseFloat(row.total_value);
    if (t in cvBreakdown) cvBreakdown[t] = cnt;
    cvCount30d += cnt;
    cvTotalValue30d += val;
  }

  let cvDaysSinceFirstSession: number | null = null;
  if (tenantId) {
    const ageResult = await db.query(
      `SELECT EXTRACT(DAYS FROM (NOW() - COALESCE(cs_min.first_session_at, t.created_at)))::int AS days
       FROM tenants t
       LEFT JOIN (
         SELECT tenant_id, MIN(started_at) AS first_session_at
         FROM chat_sessions
         GROUP BY tenant_id
       ) cs_min ON cs_min.tenant_id = t.id
       WHERE t.id = $1`,
      [tenantId],
    );
    cvDaysSinceFirstSession = ageResult.rows[0]?.days ?? null;
  }

  return {
    period,
    tenant_id: tenantId,
    total_sessions: totalSessions,
    avg_judge_score: avgJudgeScore,
    total_knowledge_gaps: totalKnowledgeGaps,
    avg_messages_per_session: avgMessagesPerSession,
    avatar_session_count: avatarSessionCount,
    avatar_rate: avatarRate,
    prev_total_sessions: prevTotalSessions,
    sessions_change_pct: sessionsChangePct,
    sentiment_distribution: {
      positive: sentPositive,
      negative: sentNegative,
      neutral: sentNeutral,
      total: sentPositive + sentNegative + sentNeutral,
    },
    cv_count_30d: cvCount30d,
    cv_total_value_30d: Math.round(cvTotalValue30d),
    cv_types_breakdown: cvBreakdown,
    cv_fired_status: cvCount30d > 0 ? 'fired' : 'not_fired',
    cv_days_since_first_session: cvDaysSinceFirstSession,
  };
}

export async function fetchConversionSummary({
  db,
  tenantId,
  period,
}: SummaryQueryParams): Promise<ConversionSummaryResponse> {
  const interval = periodToInterval(period);

  const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  const params: (string | number)[] = [`${interval}`];
  if (tenantId) params.push(tenantId);

  // サマリー: 合計セッション、記録済み件数、outcome別内訳
  const summaryResult = await db.query(
    `SELECT
       COUNT(*) AS total_sessions,
       COUNT(s.outcome) AS recorded_outcomes,
       s.outcome,
       COUNT(s.outcome) AS outcome_count
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval
     ${tenantClause}
     ${userSourceClause("s")}
     GROUP BY s.outcome`,
    params,
  );

  const totalSessions = (summaryResult.rows as Array<{ total_sessions: string }>).reduce((acc, row) => acc + parseInt(row.total_sessions, 10), 0);
  // Dedup: get total from a separate count
  const totalCountResult = await db.query(
    `SELECT COUNT(*) AS total FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause} ${userSourceClause("s")}`,
    params,
  );
  const total = parseInt(totalCountResult.rows[0]?.total ?? "0", 10);
  // GID 1216970103691946 (PR-6): CV発生時の自動記録(outcome_recorded_by=
  // AUTO_OUTCOME_RECORDED_BY)を除く。この指標は「オペレーターが記録した率」を
  // 意味するため、自動記録を含めると跳ね上がり指標としての意味を失う。
  const recordedResult = await db.query(
    `SELECT COUNT(*) AS recorded FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
       AND s.outcome IS NOT NULL
       AND (s.outcome_recorded_by IS NULL OR s.outcome_recorded_by <> '${AUTO_OUTCOME_RECORDED_BY}')
       ${userSourceClause("s")}`,
    params,
  );
  const recorded = parseInt(recordedResult.rows[0]?.recorded ?? "0", 10);

  // outcome別内訳
  const outcomeBreakdownResult = await db.query(
    `SELECT s.outcome, COUNT(*) AS cnt
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
       AND s.outcome IS NOT NULL
     ${userSourceClause("s")}
     GROUP BY s.outcome
     ORDER BY cnt DESC`,
    params,
  );
  const outcomes: Record<string, number> = {};
  for (const row of outcomeBreakdownResult.rows as Array<{ outcome: string; cnt: string }>) {
    outcomes[row.outcome] = parseInt(row.cnt, 10);
  }

  const recordingRate = total > 0 ? Math.round((recorded / total) * 1000) / 10 : 0;

  // 日別コンバージョン率推移
  const trendResult = await db.query(
    `SELECT
       DATE(s.started_at) AS date,
       COUNT(*) AS total,
       COUNT(CASE WHEN s.outcome IS NOT NULL AND s.outcome NOT IN ('離脱', '不明') THEN 1 END) AS converted
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
     ${userSourceClause("s")}
     GROUP BY DATE(s.started_at)
     ORDER BY date ASC`,
    params,
  );
  const conversionRateTrend = (trendResult.rows as Array<{ date: string; total: string; converted: string }>).map((row) => {
    const t2 = parseInt(row.total, 10);
    const c = parseInt(row.converted, 10);
    return {
      date: row.date,
      total: t2,
      converted: c,
      rate: t2 > 0 ? Math.round((c / t2) * 1000) / 10 : 0,
    };
  });

  // テクニック別効果（評価フィードバックからキーワード抽出 × outcome）
  const TECHNIQUE_KEYWORDS = [
    "アンカリング", "損失回避", "社会的証明", "希少性", "返報性", "コミットメント", "権威", "好意",
  ];
  const techniqueParams: (string | number)[] = [`${interval}`];
  if (tenantId) techniqueParams.push(tenantId);
  const techTenantClause = tenantId ? `AND s.tenant_id = $${techniqueParams.length}` : "";

  const techResult = await db.query(
    `SELECT
       ce.feedback,
       s.outcome
     FROM conversation_evaluations ce
     JOIN chat_sessions s ON s.session_id = ce.session_id
     WHERE ce.evaluated_at >= NOW() - $1::interval
       ${techTenantClause}
       AND ce.feedback IS NOT NULL
       ${userSourceClause("s")}`,
    techniqueParams,
  );

  const techniqueMap: Record<string, { sessions_used: number; converted: number }> = {};
  for (const row of techResult.rows as Array<{ feedback: unknown; outcome: string | null }>) {
    const feedbackStr = typeof row.feedback === "string"
      ? row.feedback
      : JSON.stringify(row.feedback ?? "");
    for (const kw of TECHNIQUE_KEYWORDS) {
      if (feedbackStr.includes(kw)) {
        if (!techniqueMap[kw]) techniqueMap[kw] = { sessions_used: 0, converted: 0 };
        techniqueMap[kw].sessions_used++;
        if (row.outcome && !["離脱", "不明"].includes(row.outcome)) {
          techniqueMap[kw].converted++;
        }
      }
    }
  }
  const techniqueEffectiveness = Object.entries(techniqueMap)
    .map(([technique, data]) => ({
      technique,
      sessions_used: data.sessions_used,
      converted: data.converted,
      conversion_rate: data.sessions_used > 0
        ? Math.round((data.converted / data.sessions_used) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.conversion_rate - a.conversion_rate);

  // ステージ別離脱分析（最終メッセージのstate from metadata）
  const stageParams: (string | number)[] = [`${interval}`];
  if (tenantId) stageParams.push(tenantId);
  const stageTenantClause = tenantId ? `AND s.tenant_id = $${stageParams.length}` : "";

  const stageResult = await db.query(
    `SELECT
       cm.metadata->>'state' AS state,
       COUNT(DISTINCT s.id) AS cnt
     FROM chat_sessions s
     JOIN LATERAL (
       SELECT metadata FROM chat_messages
       WHERE session_id = s.id
       ORDER BY created_at DESC LIMIT 1
     ) cm ON TRUE
     WHERE s.started_at >= NOW() - $1::interval
       ${stageTenantClause}
       AND (s.outcome IS NULL OR s.outcome IN ('離脱', '不明'))
       AND cm.metadata->>'state' IS NOT NULL
       ${userSourceClause("s")}
     GROUP BY cm.metadata->>'state'`,
    stageParams,
  );
  const stageDropout: Record<string, number> = { clarify: 0, answer: 0, confirm: 0, terminal: 0 };
  for (const row of stageResult.rows as Array<{ state: string; cnt: string }>) {
    const state = row.state;
    if (state in stageDropout) {
      stageDropout[state] = parseInt(row.cnt, 10);
    }
  }

  return {
    summary: {
      total_sessions: total,
      recorded_outcomes: recorded,
      recording_rate: recordingRate,
      outcomes,
    },
    conversion_rate_trend: conversionRateTrend,
    technique_effectiveness: techniqueEffectiveness,
    stage_dropout: stageDropout,
  };
}

// ---------------------------------------------------------------------------
// W2-4: 会話分析の推移グラフ・低評価セッション
//
// GET /v1/admin/analytics/trends の日次推移クエリと、GET /v1/admin/analytics/evaluations
// の低評価セッション抽出クエリを、チャットエージェント(get_analytics_trend)から再利用
// できるよう切り出す。fetchAnalyticsSummary と同じ理由(HTTPレイヤとチャットエージェント
// が同じ数値を取得する)。score_distribution / axis_averages は旧UIの詳細ドリルダウン
// (棒グラフの内訳)向けで、チャットの要約には過剰なため切り出し対象に含めない
// (旧UIの/evaluationsエンドポイント自体は変更しない)。
// ---------------------------------------------------------------------------

export interface AnalyticsTrendResponse {
  period: string;
  tenant_id: string | null;
  daily: Array<{
    date: string;
    sessions: number;
    avg_score: number | null;
    knowledge_gaps: number;
    sentiment_positive: number;
    sentiment_negative: number;
    sentiment_neutral: number;
  }>;
}

export async function fetchAnalyticsTrend({ db, tenantId, period }: SummaryQueryParams): Promise<AnalyticsTrendResponse> {
  const interval = periodToInterval(period);
  const params: (string | number)[] = [`${interval}`];
  const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  if (tenantId) params.push(tenantId);

  const evalTenantClause = tenantId ? "AND e.tenant_id = $2" : "";
  const kgTenantClause = tenantId ? "AND kg.tenant_id = $2" : "";

  const result = await db.query(
    `SELECT
       d.date::text AS date,
       COALESCE(s_count.sessions, 0)::int AS sessions,
       e_avg.avg_score,
       COALESCE(kg_count.knowledge_gaps, 0)::int AS knowledge_gaps
     FROM (
       SELECT generate_series(
         date_trunc('day', NOW() - $1::interval),
         date_trunc('day', NOW()),
         '1 day'::interval
       )::date AS date
     ) d
     LEFT JOIN (
       SELECT date_trunc('day', s.started_at)::date AS day, COUNT(*) AS sessions
       FROM chat_sessions s
       WHERE s.started_at >= NOW() - $1::interval
       ${tenantClause}
       ${userSourceClause("s")}
       GROUP BY day
     ) s_count ON s_count.day = d.date
     LEFT JOIN (
       SELECT date_trunc('day', e.evaluated_at)::date AS day, AVG(e.score) AS avg_score
       FROM conversation_evaluations e
       WHERE e.evaluated_at >= NOW() - $1::interval
         AND e.score > 0
       ${evalTenantClause}
       ${userSourceExists("e.session_id", "e.tenant_id")}
       GROUP BY day
     ) e_avg ON e_avg.day = d.date
     LEFT JOIN (
       SELECT date_trunc('day', kg.created_at)::date AS day, COUNT(*) AS knowledge_gaps
       FROM knowledge_gaps kg
       WHERE kg.created_at >= NOW() - $1::interval
       ${kgTenantClause}
       -- sentiment と同じ理由でここにも実ユーザー判定が要る。
       -- fetchAnalyticsSummary 側の total_knowledge_gaps には付いている(上記)のに
       -- こちらだけ抜けていると、同じ「未回答質問数」がsummary画面とtrends画面で
       -- 食い違う(片方はe2e除外、もう片方は含む)。
       -- knowledge_gaps.session_id は UUID (migration_knowledge_gaps.sql:8) なので
       -- chat_sessions.id と突き合わせる。
       ${userSourceExists("kg.session_id", "kg.tenant_id", "id")}
       GROUP BY day
     ) kg_count ON kg_count.day = d.date
     ORDER BY d.date ASC`,
    params,
  );

  const sentTrendsParams: (string | number)[] = [`${interval}`];
  const sentTrendsTenantClause = tenantId ? "AND cm.tenant_id = $2" : "";
  if (tenantId) sentTrendsParams.push(tenantId);

  // GID 1217825468673283: fetchAnalyticsSummary の sentiment_distribution
  // (P0-3, PR #954)と同根の欠陥。userSourceExists() が無く、テナントの
  // 全 chat_messages(e2e/chat-test含む)を集計していた。同じ形で揃える。
  const sentTrendsResult = await db.query(
    `SELECT
       DATE_TRUNC('day', cm.created_at)::date::text AS day,
       COUNT(*) FILTER (WHERE cm.sentiment->>'label' = 'positive')::int AS positive,
       COUNT(*) FILTER (WHERE cm.sentiment->>'label' = 'negative')::int AS negative,
       COUNT(*) FILTER (WHERE cm.sentiment->>'label' = 'neutral')::int AS neutral
     FROM chat_messages cm
     WHERE cm.sentiment IS NOT NULL
       AND cm.created_at >= NOW() - $1::interval
     ${sentTrendsTenantClause}
     ${userSourceExists("cm.session_id", "cm.tenant_id", "id")}
     GROUP BY day ORDER BY day`,
    sentTrendsParams,
  );

  const sentTrendsMap = new Map<string, { positive: number; negative: number; neutral: number }>();
  for (const row of sentTrendsResult.rows) {
    sentTrendsMap.set(String(row.day), {
      positive: row.positive as number,
      negative: row.negative as number,
      neutral: row.neutral as number,
    });
  }

  type TrendRow = { date: string; sessions: number; avg_score: string | null; knowledge_gaps: number };
  const daily = (result.rows as TrendRow[]).map((row) => {
    const sent = sentTrendsMap.get(row.date) ?? { positive: 0, negative: 0, neutral: 0 };
    return {
      date: row.date,
      sessions: row.sessions,
      avg_score: row.avg_score != null ? parseFloat(row.avg_score) : null,
      knowledge_gaps: row.knowledge_gaps,
      sentiment_positive: sent.positive,
      sentiment_negative: sent.negative,
      sentiment_neutral: sent.neutral,
    };
  });

  return { period, tenant_id: tenantId, daily };
}

export interface LowScoreSession {
  session_id: string;
  score: number;
  evaluated_at: string;
  message_count: number;
  feedback_summary: string;
}

export async function fetchLowScoreSessions(
  { db, tenantId, period }: SummaryQueryParams,
  limit = 10,
): Promise<LowScoreSession[]> {
  const interval = periodToInterval(period);
  const lowScoreParams: (string | number)[] = [`${interval}`];
  const lowTenantClause = tenantId ? "AND e.tenant_id = $2" : "";
  if (tenantId) lowScoreParams.push(tenantId);
  lowScoreParams.push(limit);

  const lowResult = await db.query(
    `SELECT
       e.session_id,
       e.score,
       e.evaluated_at,
       COALESCE(msg_counts.message_count, 0)::int AS message_count,
       SUBSTRING(COALESCE(e.feedback::text, ''), 1, 100) AS feedback_summary
     FROM conversation_evaluations e
     LEFT JOIN (
       SELECT session_id, COUNT(*) AS message_count
       FROM chat_messages
       GROUP BY session_id
     ) msg_counts ON msg_counts.session_id::text = e.session_id
     WHERE e.evaluated_at >= NOW() - $1::interval
       AND e.score > 0
       AND e.score < 40
     ${lowTenantClause}
     ${userSourceExists("e.session_id", "e.tenant_id")}
     ORDER BY e.score ASC
     LIMIT $${lowScoreParams.length}`,
    lowScoreParams,
  );

  type LowScoreRow = { session_id: string; score: string; evaluated_at: Date | string; message_count: number; feedback_summary: string | null };
  return (lowResult.rows as LowScoreRow[]).map((row) => ({
    session_id: row.session_id,
    score: parseFloat(row.score),
    evaluated_at: row.evaluated_at instanceof Date ? row.evaluated_at.toISOString() : row.evaluated_at,
    message_count: row.message_count,
    feedback_summary: row.feedback_summary ?? "",
  }));
}

// -----------------------------------------------------------------------------
// GET /v1/admin/analytics/knowledge-attribution (Phase68) の集計本体。
// W2-6(docs/COPILOT_UI_PARITY.md §3.1 #14): チャット(get_knowledge_attribution)と
// HTTPレイヤ(routes.ts)の両方から同じ数値を取得できるよう、認可・レスポンス整形から
// 切り離してここに置く(fetchAnalyticsTrendと同じ狙い)。
// -----------------------------------------------------------------------------

export type KnowledgeAttributionItem = {
  chunk_id: string;
  source: "faq" | "book";
  title: string;
  principle?: string;
  usage_count: number;
  conversation_count: number;
  conversion_count: number;
  conversion_rate: number;
  avg_judge_score: number | null;
  trend: "up" | "down" | "stable" | "insufficient_data";
};

export type KnowledgeAttributionResult = {
  items: KnowledgeAttributionItem[];
  summary: {
    total_chunks_used: number;
    avg_conversion_rate: number;
    top_performer: KnowledgeAttributionItem | null;
    worst_performer: KnowledgeAttributionItem | null;
  };
};

export async function fetchKnowledgeAttribution(
  { db, tenantId, period }: SummaryQueryParams,
  sourceType: "all" | "faq" | "book" = "all",
  limit = 50,
  sortBy: "conversion_rate" | "usage_count" | "judge_score" = "conversion_rate",
): Promise<KnowledgeAttributionResult> {
  const interval = periodToInterval(period);
  const queryArgs: (string | number | null)[] = [tenantId, interval];
  if (sourceType !== "all") queryArgs.push(sourceType);
  const sourceFilterClause = sourceType === "all" ? "" : "AND (src->>'source') = $3";
  // ORDER BY 列を allow-list から選択（SQLインジェクション防止。sortByは呼び出し元で検証済みの想定）
  const orderColumn =
    sortBy === "usage_count" ? "usage_count" : sortBy === "judge_score" ? "avg_judge_score" : "conversion_rate";

  const sql = `
    WITH current_period AS (
      SELECT
        (src->>'chunk_id') AS chunk_id,
        (src->>'source') AS src_type,
        (src->>'principle') AS principle,
        cs.id AS session_uuid,
        cs.session_id AS session_text_id,
        ca.id IS NOT NULL AS converted,
        ev.score AS judge_score
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
      LEFT JOIN conversion_attributions ca ON ca.session_id = cs.id
      LEFT JOIN conversation_evaluations ev ON ev.session_id = cs.session_id AND ev.score > 0
      CROSS JOIN LATERAL jsonb_array_elements(cm.rag_sources) AS src
      WHERE cs.tenant_id = $1
        AND cm.rag_sources IS NOT NULL
        AND cm.role = 'assistant'
        AND cm.created_at >= NOW() - $2::interval
        ${sourceFilterClause}
        ${userSourceClause("cs")}
    ),
    previous_period AS (
      SELECT
        (src->>'chunk_id') AS chunk_id,
        cs.id AS session_uuid,
        ca.id IS NOT NULL AS converted
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
      LEFT JOIN conversion_attributions ca ON ca.session_id = cs.id
      CROSS JOIN LATERAL jsonb_array_elements(cm.rag_sources) AS src
      WHERE cs.tenant_id = $1
        AND cm.rag_sources IS NOT NULL
        AND cm.role = 'assistant'
        AND cm.created_at >= NOW() - ($2::interval * 2)
        AND cm.created_at <  NOW() - $2::interval
        ${sourceFilterClause}
        ${userSourceClause("cs")}
    ),
    current_agg AS (
      SELECT
        chunk_id,
        MAX(src_type) AS src_type,
        MAX(principle) AS principle,
        COUNT(*)::int AS usage_count,
        COUNT(DISTINCT session_uuid)::int AS conversation_count,
        COUNT(DISTINCT CASE WHEN converted THEN session_uuid END)::int AS conversion_count,
        AVG(judge_score)::float AS avg_judge_score
      FROM current_period
      GROUP BY chunk_id
    ),
    previous_agg AS (
      SELECT
        chunk_id,
        COUNT(DISTINCT session_uuid)::int AS prev_conversation_count,
        CASE
          WHEN COUNT(DISTINCT session_uuid) > 0
          THEN COUNT(DISTINCT CASE WHEN converted THEN session_uuid END)::float
               / COUNT(DISTINCT session_uuid)
          ELSE 0
        END AS prev_rate
      FROM previous_period
      GROUP BY chunk_id
    ),
    joined AS (
      SELECT
        c.chunk_id,
        c.src_type,
        c.principle,
        c.usage_count,
        c.conversation_count,
        c.conversion_count,
        CASE
          WHEN c.conversation_count > 0
          THEN (c.conversion_count::float / c.conversation_count)
          ELSE 0
        END AS conversion_rate,
        c.avg_judge_score,
        fe.text AS raw_text,
        bu.title AS book_title,
        COALESCE(p.prev_rate, 0) AS prev_rate,
        COALESCE(p.prev_conversation_count, 0) AS prev_conversation_count
      FROM current_agg c
      LEFT JOIN faq_embeddings fe
        ON fe.id::text = c.chunk_id AND (fe.tenant_id = $1 OR fe.tenant_id = 'global')
      LEFT JOIN book_uploads bu
        ON bu.id::text = fe.metadata->>'book_id'
      LEFT JOIN previous_agg p ON p.chunk_id = c.chunk_id
    )
    SELECT * FROM joined
    ORDER BY ${orderColumn} DESC NULLS LAST, usage_count DESC
    LIMIT ${limit}
  `;

  const result = await db.query(sql, queryArgs);

  type AttrRow = {
    chunk_id: string;
    src_type: "faq" | "book" | null;
    principle: string | null;
    usage_count: number;
    conversation_count: number;
    conversion_count: number;
    conversion_rate: number;
    avg_judge_score: number | null;
    raw_text: string | null;
    book_title: string | null;
    prev_rate: number;
    prev_conversation_count: number;
  };

  const items: KnowledgeAttributionItem[] = (result.rows as AttrRow[]).map((row) => {
    const currentRate = row.conversion_rate ?? 0;
    const prevRate = row.prev_rate ?? 0;
    const delta = currentRate - prevRate;
    // CLAUDE.md 禁止34: 前期間の母数が0のとき prev_rate は便宜上0扱いになっており、
    // それを実際の「0%」と区別できないまま up/down を出すと架空のトレンドになる。
    const trend: KnowledgeAttributionItem["trend"] =
      row.prev_conversation_count === 0
        ? "insufficient_data"
        : Math.abs(delta) < 0.02 ? "stable" : delta > 0 ? "up" : "down";
    const chunkTitle = row.raw_text
      ? (() => { try { return decryptText(row.raw_text!).slice(0, 50); } catch { return row.raw_text!.slice(0, 50); } })()
      : null;
    const displayTitle =
      row.src_type === "book" && row.book_title
        ? `${row.book_title} — ${chunkTitle ?? ""}`
        : chunkTitle ?? "(削除済み)";
    return {
      chunk_id: row.chunk_id,
      source: (row.src_type ?? "faq") as "faq" | "book",
      title: displayTitle,
      principle: row.principle ?? undefined,
      usage_count: row.usage_count,
      conversation_count: row.conversation_count,
      conversion_count: row.conversion_count,
      conversion_rate: Number(currentRate.toFixed(4)),
      avg_judge_score: row.avg_judge_score != null ? Number(row.avg_judge_score.toFixed(2)) : null,
      trend,
    };
  });

  const totalChunksUsed = items.length;
  const avgConversionRate =
    totalChunksUsed > 0
      ? Number((items.reduce((s, i) => s + i.conversion_rate, 0) / totalChunksUsed).toFixed(4))
      : 0;
  const topPerformer = items.reduce<KnowledgeAttributionItem | null>(
    (best, it) => (best == null || it.conversion_rate > best.conversion_rate ? it : best),
    null,
  );
  const worstPerformer = items.reduce<KnowledgeAttributionItem | null>(
    (worst, it) => (worst == null || it.conversion_rate < worst.conversion_rate ? it : worst),
    null,
  );

  return {
    items,
    summary: {
      total_chunks_used: totalChunksUsed,
      avg_conversion_rate: avgConversionRate,
      top_performer: topPerformer,
      worst_performer: worstPerformer,
    },
  };
}
