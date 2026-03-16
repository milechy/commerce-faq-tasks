// src/api/admin/tenants/routes.ts
import type { Express, NextFunction, Request, Response } from "express";
// @ts-ignore
import { Pool } from "pg";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { registerTenant } from "../../../lib/tenant-context";
import { generateApiKey, hashApiKey, maskApiKeyPrefix } from "./apiKeyUtils";
import { supabaseAdmin } from "../../../auth/supabaseClient";

const planValues = ["starter", "growth", "enterprise"] as const;

const createTenantSchema = z.object({
  id: z.string().min(3).max(50).regex(/^[a-z0-9_-]+$/, "IDは英小文字・数字・ハイフン・アンダースコアのみ"),
  name: z.string().min(1).max(100),
  plan: z.enum(planValues).default("starter"),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  plan: z.enum(planValues).optional(),
  is_active: z.boolean().optional(),
  allowed_origins: z
    .array(
      z.string().regex(/^https:\/\//, "URLはhttps://で始まる必要があります")
    )
    .max(20)
    .optional(),
  // Phase38 Step6: テナント固有システムプロンプト（空文字でリセット可）
  system_prompt: z.string().max(5000).optional(),
});

export function registerTenantAdminRoutes(app: Express, db: Pool): void {
  // ── インライン認証スタック（knowledge/routes.ts と同パターン） ──────────────
  function tenantAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization ?? "";

    if (process.env.NODE_ENV === "development") {
      if (authHeader.startsWith("Bearer ")) {
        try {
          (req as any).supabaseUser = jwt.decode(authHeader.slice(7).trim());
        } catch {
          // decode失敗は無視
        }
      }
      next();
      return;
    }

    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      next();
      return;
    }

    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }
    const token = authHeader.slice(7).trim();
    try {
      (req as any).supabaseUser = jwt.verify(token, secret);
      next();
    } catch (err) {
      console.warn("[tenantAuth] invalid token", err);
      res.status(401).json({ error: "Invalid token" });
    }
  }

  function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const role = su?.app_metadata?.role ?? su?.user_metadata?.role ?? su?.role ?? "anonymous";
    if (role !== "super_admin") {
      res.status(403).json({ error: "forbidden", message: "スーパー管理者のみアクセスできます" });
      return;
    }
    next();
  }
  // ─────────────────────────────────────────────────────────────────────────

  // GET /v1/admin/tenants
  app.get("/v1/admin/tenants", tenantAuth, requireSuperAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await db.query(
        `SELECT id, name, plan, is_active, allowed_origins, system_prompt, created_at, updated_at FROM tenants ORDER BY created_at DESC`
      );
      return res.json({ tenants: result.rows, total: result.rows.length });
    } catch (err) {
      console.warn("[GET /v1/admin/tenants]", err);
      return res.status(500).json({ error: "一覧の取得に失敗しました" });
    }
  });

  // POST /v1/admin/tenants
  app.post("/v1/admin/tenants", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const parsed = createTenantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const { id, name, plan } = parsed.data;
    try {
      const result = await db.query(
        `INSERT INTO tenants (id, name, plan, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING id, name, plan, is_active, created_at, updated_at`,
        [id, name, plan]
      );
      const tenant = result.rows[0];
      // in-memory storeにも同期（既存の認証フローとの互換性）
      registerTenant({
        tenantId: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        features: { avatar: false, voice: false, rag: true },
        security: {
          apiKeyHash: "",
          hashAlgorithm: "sha256",
          allowedOrigins: [],
          rateLimit: 100,
          rateLimitWindowMs: 60_000,
        },
        enabled: tenant.is_active,
      });
      return res.status(201).json(tenant);
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ error: "conflict", message: "このIDのテナントはすでに存在します。" });
      }
      console.warn("[POST /v1/admin/tenants]", err);
      return res.status(500).json({ error: "作成に失敗しました" });
    }
  });

  // GET /v1/admin/tenants/:id
  app.get("/v1/admin/tenants/:id", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await db.query(
        `SELECT id, name, plan, is_active, allowed_origins, system_prompt, created_at, updated_at FROM tenants WHERE id = $1`,
        [id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      return res.json(result.rows[0]);
    } catch (err) {
      console.warn("[GET /v1/admin/tenants/:id]", err);
      return res.status(500).json({ error: "取得に失敗しました" });
    }
  });

  // PATCH /v1/admin/tenants/:id
  app.patch("/v1/admin/tenants/:id", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsed = updateTenantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
    }
    try {
      // 存在チェック
      const check = await db.query("SELECT id FROM tenants WHERE id = $1", [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (fields.name !== undefined) { params.push(fields.name); setClauses.push(`name = $${params.length}`); }
      if (fields.plan !== undefined) { params.push(fields.plan); setClauses.push(`plan = $${params.length}`); }
      if (fields.is_active !== undefined) { params.push(fields.is_active); setClauses.push(`is_active = $${params.length}`); }
      if (fields.allowed_origins !== undefined) { params.push(fields.allowed_origins); setClauses.push(`allowed_origins = $${params.length}`); }
      // Phase38 Step6: system_prompt の更新（空文字列による削除も許可）
      if (fields.system_prompt !== undefined) { params.push(fields.system_prompt); setClauses.push(`system_prompt = $${params.length}`); }
      setClauses.push(`updated_at = NOW()`);
      params.push(id);
      const result = await db.query(
        `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = $${params.length} RETURNING id, name, plan, is_active, allowed_origins, system_prompt, created_at, updated_at`,
        params
      );
      return res.json(result.rows[0]);
    } catch (err) {
      console.warn("[PATCH /v1/admin/tenants/:id]", err);
      return res.status(500).json({ error: "更新に失敗しました" });
    }
  });

  // POST /v1/admin/tenants/:id/keys — APIキー発行
  app.post("/v1/admin/tenants/:id/keys", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      // テナント存在チェック
      const tenantCheck = await db.query("SELECT id, name, plan, is_active FROM tenants WHERE id = $1", [id]);
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      if (!tenantCheck.rows[0].is_active) {
        return res.status(403).json({ error: "tenant_disabled", message: "無効なテナントにはAPIキーを発行できません。" });
      }

      // expires_at (オプション: body.expires_at)
      const expiresAtRaw = req.body?.expires_at;
      const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
      if (expiresAt && isNaN(expiresAt.getTime())) {
        return res.status(400).json({ error: "invalid_expires_at", message: "expires_atの日時形式が不正です。" });
      }

      const plainKey = generateApiKey();
      const keyHash = hashApiKey(plainKey);
      const keyPrefix = plainKey.slice(0, 12); // "rjc_" + 8文字

      const result = await db.query(
        `INSERT INTO tenant_api_keys (tenant_id, key_hash, key_prefix, is_active, expires_at)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id, tenant_id, key_prefix, is_active, created_at, expires_at`,
        [id, keyHash, keyPrefix, expiresAt]
      );
      const row = result.rows[0];

      // in-memory storeのAPIキーハッシュを更新（最新キーで上書き）
      const tenantRow = tenantCheck.rows[0];
      registerTenant({
        tenantId: tenantRow.id,
        name: tenantRow.name || tenantRow.id,
        plan: tenantRow.plan || "starter",
        features: { avatar: false, voice: false, rag: true },
        security: {
          apiKeyHash: keyHash,
          hashAlgorithm: "sha256",
          allowedOrigins: [],
          rateLimit: 100,
          rateLimitWindowMs: 60_000,
        },
        enabled: true,
      });

      // 平文キーはこのレスポンスでのみ返す（二度と取得不可）
      return res.status(201).json({
        api_key: plainKey,
        tenant_id: row.tenant_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        id: row.id,
      });
    } catch (err) {
      console.warn("[POST /v1/admin/tenants/:id/keys]", err);
      return res.status(500).json({ error: "APIキー発行に失敗しました" });
    }
  });

  // GET /v1/admin/tenants/:id/keys — APIキー一覧（マスク表示）
  app.get("/v1/admin/tenants/:id/keys", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const tenantCheck = await db.query("SELECT id FROM tenants WHERE id = $1", [id]);
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      const result = await db.query(
        `SELECT id, key_prefix, is_active, created_at, expires_at, last_used_at
         FROM tenant_api_keys
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [id]
      );
      const keys = result.rows.map((row: any) => ({
        ...row,
        prefix: maskApiKeyPrefix(row.key_prefix),
      }));
      return res.json({ keys, total: keys.length });
    } catch (err) {
      console.warn("[GET /v1/admin/tenants/:id/keys]", err);
      return res.status(500).json({ error: "APIキー一覧の取得に失敗しました" });
    }
  });

  // DELETE /v1/admin/tenants/:id/keys/:keyId — APIキー無効化（論理削除）
  app.delete("/v1/admin/tenants/:id/keys/:keyId", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id, keyId } = req.params;
    try {
      const result = await db.query(
        `UPDATE tenant_api_keys
         SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, is_active`,
        [keyId, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "APIキーが見つかりません。" });
      }
      return res.json({ ok: true, id: keyId, is_active: false });
    } catch (err) {
      console.warn("[DELETE /v1/admin/tenants/:id/keys/:keyId]", err);
      return res.status(500).json({ error: "APIキー無効化に失敗しました" });
    }
  });

  // POST /v1/admin/tenants/:id/invite — client_adminユーザー招待（Super Admin専用）
  app.post("/v1/admin/tenants/:id/invite", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;

    const schema = z.object({
      email: z.string().email("有効なメールアドレスを入力してください"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const { email } = parsed.data;

    // テナント存在チェック
    try {
      const tenantCheck = await db.query("SELECT id, name, is_active FROM tenants WHERE id = $1", [id]);
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      if (!tenantCheck.rows[0].is_active) {
        return res.status(403).json({ error: "tenant_disabled", message: "無効なテナントにはユーザーを招待できません。" });
      }
    } catch (err) {
      console.warn("[POST /v1/admin/tenants/:id/invite] tenant check failed", err);
      return res.status(500).json({ error: "テナント確認に失敗しました" });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ error: "service_unavailable", message: "Supabase Adminクライアントが設定されていません。" });
    }

    try {
      // ユーザーを招待（メール送信）
      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        email,
        { data: { role: "client_admin", tenant_id: id } }
      );

      if (inviteError) {
        console.warn("[POST /v1/admin/tenants/:id/invite] invite error", inviteError);
        return res.status(400).json({
          error: "invite_failed",
          message: inviteError.message || "招待メールの送信に失敗しました。",
        });
      }

      const userId = inviteData.user?.id;
      if (!userId) {
        return res.status(500).json({ error: "invite_failed", message: "ユーザーIDの取得に失敗しました。" });
      }

      // app_metadata に role と tenant_id を設定
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        app_metadata: { role: "client_admin", tenant_id: id },
      });

      if (updateError) {
        console.warn("[POST /v1/admin/tenants/:id/invite] app_metadata update error", updateError);
        // 招待は成功しているが app_metadata の更新に失敗した場合も通知
        return res.status(500).json({
          error: "metadata_update_failed",
          message: "招待メールは送信しましたが、ロール設定に失敗しました。手動で設定してください。",
        });
      }

      return res.status(201).json({
        ok: true,
        userId,
        email,
        tenantId: id,
        role: "client_admin",
      });
    } catch (err) {
      console.warn("[POST /v1/admin/tenants/:id/invite]", err);
      return res.status(500).json({ error: "招待処理に失敗しました" });
    }
  });

  console.log("[tenantAdminRoutes] /v1/admin/tenants routes registered");
}
