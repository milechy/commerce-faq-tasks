// src/api/admin/analytics/routes.ts

// Phase50 Stream A: Analytics集計API

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { pool } from "../../../lib/db";
import { createNotification, notificationExists } from "../../../lib/notifications";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalyticsSummaryResponse {
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
}

interface AnalyticsTrendsResponse {
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

interface AnalyticsEvaluationsResponse {
  period: string;
  tenant_id: string | null;
  score_distribution: Array<{
    range: string;
    count: number;
  }>;
  axis_averages: {
    psychology_fit: number;
    customer_reaction: number;
    stage_progress: number;
    taboo_violation: number;
  };
  low_score_sessions: Array<{
    session_id: string;
    score: number;
    evaluated_at: string;
    message_count: number;
    feedback_summary: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * period 文字列を SQL INTERVAL 文字列に変換する。
 * 未知の値は "30 days" にフォールバック。
 */
function periodToInterval(period: string): string {
  switch (period) {
    case "7d":
      return "7 days";
    case "90d":
      return "90 days";
    default:
      return "30 days";
  }
}

/**
 * テナントIDをリクエストから解決する。
 * - super_admin: query ?tenant=xxx を許可（省略時は null = 全テナント）
 * - client_admin: JWT 由来の自テナントのみ（CLAUDE.md: tenantId は body から禁止）
 */
function resolveTenantFilter(
  req: Request,
  jwtTenantId: string,
  isSuperAdmin: boolean,
): string | null {
  if (isSuperAdmin) {
    const fromQuery = req.query["tenant"] as string | undefined;
    return fromQuery ?? null;
  }
  return jwtTenantId || null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAnalyticsRoutes(app: Express): void {
  app.use("/v1/admin/analytics", supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/summary
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/summary",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string =
        su?.app_metadata?.tenant_id ?? su?.user_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") ===
        "super_admin";

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const interval = periodToInterval(period);
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        // Build tenant filter clauses
        const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
        const kgTenantClause = tenantId ? "AND tenant_id = $2" : "";
        const params: (string | number)[] = [`${interval}`];
        if (tenantId) params.push(tenantId);

        // Current period: sessions
        const sessionsResult = await pool.query(
          `SELECT COUNT(*) AS total_sessions
           FROM chat_sessions s
           WHERE s.started_at >= NOW() - $1::interval
           ${tenantClause}`,
          params,
        );

        // Previous period: sessions
        const prevParams: (string | number)[] = [`${interval}`];
        if (tenantId) prevParams.push(tenantId);
        const prevTenantClause = tenantId ? "AND s.tenant_id = $2" : "";
        const prevSessionsResult = await pool.query(
          `SELECT COUNT(*) AS prev_total_sessions
           FROM chat_sessions s
           WHERE s.started_at >= NOW() - 2 * ($1::interval)
             AND s.started_at < NOW() - $1::interval
           ${prevTenantClause}`,
          prevParams,
        );

        // Avg judge score
        const evalParams: (string | number)[] = [`${interval}`];
        if (tenantId) evalParams.push(tenantId);
        const evalTenantClause = tenantId ? "AND tenant_id = $2" : "";
        const evalResult = await pool.query(
          `SELECT AVG(score) AS avg_judge_score
           FROM conversation_evaluations
           WHERE evaluated_at >= NOW() - $1::interval
             AND score > 0
           ${evalTenantClause}`,
          evalParams,
        );

        // Total knowledge gaps
        const kgParams: (string | number)[] = [`${interval}`];
        if (tenantId) kgParams.push(tenantId);
        const kgResult = await pool.query(
          `SELECT COUNT(*) AS total_knowledge_gaps
           FROM knowledge_gaps
           WHERE created_at >= NOW() - $1::interval
           ${kgTenantClause}`,
          kgParams,
        );

        // Avg messages per session
        const msgParams: (string | number)[] = [`${interval}`];
        if (tenantId) msgParams.push(tenantId);
        const msgTenantClause = tenantId ? "AND s.tenant_id = $2" : "";
        const msgResult = await pool.query(
          `SELECT COALESCE(AVG(msg_count), 0) AS avg_messages_per_session
           FROM (
             SELECT s.session_id, COUNT(m.id) AS msg_count
             FROM chat_sessions s
             LEFT JOIN chat_messages m ON m.session_id = s.id
             WHERE s.started_at >= NOW() - $1::interval
             ${msgTenantClause}
             GROUP BY s.session_id
           ) sub`,
          msgParams,
        );

        // Avatar session count — sessions that have a message containing 'livekit'
        const avatarParams: (string | number)[] = [`${interval}`];
        if (tenantId) avatarParams.push(tenantId);
        const avatarTenantClause = tenantId ? "AND s.tenant_id = $2" : "";
        const avatarResult = await pool.query(
          `SELECT COUNT(DISTINCT s.session_id) AS avatar_session_count
           FROM chat_sessions s
           JOIN chat_messages m ON m.session_id = s.id
           WHERE s.started_at >= NOW() - $1::interval
             AND (m.content ILIKE '%livekit%' OR m.content ILIKE '%avatar%')
           ${avatarTenantClause}`,
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
        const sentimentResult = await pool.query(
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

        const response: AnalyticsSummaryResponse = {
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
        };

        return res.json(response);
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/summary]", err);
        return res.status(500).json({ error: "サマリーの取得に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/trends
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/trends",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string =
        su?.app_metadata?.tenant_id ?? su?.user_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") ===
        "super_admin";

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const interval = periodToInterval(period);
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        const params: (string | number)[] = [`${interval}`];
        const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
        if (tenantId) params.push(tenantId);

        const evalTenantClause = tenantId
          ? "AND e.tenant_id = $2"
          : "";
        const kgTenantClause = tenantId ? "AND kg.tenant_id = $2" : "";

        const result = await pool.query(
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
             GROUP BY day
           ) s_count ON s_count.day = d.date
           LEFT JOIN (
             SELECT date_trunc('day', e.evaluated_at)::date AS day, AVG(e.score) AS avg_score
             FROM conversation_evaluations e
             WHERE e.evaluated_at >= NOW() - $1::interval
               AND e.score > 0
             ${evalTenantClause}
             GROUP BY day
           ) e_avg ON e_avg.day = d.date
           LEFT JOIN (
             SELECT date_trunc('day', kg.created_at)::date AS day, COUNT(*) AS knowledge_gaps
             FROM knowledge_gaps kg
             WHERE kg.created_at >= NOW() - $1::interval
             ${kgTenantClause}
             GROUP BY day
           ) kg_count ON kg_count.day = d.date
           ORDER BY d.date ASC`,
          params,
        );

        // Sentiment trends per day
        const sentTrendsParams: (string | number)[] = [`${interval}`];
        const sentTrendsTenantClause = tenantId ? "AND cm.tenant_id = $2" : "";
        if (tenantId) sentTrendsParams.push(tenantId);

        const sentTrendsResult = await pool.query(
          `SELECT
             DATE_TRUNC('day', cm.created_at)::date::text AS day,
             COUNT(*) FILTER (WHERE cm.sentiment->>'label' = 'positive')::int AS positive,
             COUNT(*) FILTER (WHERE cm.sentiment->>'label' = 'negative')::int AS negative,
             COUNT(*) FILTER (WHERE cm.sentiment->>'label' = 'neutral')::int AS neutral
           FROM chat_messages cm
           WHERE cm.sentiment IS NOT NULL
             AND cm.created_at >= NOW() - $1::interval
           ${sentTrendsTenantClause}
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

        const response: AnalyticsTrendsResponse = {
          period,
          tenant_id: tenantId,
          daily,
        };

        return res.json(response);
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/trends]", err);
        return res.status(500).json({ error: "トレンドの取得に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/evaluations
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/evaluations",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string =
        su?.app_metadata?.tenant_id ?? su?.user_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") ===
        "super_admin";

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const interval = periodToInterval(period);
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        const params: (string | number)[] = [`${interval}`];
        const tenantClause = tenantId ? "AND tenant_id = $2" : "";
        if (tenantId) params.push(tenantId);

        // Score distribution — 5 buckets
        const distResult = await pool.query(
          `SELECT
             CASE
               WHEN score < 20 THEN '0-20'
               WHEN score < 40 THEN '20-40'
               WHEN score < 60 THEN '40-60'
               WHEN score < 80 THEN '60-80'
               ELSE '80-100'
             END AS range,
             COUNT(*) AS count
           FROM conversation_evaluations
           WHERE evaluated_at >= NOW() - $1::interval
             AND score > 0
           ${tenantClause}
           GROUP BY range
           ORDER BY range`,
          params,
        );

        // Axis averages
        const axisResult = await pool.query(
          `SELECT
             COALESCE(AVG(psychology_fit_score), 0)    AS psychology_fit,
             COALESCE(AVG(customer_reaction_score), 0) AS customer_reaction,
             COALESCE(AVG(stage_progress_score), 0)    AS stage_progress,
             COALESCE(AVG(taboo_violation_score), 0)   AS taboo_violation
           FROM conversation_evaluations
           WHERE evaluated_at >= NOW() - $1::interval
             AND score > 0
           ${tenantClause}`,
          params,
        );

        // Low score sessions (score < 40, limit 10)
        const lowScoreParams: (string | number)[] = [`${interval}`];
        const lowTenantClause = tenantId ? "AND e.tenant_id = $2" : "";
        if (tenantId) lowScoreParams.push(tenantId);

        const lowResult = await pool.query(
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
           ORDER BY e.score ASC
           LIMIT 10`,
          lowScoreParams,
        );

        // Build 5-bucket score distribution ensuring all buckets present
        const BUCKETS = ["0-20", "20-40", "40-60", "60-80", "80-100"];
        const distMap = new Map<string, number>();
        for (const row of distResult.rows) {
          distMap.set(row.range, parseInt(row.count, 10));
        }
        const scoreDistribution = BUCKETS.map((b) => ({
          range: b,
          count: distMap.get(b) ?? 0,
        }));

        const axisRow = axisResult.rows[0] ?? {};
        const axisAverages = {
          psychology_fit: parseFloat(axisRow.psychology_fit ?? "0"),
          customer_reaction: parseFloat(axisRow.customer_reaction ?? "0"),
          stage_progress: parseFloat(axisRow.stage_progress ?? "0"),
          taboo_violation: parseFloat(axisRow.taboo_violation ?? "0"),
        };

        type LowScoreRow = { session_id: string; score: string; evaluated_at: Date | string; message_count: number; feedback_summary: string | null };
        const lowScoreSessions = (lowResult.rows as LowScoreRow[]).map((row) => ({
          session_id: row.session_id,
          score: parseFloat(row.score),
          evaluated_at: row.evaluated_at instanceof Date
            ? row.evaluated_at.toISOString()
            : row.evaluated_at,
          message_count: row.message_count,
          feedback_summary: row.feedback_summary ?? "",
        }));

        const response: AnalyticsEvaluationsResponse = {
          period,
          tenant_id: tenantId,
          score_distribution: scoreDistribution,
          axis_averages: axisAverages,
          low_score_sessions: lowScoreSessions,
        };

        return res.json(response);
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/evaluations]", err);
        return res.status(500).json({ error: "評価分析の取得に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/conversions
  // Phase52f: コンバージョントラッキング集計
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/conversions",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.user_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const interval = periodToInterval(period);
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
        const params: (string | number)[] = [`${interval}`];
        if (tenantId) params.push(tenantId);

        // サマリー: 合計セッション、記録済み件数、outcome別内訳
        const summaryResult = await pool.query(
          `SELECT
             COUNT(*) AS total_sessions,
             COUNT(s.outcome) AS recorded_outcomes,
             s.outcome,
             COUNT(s.outcome) AS outcome_count
           FROM chat_sessions s
           WHERE s.started_at >= NOW() - $1::interval
           ${tenantClause}
           GROUP BY s.outcome`,
          params,
        );

        const totalSessions = (summaryResult.rows as Array<{ total_sessions: string }>).reduce((acc, row) => acc + parseInt(row.total_sessions, 10), 0);
        // Dedup: get total from a separate count
        const totalCountResult = await pool.query(
          `SELECT COUNT(*) AS total FROM chat_sessions s
           WHERE s.started_at >= NOW() - $1::interval ${tenantClause}`,
          params,
        );
        const total = parseInt(totalCountResult.rows[0]?.total ?? "0", 10);
        const recordedResult = await pool.query(
          `SELECT COUNT(*) AS recorded FROM chat_sessions s
           WHERE s.started_at >= NOW() - $1::interval ${tenantClause} AND s.outcome IS NOT NULL`,
          params,
        );
        const recorded = parseInt(recordedResult.rows[0]?.recorded ?? "0", 10);

        // outcome別内訳
        const outcomeBreakdownResult = await pool.query(
          `SELECT s.outcome, COUNT(*) AS cnt
           FROM chat_sessions s
           WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
             AND s.outcome IS NOT NULL
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
        const trendResult = await pool.query(
          `SELECT
             DATE(s.started_at) AS date,
             COUNT(*) AS total,
             COUNT(CASE WHEN s.outcome IS NOT NULL AND s.outcome NOT IN ('離脱', '不明') THEN 1 END) AS converted
           FROM chat_sessions s
           WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
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

        const techResult = await pool.query(
          `SELECT
             ce.feedback,
             s.outcome
           FROM conversation_evaluations ce
           JOIN chat_sessions s ON s.session_id = ce.session_id
           WHERE ce.evaluated_at >= NOW() - $1::interval
             ${techTenantClause}
             AND ce.feedback IS NOT NULL`,
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

        const stageResult = await pool.query(
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

        const responseData = {
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

        // Phase52h: Triggers 6/7/8 — コンバージョン通知（fire-and-forget）
        const today = new Date().toISOString().slice(0, 10);
        const week = (() => {
          const d = new Date();
          const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
          const day = utc.getUTCDay() || 7;
          utc.setUTCDate(utc.getUTCDate() + 4 - day);
          const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
          const wk = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
          return `${utc.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
        })();

        void (async () => {
          try {
            // Trigger 6: CVR前週比±20%以上変動
            const now = Date.now();
            const oneDay = 86400000;
            const currentWeekItems = conversionRateTrend.filter(
              (r) => now - new Date(r.date).getTime() <= 7 * oneDay,
            );
            const prevWeekItems = conversionRateTrend.filter((r) => {
              const age = now - new Date(r.date).getTime();
              return age > 7 * oneDay && age <= 14 * oneDay;
            });
            if (currentWeekItems.length > 0 && prevWeekItems.length > 0) {
              const avg = (items: typeof conversionRateTrend) =>
                items.reduce((s, r) => s + r.rate, 0) / items.length;
              const curr = avg(currentWeekItems);
              const prev = avg(prevWeekItems);
              if (prev > 0 && Math.abs(curr - prev) / prev >= 0.2) {
                const exists = await notificationExists('conversion_rate_change', 'week', week);
                if (!exists) {
                  const dir = curr > prev ? '上昇' : '下降';
                  void createNotification({
                    recipientRole: 'super_admin',
                    type: 'conversion_rate_change',
                    title: `コンバージョン率が大きく${dir}しました`,
                    message: `今週 ${curr.toFixed(1)}% / 先週 ${prev.toFixed(1)}%`,
                    link: '/admin/analytics',
                    metadata: { week, current: curr, previous: prev },
                  });
                }
              }
            }

            // Trigger 7: 未記録セッション10件以上（client_admin宛）
            if (tenantId && total - recorded >= 10) {
              const exists = await notificationExists('outcome_reminder', 'date', today);
              if (!exists) {
                void createNotification({
                  recipientRole: 'client_admin',
                  recipientTenantId: tenantId,
                  type: 'outcome_reminder',
                  title: '結果未記録の会話があります',
                  message: `${total - recorded}件の会話の結果がまだ記録されていません`,
                  link: '/admin/chat-history',
                  metadata: { date: today, unrecorded: total - recorded },
                });
              }
            }

            // Trigger 8: 高CVRパターン（80%超 + 5件以上）
            for (const tech of techniqueEffectiveness) {
              if (tech.conversion_rate >= 80 && tech.sessions_used >= 5) {
                const techWeekKey = `${tech.technique}_${week}`;
                const exists = await notificationExists('high_conversion_pattern', 'technique_week', techWeekKey);
                if (!exists) {
                  void createNotification({
                    recipientRole: 'super_admin',
                    type: 'high_conversion_pattern',
                    title: '高コンバージョンのパターンを発見',
                    message: `「${tech.technique}」のコンバージョン率が${tech.conversion_rate}%です`,
                    link: '/admin/analytics',
                    metadata: { week, technique_week: techWeekKey, technique: tech.technique, rate: tech.conversion_rate },
                  });
                }
              }
            }
          } catch {
            // silent — non-critical
          }
        })();

        return res.json(responseData);
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/conversions]", err);
        return res.status(500).json({ error: "コンバージョン分析の取得に失敗しました" });
      }
    },
  );
}
