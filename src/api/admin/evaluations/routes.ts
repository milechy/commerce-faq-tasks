// src/api/admin/evaluations/routes.ts
// Phase45: 評価API + KPI API（Stream A）

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { superAdminMiddleware } from "../tenants/superAdminMiddleware";
import {
  listEvaluations,
  getDetailedStats,
  getEvaluationsBySession,
  updateOutcome,
  getKpiStats,
  approveTuningRule,
  rejectTuningRule,
  getEvaluationById,
  checkAlreadyEvaluated,
  updateSuggestedRuleStatus,
  insertTuningRuleFromSuggestion,
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

    const rawMinScore = req.query["min_score"];
    const rawMaxScore = req.query["max_score"];
    const min_score = rawMinScore !== undefined ? Number(rawMinScore) : undefined;
    const max_score = rawMaxScore !== undefined ? Number(rawMaxScore) : undefined;

    try {
      const result = await listEvaluations({ tenantId, days, limit, offset, min_score, max_score });
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
  // POST /v1/admin/evaluations/trigger
  // 指定セッションの評価を手動トリガー（未評価の場合のみ）
  // -------------------------------------------------------------------------
  app.post("/v1/admin/evaluations/trigger", async (req: Request, res: Response) => {
    const { session_id } = (req.body ?? {}) as Record<string, unknown>;
    if (!session_id || typeof session_id !== "string") {
      return res.status(400).json({ error: "session_id is required" });
    }

    try {
      const alreadyDone = await checkAlreadyEvaluated(session_id);
      if (alreadyDone) {
        return res.status(409).json({ error: "already_evaluated" });
      }

      // Dynamic import to avoid circular deps
      const { evaluateSession } = await import("../../../agent/judge/judgeEvaluator");
      const result = await evaluateSession(session_id);
      if (!result) {
        return res.status(500).json({ error: "evaluation_failed" });
      }
      return res.json({ evaluation: result });
    } catch (err) {
      console.warn("[POST /v1/admin/evaluations/trigger]", err);
      return res.status(500).json({ error: "評価の実行に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/evaluations/by-id/:id
  // 数値 ID による評価詳細取得（メッセージ付き）
  // NOTE: /:sessionId の catch-all より前に登録する必要あり
  // -------------------------------------------------------------------------
  app.get("/v1/admin/evaluations/by-id/:id", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "id must be a positive integer" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const data = await getEvaluationById(id, tenantId);
      if (!data) {
        return res.status(404).json({ error: "評価データが見つかりません" });
      }
      return res.json(data);
    } catch (err) {
      console.warn("[GET /v1/admin/evaluations/by-id/:id]", err);
      return res.status(500).json({ error: "評価データの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/admin/evaluations/:id/rules/:ruleIndex
  // suggested_rules の approve / reject（super_admin 専用）
  // -------------------------------------------------------------------------
  app.patch(
    "/v1/admin/evaluations/:id/rules/:ruleIndex",
    supabaseAuthMiddleware,
    superAdminMiddleware,
    async (req: Request, res: Response) => {
      const { jwtTenantId, isSuperAdmin, email } = resolveAuth(req);
      const id = Number(req.params["id"]);
      const ruleIndex = Number(req.params["ruleIndex"]);
      const { action, edited_text } = (req.body ?? {}) as Record<string, unknown>;

      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "id must be positive integer" });
      }
      if (!Number.isFinite(ruleIndex) || ruleIndex < 0) {
        return res.status(400).json({ error: "ruleIndex must be non-negative integer" });
      }
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ error: "action must be approve or reject" });
      }
      if (edited_text !== undefined && (typeof edited_text !== "string" || edited_text.trim() === "")) {
        return res.status(400).json({ error: "edited_text must be a non-empty string" });
      }

      const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

      try {
        if (action === "approve") {
          // Fetch the evaluation to get the rule text
          const data = await getEvaluationById(id, tenantId);
          if (!data) {
            return res.status(404).json({ error: "評価データが見つかりません" });
          }
          const rules = (data.evaluation as any).suggested_rules as Array<{ rule_text?: string; status?: string }> | null;
          const rule = Array.isArray(rules) ? rules[ruleIndex] : undefined;
          if (!rule) {
            return res.status(404).json({ error: "指定されたルールが見つかりません" });
          }
          const ruleText = rule.rule_text ?? "";
          if (ruleText) {
            await insertTuningRuleFromSuggestion(data.evaluation.tenant_id, ruleText, {
              editedText: typeof edited_text === "string" ? edited_text : undefined,
              editedBy: email || undefined,
            });
          }
        }

        const updated = await updateSuggestedRuleStatus(
          id,
          ruleIndex,
          action === "approve" ? "approved" : "rejected",
          tenantId,
        );
        if (!updated) {
          return res.status(404).json({ error: "評価データが見つかりません" });
        }
        return res.json({ ok: true, evaluation: updated });
      } catch (err: unknown) {
        if (err instanceof RangeError) {
          return res.status(400).json({ error: err.message });
        }
        console.warn("[PATCH /v1/admin/evaluations/:id/rules/:ruleIndex]", err);
        return res.status(500).json({ error: "ルール更新に失敗しました" });
      }
    },
  );

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
