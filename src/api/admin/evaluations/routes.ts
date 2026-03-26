// src/api/admin/evaluations/routes.ts
// Phase45: 評価API + KPI API（Stream A）

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  listEvaluations,
  getDetailedStats,
  getEvaluationsBySession,
  updateOutcome,
  getKpiStats,
  approveTuningRule,
  rejectTuningRule,
} from "./evaluationsRepository";

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function resolveAuth(req: Request): { jwtTenantId: string; isSuperAdmin: boolean; email: string } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  return {
    jwtTenantId: su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "",
    isSuperAdmin: (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin",
    email: su?.email ?? "",
  };
}

function parseDays(raw: unknown, defaultVal: number): number {
  const n = parseInt(raw as string, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : defaultVal;
}

function parseLimit(raw: unknown): number {
  return Math.max(1, Math.min(parseInt(raw as string, 10) || 50, 200));
}

function parseOffset(raw: unknown): number {
  return Math.max(0, parseInt(raw as string, 10) || 0);
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const VALID_OUTCOMES = ["replied", "appointment", "lost", "unknown"] as const;

const outcomeSchema = z.object({
  outcome: z.enum(VALID_OUTCOMES),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerEvaluationRoutes(app: Express): void {
  app.use("/v1/admin/evaluations", supabaseAuthMiddleware);
  app.use("/v1/admin/tuning", supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/evaluations
  // クエリ: tenantId, days(デフォルト7), limit, offset
  // -------------------------------------------------------------------------
  app.get("/v1/admin/evaluations", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    // super_admin: ?tenantId= で絞り込み可 / client_admin: 自テナント強制
    const tenantId = isSuperAdmin
      ? ((req.query["tenantId"] as string | undefined) || undefined)
      : jwtTenantId || undefined;

    const days = parseDays(req.query["days"], 7);
    const limit = parseLimit(req.query["limit"]);
    const offset = parseOffset(req.query["offset"]);

    try {
      const result = await listEvaluations({ tenantId, days, limit, offset });
      return res.json(result);
    } catch (err) {
      console.warn("[GET /v1/admin/evaluations]", err);
      return res.status(500).json({ error: "評価データの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/evaluations/stats
  // クエリ: tenantId, days(デフォルト30)
  // -------------------------------------------------------------------------
  app.get("/v1/admin/evaluations/stats", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const tenantId = isSuperAdmin
      ? ((req.query["tenantId"] as string | undefined) || undefined)
      : jwtTenantId || undefined;

    const days = parseDays(req.query["days"], 30);

    try {
      const stats = await getDetailedStats(tenantId, days);
      return res.json(stats);
    } catch (err) {
      console.warn("[GET /v1/admin/evaluations/stats]", err);
      return res.status(500).json({ error: "統計データの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/evaluations/kpi-stats
  // クエリ: tenantId, days(デフォルト30)
  // -------------------------------------------------------------------------
  app.get("/v1/admin/evaluations/kpi-stats", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const tenantId = isSuperAdmin
      ? ((req.query["tenantId"] as string | undefined) || undefined)
      : jwtTenantId || undefined;

    const days = parseDays(req.query["days"], 30);

    try {
      const kpi = await getKpiStats(tenantId, days);
      return res.json(kpi);
    } catch (err) {
      console.warn("[GET /v1/admin/evaluations/kpi-stats]", err);
      return res.status(500).json({ error: "KPIデータの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/evaluations/:sessionId
  // セッション別評価詳細
  // NOTE: 静的パス (/stats, /kpi-stats) より後に登録する必要あり
  // -------------------------------------------------------------------------
  app.get("/v1/admin/evaluations/:sessionId", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);
    const sessionId = req.params["sessionId"] ?? "";

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId が必要です" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const evaluations = await getEvaluationsBySession(sessionId, tenantId);
      if (evaluations.length === 0) {
        return res.status(404).json({ error: "評価データが見つかりません" });
      }
      return res.json({ evaluations, total: evaluations.length });
    } catch (err) {
      console.warn("[GET /v1/admin/evaluations/:sessionId]", err);
      return res.status(500).json({ error: "評価データの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/evaluations/:id/outcome
  // Body: { outcome: 'replied' | 'appointment' | 'lost' | 'unknown' }
  // -------------------------------------------------------------------------
  app.put("/v1/admin/evaluations/:id/outcome", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin, email } = resolveAuth(req);

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const parsed = outcomeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "不正な営業結果です", details: parsed.error.issues });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;
    const updatedBy = email || "unknown";

    try {
      const updated = await updateOutcome(id, parsed.data.outcome, updatedBy, tenantId);
      if (!updated) {
        return res.status(404).json({ error: "評価データが見つかりません" });
      }
      return res.json({ ok: true, message: "営業結果を記録しました", evaluation: updated });
    } catch (err) {
      console.warn("[PUT /v1/admin/evaluations/:id/outcome]", err);
      return res.status(500).json({ error: "営業結果の更新に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/tuning/:id/approve
  // status → 'active', approved_at = NOW()
  // -------------------------------------------------------------------------
  app.put("/v1/admin/tuning/:id/approve", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const updated = await approveTuningRule(id, tenantId);
      if (!updated) {
        return res.status(404).json({ error: "チューニングルールが見つかりません" });
      }
      return res.json({ ok: true, rule: updated });
    } catch (err) {
      console.warn("[PUT /v1/admin/tuning/:id/approve]", err);
      return res.status(500).json({ error: "承認処理に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/tuning/:id/reject
  // status → 'rejected', rejected_at = NOW()
  // -------------------------------------------------------------------------
  app.put("/v1/admin/tuning/:id/reject", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const updated = await rejectTuningRule(id, tenantId);
      if (!updated) {
        return res.status(404).json({ error: "チューニングルールが見つかりません" });
      }
      return res.json({ ok: true, rule: updated });
    } catch (err) {
      console.warn("[PUT /v1/admin/tuning/:id/reject]", err);
      return res.status(500).json({ error: "却下処理に失敗しました" });
    }
  });
}
