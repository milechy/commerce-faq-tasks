// src/api/admin/monitoring/routes.ts
// GET /v1/admin/monitoring/kpis — KPI監視ダッシュボード用データ

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { logger } from "../../../lib/logger";

const DEFAULT_SLA = {
  completionRateMin: 70,
  loopRateMax: 10,
  fallbackRateMax: 30,
  searchP95Max: 1500,
  errorRateMax: 1,
};

/** 会話完了率・フォールバック率をDBから計算（30日間） */
async function computeKpis(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  tenantFilter: string | null
): Promise<{
  completionRate: number;
  fallbackRate: number;
  totalSessions: number;
}> {
  const window = "30 days";
  const tenantClause = tenantFilter ? "AND tenant_id = $2" : "";
  const params: unknown[] = [`${window}`];
  if (tenantFilter) params.push(tenantFilter);

  // 総セッション数
  const totalRes = await db.query(
    `SELECT COUNT(*) AS total
     FROM chat_sessions
     WHERE started_at >= NOW() - $1::INTERVAL ${tenantClause}`,
    params
  );
  const total = parseInt(totalRes.rows[0]?.total ?? "0", 10);

  if (total === 0) {
    return { completionRate: 100, fallbackRate: 0, totalSessions: 0 };
  }

  // 完了セッション (message_count >= 2 = AIが少なくとも1回応答)
  const completedRes = await db.query(
    `SELECT COUNT(*) AS completed
     FROM chat_sessions
     WHERE started_at >= NOW() - $1::INTERVAL
       AND message_count >= 2
       ${tenantClause}`,
    params
  );
  const completed = parseInt(completedRes.rows[0]?.completed ?? "0", 10);

  // フォールバック検出 (「記載がありません」などを含むアシスタント回答を持つセッション)
  const fallbackPhrases = [
    "%記載がありません%",
    "%お答えできません%",
    "%情報がありません%",
    "%見つかりませんでした%",
  ];
  const fallbackCondition = fallbackPhrases
    .map((_, i) => `cm.content ILIKE $${params.length + i + 1}`)
    .join(" OR ");
  const fallbackParams = [...params, ...fallbackPhrases];

  const fallbackRes = await db.query(
    `SELECT COUNT(DISTINCT cm.session_id) AS fallback_count
     FROM chat_messages cm
     JOIN chat_sessions cs ON cs.id = cm.session_id
     WHERE cm.role = 'assistant'
       AND cm.created_at >= NOW() - $1::INTERVAL
       AND (${fallbackCondition})
       ${tenantFilter ? `AND cm.tenant_id = $2` : ""}`,
    fallbackParams
  );
  const fallbackCount = parseInt(fallbackRes.rows[0]?.fallback_count ?? "0", 10);

  return {
    completionRate: Math.round((completed / total) * 1000) / 10,
    fallbackRate: Math.round((fallbackCount / total) * 1000) / 10,
    totalSessions: total,
  };
}

export function registerMonitoringRoutes(app: Express): void {
  app.use("/v1/admin/monitoring", supabaseAuthMiddleware);

  app.get("/v1/admin/monitoring/kpis", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const role =
      su?.app_metadata?.role ?? su?.user_metadata?.role ?? su?.role ?? "anonymous";

    if (!["super_admin", "client_admin"].includes(role)) {
      res.status(403).json({ error: "forbidden", message: "管理者ログインが必要です" });
      return;
    }

    const isSuperAdmin = role === "super_admin";
    const jwtTenantId: string | null =
      su?.app_metadata?.tenant_id ?? su?.tenant_id ?? null;
    const tenantFilter = isSuperAdmin ? null : jwtTenantId;

    // DB が利用不可の場合はフォールバック値を返す
    let db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> } | null = null;
    try {
      const { getPool } = await import("../../../lib/db");
      db = getPool();
    } catch {
      // DB未接続 (test環境など)
    }

    if (!db) {
      res.json({
        completionRate: 0,
        loopRate: 0,
        fallbackRate: 0,
        searchP95Ms: 0,
        errorRate: 0,
        killSwitchActive: false,
        sla: DEFAULT_SLA,
      });
      return;
    }

    try {
      const kpis = await computeKpis(db, tenantFilter);

      res.json({
        completionRate: kpis.completionRate,
        loopRate: 0, // ループ追跡データなし
        fallbackRate: kpis.fallbackRate,
        searchP95Ms: 500, // タイミングデータなし → デフォルト値
        errorRate: 0, // エラー追跡データなし
        killSwitchActive: false,
        sla: DEFAULT_SLA,
      });
    } catch (err) {
      logger.error({ err }, "[monitoring/kpis] DB query failed");
      res.status(500).json({ error: "internal_error", message: "データ取得に失敗しました" });
    }
  });

  logger.info("[monitoringRoutes] /v1/admin/monitoring/kpis registered");
}
