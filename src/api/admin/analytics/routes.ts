// src/api/admin/analytics/routes.ts

// Phase50 Stream A: Analytics集計API

import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { pool } from "../../../lib/db";
import { createNotification, notificationExists } from "../../../lib/notifications";
import { logger } from '../../../lib/logger';
import { isAllowedAdminRole } from "../../middleware/roleAuth";
import { planHasFeature, queryTenantPlanOrThrow, type GatedFeature } from "../../../lib/billing/planFeatures";
import { getRuleEffect } from "./ruleEffect";
import {
  fetchAnalyticsSummary,
  fetchAnalyticsTrend,
  fetchConversionSummary,
  fetchHermesAcceptanceRate,
  fetchKnowledgeAttribution,
  fetchLowScoreSessions,
  periodToInterval,
  userSourceExists,
} from "./summaryQueries";
import { fetchMeasurementHealth } from "./measurementHealth";
import { fetchSchemaHealth } from "./schemaHealth";
import { fetchIgnitionStatus } from "./ignitionStatus";
import { getComponentSelfcheckResults } from "./componentSelfcheck";
import { fetchFixedCostQuotaStatus } from "../../../lib/billing/billingHealthCheck";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// 2026-08-29: 「基本の会話分析」(analytics)と「成果の分析」(conversion)を別ゲートに
// 分割した。summary/trends/evaluations は analytics(Standard〜)、conversions は
// conversion(Growth〜、成果分析)を見る。403メッセージも呼び出し元のfeatureに応じて
// 出し分ける(固定文言のままだとStandard開放後に嘘の案内になる)。
const ANALYTICS_PLAN_LIMIT_MESSAGES: Record<Extract<GatedFeature, "analytics" | "conversion">, string> = {
  analytics: "会話分析はStandardプラン以上でご利用いただけます",
  conversion: "成果分析はGrowthプラン以上でご利用いただけます",
};

/**
 * GID: LP料金表(Standard〜: 会話分析 / Growth〜: 成果分析)に基づくplan制限。
 * client_adminのみ対象（super_adminの集約/横断ビューは対象外）。
 * pool可用性チェックの後に呼ぶこと(poolそのものが無い場合の503とこの関数の
 * 403を混同しないため)。
 *
 * ★pool可用性チェックだけでは不十分★（2026-08-30 [H-7]で発覚した実際の欠陥）
 * poolが存在していても、plan確認クエリ自体が例外を投げることはある
 * (接続断・タイムアウト等)。fail-safeでfree_adに丸め込む queryTenantPlan を
 * ここで使うと、そのクエリ例外が「plan_upgrade_required」(403)に化けてしまい、
 * DB障害を「プランをアップグレードしてください」という誤った案内で
 * 覆い隠してしまう(このコメントが警告していたはずの事象そのもの)。
 * そのため queryTenantPlanOrThrow(DB例外を握り潰さない版)を使い、
 * plan確認クエリが失敗した場合は500を返す。
 *
 * 許可されなければ403を返し、呼び出し元は即returnすること
 * (plan確認自体が失敗した場合も500を返した上でfalseを返すので、
 * 同様に即returnすれば良い。呼び出し元がステータスコードを見分ける必要は無い)。
 */
async function checkAnalyticsPlanAccess(
  pool: Pick<Pool, "query">,
  res: Response,
  isSuperAdmin: boolean,
  jwtTenantId: string,
  feature: Extract<GatedFeature, "analytics" | "conversion"> = "analytics",
): Promise<boolean> {
  if (isSuperAdmin) return true;
  let plan: string;
  try {
    plan = await queryTenantPlanOrThrow(pool, jwtTenantId);
  } catch (err) {
    logger.warn("[checkAnalyticsPlanAccess] plan lookup failed", err);
    res.status(500).json({ error: "プランの確認に失敗しました" });
    return false;
  }
  if (planHasFeature(plan, feature)) return true;
  res.status(403).json({
    error: "plan_upgrade_required",
    message: ANALYTICS_PLAN_LIMIT_MESSAGES[feature],
  });
  return false;
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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'tenant_id_missing',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataTenantId: !!su?.app_metadata?.tenant_id,
          hasUserMetadataTenantId: !!su?.user_metadata?.tenant_id,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_TENANT_INVALID',
        }, "Admin analytics access denied: tenant_id missing for non-super-admin");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }
      if (!(await checkAnalyticsPlanAccess(pool, res, isSuperAdmin, jwtTenantId))) return;

      try {
        const response = await fetchAnalyticsSummary({ db: pool, tenantId, period });
        return res.json(response);
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/summary]", err);
        return res.status(500).json({ error: "サマリーの取得に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/measurement-health
  // GID 1216970103691946 (PR-7): 計測パイプライン自体が機能しているかの1画面。
  // plan gate なし(観測性であって課金対象の分析機能ではない。/v1/admin/monitoring/kpis
  // と同じ扱い)。
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/measurement-health",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        const response = await fetchMeasurementHealth(pool, tenantId, period);
        // スキーマ整合はテナント固有ではなくR2C運用の情報なので、
        // fetchMeasurementHealth(全クエリが tenant_id で絞られる契約)には入れず、
        // ここで super_admin にだけ合成する。新エンドポイントは作らない。
        // 点火状態も同じ理由(テナント固有ではなくR2C運用の情報)で super_admin にだけ合成する。
        // H-7(GID 1217972930945091): Hermes提案の採択率も同じ理由(R2C運用の判断材料であり
        // テナント固有ではない)で super_admin にだけ合成する。
        // A2A-0i: 固定費(LemonSlice/LiveKit)クォータの消費率も同じ理由で super_admin にだけ合成する。
        // billingHealthMonitor(Slack通知)が使う計算ロジックと同じ関数を呼ぶ(集計を書き写さない)。
        // L0-4(Gate 0): hermes-dojo/hermes-vaultのselfcheckも同じ理由(R2C運用の判断材料)で
        // super_admin にだけ合成する。DBを叩かない純関数なので Promise.all には含めない。
        const [schemaHealth, ignitionStatus, hermesAcceptanceRate, fixedCostQuota] = isSuperAdmin
          ? await Promise.all([
              fetchSchemaHealth(pool),
              fetchIgnitionStatus(pool),
              fetchHermesAcceptanceRate(pool),
              fetchFixedCostQuotaStatus(pool, logger),
            ])
          : [undefined, undefined, undefined, undefined];
        const componentSelfcheck = isSuperAdmin ? getComponentSelfcheckResults() : undefined;
        return res.json(
          isSuperAdmin
            ? { ...response, schemaHealth, ignitionStatus, hermesAcceptanceRate, fixedCostQuota, componentSelfcheck }
            : response,
        );
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/measurement-health]", err);
        return res.status(500).json({ error: "計測ヘルスの取得に失敗しました" });
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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'tenant_id_missing',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataTenantId: !!su?.app_metadata?.tenant_id,
          hasUserMetadataTenantId: !!su?.user_metadata?.tenant_id,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_TENANT_INVALID',
        }, "Admin analytics access denied: tenant_id missing for non-super-admin");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }
      if (!(await checkAnalyticsPlanAccess(pool, res, isSuperAdmin, jwtTenantId))) return;

      try {
        // W2-4: チャットエージェント(get_analytics_trend)と同じ数値を返すため
        // summaryQueries.ts の fetchAnalyticsTrend に集約する(fetchAnalyticsSummaryと同じ理由)。
        const response = await fetchAnalyticsTrend({ db: pool, tenantId, period });
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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'tenant_id_missing',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataTenantId: !!su?.app_metadata?.tenant_id,
          hasUserMetadataTenantId: !!su?.user_metadata?.tenant_id,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_TENANT_INVALID',
        }, "Admin analytics access denied: tenant_id missing for non-super-admin");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const interval = periodToInterval(period);
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }
      if (!(await checkAnalyticsPlanAccess(pool, res, isSuperAdmin, jwtTenantId))) return;

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
           ${userSourceExists("conversation_evaluations.session_id", "conversation_evaluations.tenant_id")}
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
           ${tenantClause}
           ${userSourceExists("conversation_evaluations.session_id", "conversation_evaluations.tenant_id")}`,
          params,
        );

        // W2-4: チャットエージェント(get_analytics_trend)と同じ数値を返すため
        // summaryQueries.ts の fetchLowScoreSessions に集約する(limit=10は既存挙動のまま)。
        const lowScoreSessions = await fetchLowScoreSessions({ db: pool, tenantId, period }, 10);

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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'tenant_id_missing',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataTenantId: !!su?.app_metadata?.tenant_id,
          hasUserMetadataTenantId: !!su?.user_metadata?.tenant_id,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_TENANT_INVALID',
        }, "Admin analytics access denied: tenant_id missing for non-super-admin");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const period = (req.query["period"] as string | undefined) ?? "30d";
      const tenantId = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }
      if (!(await checkAnalyticsPlanAccess(pool, res, isSuperAdmin, jwtTenantId, "conversion"))) return;

      try {
        const responseData = await fetchConversionSummary({ db: pool, tenantId, period });
        const { total_sessions: total, recorded_outcomes: recorded } = responseData.summary;
        const conversionRateTrend = responseData.conversion_rate_trend;
        const techniqueEffectiveness = responseData.technique_effectiveness;

        // Phase52h: Triggers 6/7/8 — コンバージョン通知（fire-and-forget）
        // 集計本体(summaryQueries.ts)には移さない。チャットの get_conversion_summary から
        // 同じ集計を呼んだときに管理者通知が発火してしまうため。
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

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/cv-status  (Phase65-3: super_admin only)
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/cv-status",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      const isSuperAdmin: boolean = actorRole === "super_admin";

      if (!isSuperAdmin) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'insufficient_role',
          actorRole,
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INSUFFICIENT',
        }, "Admin analytics access denied: super_admin required");
        return res.status(403).json({ error: "アクセス権限がありません", code: 'AUTH_ROLE_INSUFFICIENT' });
      }

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        const result = await pool.query(
          `SELECT
             t.id AS tenant_id,
             t.name AS tenant_name,
             COALESCE(ca_stats.cv_count, 0)::int AS cv_count_30d,
             ca_stats.last_cv_at,
             EXTRACT(DAYS FROM (NOW() - COALESCE(cs_min.first_session_at, t.created_at)))::int
               AS days_since_effective_start
           FROM tenants t
           LEFT JOIN (
             SELECT
               tenant_id,
               COUNT(*)::int AS cv_count,
               MAX(created_at) AS last_cv_at
             FROM conversion_attributions
             WHERE created_at > NOW() - INTERVAL '30 days'
               ${userSourceExists("conversion_attributions.session_id", "conversion_attributions.tenant_id", "id")}
             GROUP BY tenant_id
           ) ca_stats ON ca_stats.tenant_id = t.id
           LEFT JOIN (
             SELECT tenant_id, MIN(started_at) AS first_session_at
             FROM chat_sessions
             GROUP BY tenant_id
           ) cs_min ON cs_min.tenant_id = t.id
           WHERE t.is_active = true
           ORDER BY cv_count_30d ASC, days_since_effective_start DESC`,
        );

        type CvRow = {
          tenant_id: string;
          tenant_name: string;
          cv_count_30d: number;
          last_cv_at: Date | null;
          days_since_effective_start: number;
        };

        const tenants = (result.rows as CvRow[]).map((row) => ({
          tenant_id: row.tenant_id,
          tenant_name: row.tenant_name,
          cv_count_30d: row.cv_count_30d,
          cv_fired_status: (row.cv_count_30d > 0 ? 'fired' : 'not_fired') as 'fired' | 'not_fired',
          days_since_effective_start: row.days_since_effective_start,
          last_cv_at: row.last_cv_at
            ? row.last_cv_at instanceof Date
              ? row.last_cv_at.toISOString()
              : String(row.last_cv_at)
            : null,
        }));

        const firedTenants = tenants.filter((t) => t.cv_fired_status === 'fired').length;

        return res.json({
          total_tenants: tenants.length,
          fired_tenants: firedTenants,
          not_fired_tenants: tenants.length - firedTenants,
          tenants,
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/cv-status]", err);
        return res.status(500).json({ error: "CV発火状況の取得に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/knowledge-attribution
  // Phase68: ナレッジ別 CV 影響度集計
  //   - tenant_id 必須（super_admin は query、client_admin は JWT 強制）
  //   - period: 7d | 30d | 90d（デフォルト 30d）
  //   - source_type: all | faq | book（デフォルト all）
  //   - sort_by: conversion_rate | usage_count | judge_score（デフォルト conversion_rate）
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/knowledge-attribution",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'tenant_id_missing',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataTenantId: !!su?.app_metadata?.tenant_id,
          hasUserMetadataTenantId: !!su?.user_metadata?.tenant_id,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_TENANT_INVALID',
        }, "Admin analytics access denied: tenant_id missing for non-super-admin");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      // RBAC: client_admin は JWT の tenantId を強制、super_admin は query ?tenant_id=
      const tenantId: string | undefined = isSuperAdmin
        ? ((req.query["tenant_id"] as string | undefined) || undefined)
        : (jwtTenantId || undefined);

      if (!tenantId) {
        return res.status(400).json({
          error: isSuperAdmin
            ? "tenant_id クエリパラメータが必要です"
            : "テナントIDが解決できません",
        });
      }

      const period = ((req.query["period"] as string | undefined) ?? "30d");

      const sourceTypeRaw = (req.query["source_type"] as string | undefined) ?? "all";
      const sourceType: "all" | "faq" | "book" =
        sourceTypeRaw === "faq" || sourceTypeRaw === "book" ? sourceTypeRaw : "all";

      const sortByRaw = (req.query["sort_by"] as string | undefined) ?? "conversion_rate";
      const validSortBy = ["conversion_rate", "usage_count", "judge_score"] as const;
      const sortBy: typeof validSortBy[number] = validSortBy.includes(
        sortByRaw as typeof validSortBy[number],
      )
        ? (sortByRaw as typeof validSortBy[number])
        : "conversion_rate";

      const limitRaw = parseInt((req.query["limit"] as string | undefined) ?? "50", 10);
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200));

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }
      // 2026-08-29: ナレッジ別CV貢献度は成果分析(conversion, Growth〜)の一部。
      // /admin/knowledge/:tenantId(RequireAuth、super_admin限定ではない)の
      // 「貢献分析」タブから client_admin も到達するため、gateが抜けていた。
      if (!(await checkAnalyticsPlanAccess(pool, res, isSuperAdmin, jwtTenantId, "conversion"))) return;

      try {
        // summaryQueries.ts の fetchKnowledgeAttribution に集約する(fetchAnalyticsTrendと同じ理由)。
        const { items, summary } = await fetchKnowledgeAttribution(
          { db: pool, tenantId, period },
          sourceType,
          limit,
          sortBy,
        );

        return res.json({
          period,
          tenant_id: tenantId,
          source_type: sourceType,
          sort_by: sortBy,
          items,
          summary,
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/knowledge-attribution]", err);
        return res
          .status(500)
          .json({ error: "ナレッジ貢献度の集計に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/rule-effect/:ruleId
  // GID 1216978677398163 (PR-14): tuning_rules 承認の効果測定（DiD比較 + 母数ゲート）
  //   - client_admin: 自テナントのルールのみ(他テナントは404で存在有無を漏らさない)
  //   - super_admin: 任意テナントのルールを閲覧可能
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/rule-effect/:ruleId",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      const isSuperAdmin: boolean = actorRole === "super_admin";
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const ruleId = parseInt(req.params["ruleId"] ?? "", 10);
      if (!Number.isFinite(ruleId)) {
        return res.status(400).json({ error: "ruleId が不正です" });
      }

      if (!pool) {
        return res.status(500).json({ error: "データベース接続が利用できません" });
      }
      // 2026-08-29: ルール効果測定も成果分析(conversion, Growth〜)の一部。
      // getRuleEffect自体はHermes(GET /v1/hermes-mcp/proposals、hermesMcpAuthMiddleware配下)
      // からも直接呼ばれるため、gateはこのHTTPルート側にのみ置く(getRuleEffect内には入れない)。
      if (!(await checkAnalyticsPlanAccess(pool, res, isSuperAdmin, jwtTenantId, "conversion"))) return;

      try {
        const result = await getRuleEffect(pool, ruleId);

        if (result.status === "rule_not_found") {
          return res.status(404).json({ error: "指定されたルールが見つかりません" });
        }

        // 越境防止: client_admin は自テナント以外のルールを見られない。
        // 「存在しない」場合と同一の404にし、他テナントのルールIDの存在有無を漏らさない。
        if (!isSuperAdmin && result.tenantId !== jwtTenantId) {
          return res.status(404).json({ error: "指定されたルールが見つかりません" });
        }

        if (result.status === "not_yet_approved") {
          return res.status(200).json({
            rule_id: ruleId,
            status: "not_yet_approved",
            message: "このルールはまだ承認されていません。承認後に効果測定が可能になります。",
          });
        }

        if (result.status === "insufficient_data") {
          return res.status(200).json({
            rule_id: ruleId,
            status: "insufficient_data",
            approved_at: result.approvedAt,
            min_sample_size: result.minSampleSize,
            progress: result.progress.map((p) => ({
              group: p.group,
              current_n: p.currentN,
              required_n: p.requiredN,
              eta_days: p.etaDays,
            })),
            truncated: result.truncated,
            analyzed_sessions: result.analyzedSessions,
          });
        }

        return res.status(200).json({
          rule_id: ruleId,
          status: "ok",
          approved_at: result.approvedAt,
          comparison: result.comparison,
          truncated: result.truncated,
          analyzed_sessions: result.analyzedSessions,
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/rule-effect]", err);
        return res.status(500).json({ error: "ルール効果測定の集計に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/avatar-settings-summary  (Phase72-B: super_admin only)
  // アバター設定利用率の横断集計
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/avatar-settings-summary",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'insufficient_role',
          actorRole,
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          errorCode: 'AUTH_ROLE_INSUFFICIENT',
        }, "Admin analytics access denied: super_admin required");
        return res.status(403).json({ error: "アクセス権限がありません", code: 'AUTH_ROLE_INSUFFICIENT' });
      }

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      try {
        // メイン集計: CTE で一括計算
        const summaryResult = await pool.query(
          `WITH base AS (
             SELECT
               COUNT(DISTINCT tenant_id) AS total_tenants,
               COUNT(DISTINCT CASE WHEN is_active = true THEN tenant_id END) AS tenants_with_avatar,
               COUNT(*) AS total_configs,
               COUNT(CASE WHEN agent_idle_prompt IS NOT NULL AND agent_idle_prompt != '' THEN 1 END) AS idle_prompt_count,
               COUNT(CASE WHEN personality_prompt IS NOT NULL AND personality_prompt != '' THEN 1 END) AS custom_prompt_count,
               COUNT(CASE WHEN voice_id IS NOT NULL AND voice_id != '' THEN 1 END) AS custom_voice_count
             FROM avatar_configs
           )
           SELECT
             total_tenants,
             tenants_with_avatar,
             total_configs,
             CASE WHEN total_configs > 0
               THEN ROUND(idle_prompt_count::numeric / NULLIF(total_configs, 0) * 100, 1)
               ELSE NULL
             END AS idle_prompt_configured_rate,
             CASE WHEN total_configs > 0
               THEN ROUND(custom_prompt_count::numeric / NULLIF(total_configs, 0) * 100, 1)
               ELSE NULL
             END AS custom_prompt_rate,
             CASE WHEN total_configs > 0
               THEN ROUND(custom_voice_count::numeric / NULLIF(total_configs, 0) * 100, 1)
               ELSE NULL
             END AS custom_voice_rate
           FROM base`
        );

        // プロバイダ分布
        const providerResult = await pool.query(
          `SELECT
             COALESCE(avatar_provider, 'unknown') AS provider,
             COUNT(*)::int AS count
           FROM avatar_configs
           GROUP BY avatar_provider
           ORDER BY count DESC`
        );

        // テンプレートトップ10 (lemonslice_agent_id別)
        const top10Result = await pool.query(
          `SELECT
             lemonslice_agent_id AS id,
             name,
             COUNT(*)::int AS count
           FROM avatar_configs
           WHERE lemonslice_agent_id IS NOT NULL AND lemonslice_agent_id != ''
           GROUP BY lemonslice_agent_id, name
           ORDER BY count DESC
           LIMIT 10`
        );

        const row = summaryResult.rows[0];

        return res.json({
          total_tenants: Number(row?.total_tenants ?? 0),
          tenants_with_avatar: Number(row?.tenants_with_avatar ?? 0),
          idle_prompt_configured_rate: row?.idle_prompt_configured_rate != null
            ? Number(row.idle_prompt_configured_rate)
            : null,
          custom_prompt_rate: row?.custom_prompt_rate != null
            ? Number(row.custom_prompt_rate)
            : null,
          custom_voice_rate: row?.custom_voice_rate != null
            ? Number(row.custom_voice_rate)
            : null,
          avatar_provider_distribution: providerResult.rows.map((r: any) => ({
            provider: r.provider as string,
            count: r.count as number,
          })),
          template_id_top10: top10Result.rows.map((r: any) => ({
            id: r.id as string,
            name: r.name as string | null,
            count: r.count as number,
          })),
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/avatar-settings-summary]", err);
        return res.status(500).json({ error: "アバター設定の集計に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/metrics-history  (Phase72-D: super_admin only)
  // query: metric (required), period (1d|7d|30d, default 7d),
  //        tenant_id (optional), granularity (1h|6h|24h, default 1h)
  // -------------------------------------------------------------------------
  const VALID_METRICS = new Set([
    "rajiuce_conversation_terminal_total",
    "rajiuce_loop_detected_total",
    "rajiuce_avatar_requests_total",
    "rajiuce_rag_duration_ms",
    // オンボ 是正B-2: onboarding_stage_reached(P1で定義した計測契約)が
    // metrics_snapshots に発火するだけで、どの画面からも参照できない状態だった。
    "onboarding_stage_reached",
  ] as const);

  const VALID_GRANULARITIES: Record<string, string> = {
    "1h": "hour",
    "6h": "6 hours",
    "24h": "day",
  };

  const PERIOD_INTERVALS: Record<string, string> = {
    "1d": "1 day",
    "7d": "7 days",
    "30d": "30 days",
  };

  app.get(
    "/v1/admin/analytics/metrics-history",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: "AUTH_ROLE_INVALID" });
      }
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin) {
        return res.status(403).json({ error: "アクセス権限がありません", code: "AUTH_ROLE_INSUFFICIENT" });
      }
      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      const metricRaw = req.query["metric"] as string | undefined;
      if (!metricRaw || !VALID_METRICS.has(metricRaw as any)) {
        return res.status(400).json({
          error: "metric パラメータが必要です。有効な値: rajiuce_conversation_terminal_total, rajiuce_loop_detected_total, rajiuce_avatar_requests_total, rajiuce_rag_duration_ms, onboarding_stage_reached",
        });
      }
      const metric = metricRaw;

      const periodRaw = (req.query["period"] as string | undefined) ?? "7d";
      const periodInterval = PERIOD_INTERVALS[periodRaw] ?? "7 days";

      const granularityRaw = (req.query["granularity"] as string | undefined) ?? "1h";
      const dateTruncUnit = VALID_GRANULARITIES[granularityRaw];
      if (!dateTruncUnit) {
        return res.status(400).json({ error: "granularity は 1h, 6h, 24h のいずれかを指定してください" });
      }

      const tenantIdFilter = req.query["tenant_id"] as string | undefined;

      try {
        const params: (string | number)[] = [metric, periodInterval];
        const tenantClause = tenantIdFilter
          ? `AND tenant_id = $${params.push(tenantIdFilter)}`
          : "";

        const result = await pool.query(
          `SELECT
             DATE_TRUNC($4, snapshot_at) AS timestamp,
             SUM(value)::float AS value,
             labels
           FROM metrics_snapshots
           WHERE metric_name = $1
             AND snapshot_at > NOW() - $2::interval
             ${tenantClause}
           GROUP BY DATE_TRUNC($4, snapshot_at), labels
           ORDER BY timestamp ASC`,
          [...params, dateTruncUnit],
        );

        type SnapshotRow = {
          timestamp: Date;
          value: number;
          labels: Record<string, string | number>;
        };

        const series = (result.rows as SnapshotRow[]).map((row) => ({
          timestamp: row.timestamp instanceof Date
            ? row.timestamp.toISOString()
            : String(row.timestamp),
          value: row.value,
          labels: row.labels ?? {},
        }));

        return res.json({
          metric,
          period: periodRaw,
          granularity: granularityRaw,
          series,
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/metrics-history]", err);
        return res.status(500).json({ error: "メトリクス履歴の取得に失敗しました" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/analytics/flow-transitions  (Phase72-C: super_admin only)
  // query: period=7d|30d|90d (default 30d), tenant_id (super_admin filter)
  // -------------------------------------------------------------------------
  app.get(
    "/v1/admin/analytics/flow-transitions",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Flow-transitions access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      const isSuperAdmin: boolean = actorRole === "super_admin";

      if (!isSuperAdmin) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'insufficient_role',
          actorRole,
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          errorCode: 'AUTH_ROLE_INSUFFICIENT',
        }, "Flow-transitions access denied: super_admin required");
        return res.status(403).json({ error: "アクセス権限がありません", code: 'AUTH_ROLE_INSUFFICIENT' });
      }

      if (!pool) {
        return res.status(503).json({ error: "データベース接続が利用できません" });
      }

      // whitelist period to avoid SQL injection
      const ALLOWED_PERIODS = ['7d', '30d', '90d'] as const;
      type AllowedPeriod = typeof ALLOWED_PERIODS[number];
      const rawPeriod = typeof req.query['period'] === 'string' ? req.query['period'] : '30d';
      const period: AllowedPeriod = (ALLOWED_PERIODS as readonly string[]).includes(rawPeriod)
        ? (rawPeriod as AllowedPeriod)
        : '30d';

      const tenantFilter = typeof req.query['tenant_id'] === 'string' && req.query['tenant_id'].trim()
        ? req.query['tenant_id'].trim()
        : null;

      const periodDays = period === '7d' ? 7 : period === '90d' ? 90 : 30;

      try {
        const result = await pool.query(
          `SELECT
             from_state,
             to_state,
             COUNT(*)::int AS transition_count
           FROM conversation_flow_logs
           WHERE logged_at > NOW() - ($1::int * INTERVAL '1 day')
             AND ($2::text IS NULL OR tenant_id = $2)
           GROUP BY from_state, to_state
           ORDER BY transition_count DESC`,
          [periodDays, tenantFilter],
        );

        type TransitionRow = {
          from_state: string | null;
          to_state: string;
          transition_count: number;
        };

        const transitions = (result.rows as TransitionRow[]).map((row) => ({
          from_state: row.from_state,
          to_state: row.to_state,
          transition_count: row.transition_count,
        }));

        const totalRows = transitions.reduce((sum, r) => sum + r.transition_count, 0);
        const toTerminal = transitions.filter((r) => r.to_state === 'terminal').reduce((sum, r) => sum + r.transition_count, 0);
        const toConfirm = transitions.filter((r) => r.to_state === 'confirm').reduce((sum, r) => sum + r.transition_count, 0);
        const toAnswer = transitions.filter((r) => r.to_state === 'answer').reduce((sum, r) => sum + r.transition_count, 0);

        const completedResult = await pool.query(
          `SELECT COUNT(*)::int AS cnt
           FROM conversation_flow_logs
           WHERE logged_at > NOW() - ($1::int * INTERVAL '1 day')
             AND ($2::text IS NULL OR tenant_id = $2)
             AND to_state = 'terminal'
             AND metadata->>'reason' = 'completed'`,
          [periodDays, tenantFilter],
        );
        const completedCount: number = (completedResult.rows[0] as { cnt: number })?.cnt ?? 0;

        const safeRate = (n: number, d: number): number =>
          d === 0 ? 0 : Math.round((n / d) * 10000) / 100;

        return res.json({
          period,
          tenant_id: tenantFilter,
          total_transitions: totalRows,
          funnel: {
            to_answer_count: toAnswer,
            to_confirm_count: toConfirm,
            to_terminal_count: toTerminal,
            completed_count: completedCount,
            confirm_rate_pct: safeRate(toConfirm, totalRows),
            completion_rate_pct: safeRate(completedCount, toTerminal),
          },
          transitions,
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/analytics/flow-transitions]", err);
        return res.status(500).json({ error: "フロー遷移の集計に失敗しました" });
      }
    },
  );
}
