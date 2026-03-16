// src/api/admin/tuning/routes.ts
// Phase38 Step4-BE: チューニングルール CRUD API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} from "./tuningRulesRepository";

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const createSchema = z.object({
  tenant_id: z.string().min(1).max(100),
  trigger_pattern: z.string().min(1).max(1000),
  expected_behavior: z.string().min(1).max(4000),
  priority: z.number().int().min(-100).max(100).optional(),
  source_message_id: z.number().int().positive().nullable().optional(),
});

const updateSchema = z.object({
  trigger_pattern: z.string().min(1).max(1000).optional(),
  expected_behavior: z.string().min(1).max(4000).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerTuningRoutes(app: Express): void {
  app.use("/v1/admin/tuning-rules", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // GET /v1/admin/tuning-rules
  // -----------------------------------------------------------------------
  app.get("/v1/admin/tuning-rules", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

    // super_admin: ?tenant= で絞り込み可（未指定 = 全テナント）
    // client_admin: 自テナント固有 + global のみ
    const tenantFilter: string | undefined = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || undefined)
      : jwtTenantId || undefined;

    try {
      const rules = await listRules(tenantFilter);
      return res.json({ rules, total: rules.length });
    } catch (err) {
      console.warn("[GET /v1/admin/tuning-rules]", err);
      return res.status(500).json({ error: "ルール一覧の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning-rules
  // -----------------------------------------------------------------------
  app.post("/v1/admin/tuning-rules", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";
    const jwtEmail: string = su?.email ?? "";

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { tenant_id, trigger_pattern, expected_behavior, priority, source_message_id } =
      parsed.data;

    // client_admin は自テナント以外 (global 含む) に作成不可
    if (!isSuperAdmin && tenant_id !== jwtTenantId) {
      return res.status(403).json({
        error: "他テナントまたはglobalルールは作成できません",
      });
    }

    try {
      const rule = await createRule({
        tenant_id,
        trigger_pattern,
        expected_behavior,
        priority,
        created_by: jwtEmail || undefined,
        source_message_id: source_message_id ?? null,
      });
      return res.status(201).json(rule);
    } catch (err) {
      console.warn("[POST /v1/admin/tuning-rules]", err);
      return res.status(500).json({ error: "ルールの作成に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /v1/admin/tuning-rules/:id
  // -----------------------------------------------------------------------
  app.put(
    "/v1/admin/tuning-rules/:id",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "idが不正です" });
      }

      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      // super_admin はテナント制限なし
      const ownerFilter = isSuperAdmin ? undefined : jwtTenantId;

      try {
        const updated = await updateRule(id, parsed.data, ownerFilter);
        if (!updated) {
          return res
            .status(404)
            .json({ error: "ルールが見つからないかアクセス権限がありません" });
        }
        return res.json(updated);
      } catch (err) {
        console.warn("[PUT /v1/admin/tuning-rules/:id]", err);
        return res.status(500).json({ error: "ルールの更新に失敗しました" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/tuning-rules/:id
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/tuning-rules/:id",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "idが不正です" });
      }

      // super_admin はテナント制限なし、client_admin は自テナントのみ
      const ownerFilter = isSuperAdmin ? undefined : jwtTenantId;

      try {
        const deleted = await deleteRule(id, ownerFilter);
        if (!deleted) {
          return res
            .status(404)
            .json({ error: "ルールが見つからないかアクセス権限がありません" });
        }
        return res.json({ ok: true, id });
      } catch (err) {
        console.warn("[DELETE /v1/admin/tuning-rules/:id]", err);
        return res.status(500).json({ error: "ルールの削除に失敗しました" });
      }
    },
  );
}
