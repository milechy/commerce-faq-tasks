// src/api/admin/variants/routes.ts

// Phase46: Variant CRUD API（Stream A）

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { listVariants, upsertVariants, getVariantStats } from "./variantsRepository";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function resolveAuth(req: Request): { jwtTenantId: string; isSuperAdmin: boolean } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  return {
    jwtTenantId: su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "",
    isSuperAdmin: (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin",
  };
}

function parseDays(raw: unknown, defaultVal: number): number {
  const n = parseInt(raw as string, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : defaultVal;
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const variantItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  weight: z.number().int().min(0).max(100),
});

const putVariantsSchema = z.object({
  tenantId: z.string().min(1),
  variants: z.array(variantItemSchema).min(1),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerVariantRoutes(app: Express): void {
  app.use("/v1/admin/variants", supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/variants?tenantId=xxx
  // -------------------------------------------------------------------------
  app.get("/v1/admin/variants", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);
    const queryTenantId = req.query["tenantId"] as string | undefined;

    if (!isSuperAdmin && queryTenantId && queryTenantId !== jwtTenantId) {
      return res.status(403).json({ error: "他テナントのデータにアクセスできません" });
    }

    const tenantId = isSuperAdmin ? (queryTenantId || jwtTenantId) : jwtTenantId;

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId が必要です" });
    }

    try {
      const variants = await listVariants(tenantId);
      return res.json({ variants });
    } catch (err) {
      logger.warn("[GET /v1/admin/variants]", err);
      return res.status(500).json({ error: "バリエーションの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/variants/stats?tenantId=xxx&days=30
  // NOTE: 静的パスなので PUT より先に登録
  // -------------------------------------------------------------------------
  app.get("/v1/admin/variants/stats", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);
    const queryTenantId = req.query["tenantId"] as string | undefined;

    if (!isSuperAdmin && queryTenantId && queryTenantId !== jwtTenantId) {
      return res.status(403).json({ error: "他テナントのデータにアクセスできません" });
    }

    const tenantId = isSuperAdmin ? (queryTenantId || jwtTenantId) : jwtTenantId;

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId が必要です" });
    }

    const days = parseDays(req.query["days"], 30);

    try {
      const variants = await getVariantStats(tenantId, days);
      return res.json({ variants });
    } catch (err) {
      logger.warn("[GET /v1/admin/variants/stats]", err);
      return res.status(500).json({ error: "バリエーション統計の取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/variants
  // Body: { tenantId, variants: [{ id, name, prompt, weight }] }
  // バリデーション: weightの合計が100であること
  // -------------------------------------------------------------------------
  app.put("/v1/admin/variants", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const parsed = putVariantsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "リクエストの形式が正しくありません", details: parsed.error.issues });
    }

    const { tenantId, variants } = parsed.data;

    if (!isSuperAdmin && tenantId !== jwtTenantId) {
      return res.status(403).json({ error: "他テナントのデータを更新できません" });
    }

    const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
    if (totalWeight !== 100) {
      return res.status(400).json({ error: "バリエーションの比率の合計は100%にしてください" });
    }

    try {
      const updated = await upsertVariants(tenantId, variants);
      return res.json({ ok: true, variants: updated });
    } catch (err) {
      logger.warn("[PUT /v1/admin/variants]", err);
      return res.status(500).json({ error: "バリエーションの更新に失敗しました" });
    }
  });
}
