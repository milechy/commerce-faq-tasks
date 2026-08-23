// src/api/admin/analytics/summaryQueries.ts

// GET /v1/admin/analytics/summary と /conversions の集計本体。
// HTTPレイヤ(routes.ts)とチャットエージェント(agent/actionExecutor.ts)の両方から
// 同じ数値を取得できるよう、認可・レスポンス整形から切り離してここに置く。

import type { Pool } from "pg";

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
  const sentParams: (string | number)[] = [`${interval}`];
  const sentTenantClause = tenantId ? "AND tenant_id = $2" : "";
  if (tenantId) sentParams.push(tenantId);
  const sentimentResult = await db.query(
    `SELECT sentiment->>'label' AS label, COUNT(*)::int AS count
     FROM chat_messages
     WHERE sentiment IS NOT NULL
       AND created_at >= NOW() - $1::interval
     ${sentTenantClause}
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
     -- GID 1216970103691946: session_idが無いイベント(セッション紐付けができない
     -- 旧経路)は誤って除外しないよう温存し、session_idがある場合のみ実ユーザー
     -- 判定する
     AND (
       session_id IS NULL
       OR EXISTS (
         SELECT 1 FROM chat_sessions cs
         WHERE cs.id = conversion_attributions.session_id
           AND cs.tenant_id = conversion_attributions.tenant_id
           AND cs.metadata->>'source' = 'user'
       )
     )
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
  const recordedResult = await db.query(
    `SELECT COUNT(*) AS recorded FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause} AND s.outcome IS NOT NULL ${userSourceClause("s")}`,
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
