import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import type { AuthedReq } from "../../middleware/roleAuth";
import { getMonthlyLLMUsageFromPostHog } from "../../../lib/billing/posthogUsageTracker";
import { logger } from "../../../lib/logger";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { userSourceClause, userSourceExists } from "../analytics/summaryQueries";
import { planHasFeature, queryTenantPlanOrThrow } from "../../../lib/billing/planFeatures";

const PERIOD_DAYS: Record<string, number> = {
  last_7d: 7,
  last_30d: 30,
  last_90d: 90,
};

export function registerAnalyticsSummaryRoutes(app: Express, db: Pool): void {
  // JWT検証は共有実装(src/admin/http/supabaseAuthMiddleware.ts)に一本化。
  const tenantAuth = supabaseAuthMiddleware;

  function canAccessTenant(req: Request, res: Response, tenantId: string, next: NextFunction): void {
    const su = (req as AuthedReq).supabaseUser;
    // セキュリティ要件: 認可ロールは app_metadata.role のみを信頼する
    // user_metadata はクライアント編集可能なため、特権判定に使用してはならない
    const rawRole = su?.app_metadata?.role;
    const role = typeof rawRole === "string" ? rawRole : "";
    const jwtTenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (role === "super_admin" || jwtTenantId === tenantId) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  }

  // GET /v1/admin/tenants/:id/analytics-summary
  app.get(
    "/v1/admin/tenants/:id/analytics-summary",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const tenantId = req.params.id;
      const periodKey = (req.query.period as string) ?? "last_30d";
      const days = PERIOD_DAYS[periodKey] ?? 30;
      const interval = `${days} days`;

      // GID 1217969364194602 [H-7]: このタブが返す内容の大半(マクロ/マイクロCV内訳・
      // rank分布・source不一致アラート)は conversion_attributions 由来の「成果分析」で、
      // routes.ts の /v1/admin/analytics/conversions と同じ性質。あちらが conversion
      // (Growth〜)で据え置かれているのに、こちらにゲートが無いのは不整合だったため揃える。
      // super_adminバイパスは既存のcanAccessTenantの区別に合わせる。
      const su = (req as AuthedReq).supabaseUser;
      const isSuperAdmin = su?.app_metadata?.role === "super_admin";
      if (!isSuperAdmin) {
        // queryTenantPlanOrThrow を使う(queryTenantPlanではない): DB問い合わせ自体が
        // 例外を投げた場合にfree_adへ丸め込まれると、DB障害が「plan_upgrade_required」
        // (403)に化けてしまい、実際に起きているDB障害を隠してしまうため。
        let plan: string;
        try {
          plan = await queryTenantPlanOrThrow(db, tenantId);
        } catch (err) {
          logger.warn({ err, tenantId }, "[analyticsSummary] plan lookup failed");
          return res.status(500).json({ error: "analytics fetch failed" });
        }
        if (!planHasFeature(plan, "conversion")) {
          return res.status(403).json({
            error: "plan_upgrade_required",
            message: "成果分析はGrowthプラン以上でご利用いただけます",
          });
        }
      }

      try {
        const [
          conversationsRow,
          cvMacroRow,
          cvMicroRow,
          cvRankRow,
          alertRow,
        ] = await Promise.all([
          db.query<{ total: string; avg_per_day: string }>(
            `SELECT
               COUNT(*)::text AS total,
               -- COUNT(*)/float は double precision になるが、PostgreSQL の2引数 round() は
               -- numeric 版しか無く "function round(double precision, integer) does not exist"
               -- で落ちる。numeric へキャストしてから丸める。
               ROUND((COUNT(*) / GREATEST($2::float, 1))::numeric, 2)::text AS avg_per_day
             FROM chat_sessions
             WHERE tenant_id = $1
               -- chat_sessions に created_at は存在しない。セッション開始時刻は started_at
               -- (chat-history/migration.sql)。created_at を参照していたため
               -- GET /v1/admin/tenants/:id/analytics-summary が常時500だった。
               AND started_at >= NOW() - ($3::text)::interval
               ${userSourceClause("chat_sessions")}`,
            [tenantId, days, interval],
          ),
          // GID 1217810442450208: cvMacroRow/cvMicroRow/cvRankRow/alertRow の4クエリは
          // 同じハンドラ内の conversationsRow(userSourceClause("chat_sessions")適用済み)と
          // 異なり実ユーザー判定が無く、e2e/chat-test 由来の conversion_attributions を
          // 実CVと一緒に数えていた(P0-3・PR #954/#958と同根)。cv-status/crossTenantContext.ts
          // と同じ userSourceExists() で揃える。conversion_attributions.session_id は
          // chat_sessions.id(UUID)を参照するため第3引数は "id"。
          db.query<{ source: string; cnt: string }>(
            `SELECT source, COUNT(*)::text AS cnt
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND event_type = 'macro'
               AND created_at >= NOW() - ($2::text)::interval
               ${userSourceExists("conversion_attributions.session_id", "conversion_attributions.tenant_id", "id")}
             GROUP BY source`,
            [tenantId, interval],
          ),
          db.query<{ source: string; cnt: string }>(
            `SELECT source, COUNT(*)::text AS cnt
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND event_type = 'micro'
               AND created_at >= NOW() - ($2::text)::interval
               ${userSourceExists("conversion_attributions.session_id", "conversion_attributions.tenant_id", "id")}
             GROUP BY source`,
            [tenantId, interval],
          ),
          db.query<{ rank: string; cnt: string }>(
            `SELECT rank, COUNT(*)::text AS cnt
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND created_at >= NOW() - ($2::text)::interval
               ${userSourceExists("conversion_attributions.session_id", "conversion_attributions.tenant_id", "id")}
             GROUP BY rank`,
            [tenantId, interval],
          ),
          db.query<{ mismatch: string; ranked_d: string }>(
            `SELECT
               COUNT(CASE WHEN fired_count > 1 THEN 1 END)::text AS mismatch,
               COUNT(CASE WHEN rank = 'D' THEN 1 END)::text AS ranked_d
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND created_at >= NOW() - ($2::text)::interval
               ${userSourceExists("conversion_attributions.session_id", "conversion_attributions.tenant_id", "id")}`,
            [tenantId, interval],
          ),
        ]);

        const toNum = (s: string | undefined) => parseInt(s ?? "0", 10);

        const macroBySource = Object.fromEntries(
          cvMacroRow.rows.map((r) => [r.source, toNum(r.cnt)]),
        );
        const microBySource = Object.fromEntries(
          cvMicroRow.rows.map((r) => [r.source, toNum(r.cnt)]),
        );
        const rankDist = Object.fromEntries(
          cvRankRow.rows.map((r) => [r.rank, toNum(r.cnt)]),
        );

        // PostHog LLM usage (optional, non-blocking)
        // GID 1217969364194602 [H-7]: cost_jpy はPostHogの $ai_cost(LLM呼び出しの原価)を
        // 換算したものであり、テナントへの請求額ではない(costCalculator.ts の
        // MARGIN_MULTIPLIER 参照。請求は会話単位のプラン料金)。原価をテナント側
        // (client_admin)に見せると粗利率を開示することになるため super_admin 限定にする。
        //
        // GID 1217972417593917 [H-10] 2026-08-30: 一方でadmin-uiの課金画面
        // (BillingSummaryCards.tsx「LLMコスト（原価）」/ billing/index.tsx
        // 「コスト内訳（原価・USD概算）」)は全ロールに原価を表示している。これは
        // 不整合ではなく、原価を見せるかどうかを画面の目的で決めた結果(根拠は
        // costCalculator.ts の MARGIN_MULTIPLIER 定義部を参照)。課金画面は費用の
        // 事前明示が目的なので原価開示がその目的に沿うが、ここ(テナント分析タブ)は
        // 分析が目的の画面で原価はそこに紛れ込んでいただけ。どちらかに揃えて
        // 直さないこと。
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const llmUsage = isSuperAdmin
          ? await getMonthlyLLMUsageFromPostHog(tenantId, month).catch(() => null)
          : null;

        const alertData = alertRow.rows[0];

        return res.json({
          period: periodKey,
          conversations: {
            total: toNum(conversationsRow.rows[0]?.total),
            avg_per_day: parseFloat(conversationsRow.rows[0]?.avg_per_day ?? "0"),
          },
          cv: {
            macro: {
              r2c_db: macroBySource.r2c_db ?? 0,
              ga4: macroBySource.ga4 ?? 0,
              posthog: macroBySource.posthog ?? 0,
              ranked_a: rankDist.A ?? 0,
              ranked_d: rankDist.D ?? 0,
            },
            micro: {
              r2c_db: microBySource.r2c_db ?? 0,
              ga4: microBySource.ga4 ?? 0,
              posthog: microBySource.posthog ?? 0,
            },
          },
          llm_usage: llmUsage
            ? {
                tokens: llmUsage.totalInputTokens + llmUsage.totalOutputTokens,
                cost_jpy: Math.round(llmUsage.estimatedCostUsd * 150),
                generations: llmUsage.totalGenerations,
              }
            : null,
          alerts: {
            source_mismatch_count: toNum(alertData?.mismatch),
            ranked_d_count: toNum(alertData?.ranked_d),
          },
        });
      } catch (err) {
        logger.warn({ err, tenantId }, "[analyticsSummary] failed");
        return res.status(500).json({ error: "analytics fetch failed" });
      }
    },
  );
}
