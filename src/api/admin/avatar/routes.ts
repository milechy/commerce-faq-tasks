// src/api/admin/avatar/routes.ts

// Phase41: Avatar Customization Studio — CRUD API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
// @ts-ignore
import { Pool } from "pg";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import multer from 'multer';
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// Supabase Storage: base64 data URL → 公開 HTTP URL
// ---------------------------------------------------------------------------

const AVATAR_BUCKET = "avatar-images";
const DEFAULT_AVATARS_BUCKET = "avatar-defaults";

const DEFAULT_AVATARS = [
  { id: 'default_01', name: 'さくら', personality: '明るく元気な営業アシスタント' },
  { id: 'default_02', name: 'あおい', personality: '落ち着いた丁寧なカスタマーサポート' },
  { id: 'default_03', name: 'ひなた', personality: '親しみやすいフレンドリーな案内役' },
  { id: 'default_04', name: 'みずき', personality: '知的で信頼感のあるコンサルタント' },
  { id: 'default_05', name: 'りん', personality: 'テキパキした効率的なアドバイザー' },
  { id: 'default_06', name: 'かえで', personality: '温かみのある相談しやすいスタッフ' },
  { id: 'default_07', name: 'すずな', personality: '誠実で安心感のある対応スタッフ' },
  { id: 'default_08', name: 'つむぎ', personality: '柔らかく寄り添うサポートスタッフ' },
];

export { DEFAULT_AVATARS };

function getDefaultAvatarImageUrl(templateId: string): string | null {
  if (!supabaseAdmin) return null;
  const { data } = supabaseAdmin.storage
    .from(DEFAULT_AVATARS_BUCKET)
    .getPublicUrl(`${templateId}.png`);
  return data?.publicUrl ?? null;
}

async function ensureBucketExists(): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.storage.createBucket(AVATAR_BUCKET, {
    public: true,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    fileSizeLimit: 5 * 1024 * 1024,
  });
  if (error && !error.message.toLowerCase().includes("already exists")) {
    logger.warn("[avatar-storage] bucket create warn:", error.message);
  }
}

async function uploadBase64ToStorage(
  dataUrl: string,
  tenantId: string,
  filename: string
): Promise<string | null> {
  if (!supabaseAdmin) {
    logger.warn("[avatar-storage] supabaseAdmin not initialized — image_url stored as-is");
    return null;
  }

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1] as string;
  const base64Data = match[2] as string;
  const buffer = Buffer.from(base64Data, "base64");

  const ext =
    mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const filePath = `${tenantId}/${filename}.${ext}`;

  await ensureBucketExists();

  const { error } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .upload(filePath, buffer, { contentType: mimeType, upsert: true });

  if (error) {
    logger.warn("[avatar-storage] upload failed:", error.message);
    return null;
  }

  const { data: urlData } = supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .getPublicUrl(filePath);
  return urlData?.publicUrl ?? null;
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(100),
  image_url: z.string().optional(),
  image_prompt: z.string().optional(),
  voice_id: z.string().optional(),
  voice_description: z.string().optional(),
  personality_prompt: z.string().optional(),
  behavior_description: z.string().optional(),
  emotion_tags: z.array(z.string()).optional(),
  lemonslice_agent_id: z.string().optional(),
  anam_avatar_id: z.string().optional(),
  anam_voice_id: z.string().optional(),
  anam_persona_id: z.string().optional(),
  anam_llm_id: z.string().optional(),
  avatar_provider: z.enum(['lemonslice', 'anam']).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  image_url: z.string().optional(),
  image_prompt: z.string().optional(),
  voice_id: z.string().optional(),
  voice_description: z.string().optional(),
  personality_prompt: z.string().optional(),
  behavior_description: z.string().optional(),
  emotion_tags: z.array(z.string()).optional(),
  lemonslice_agent_id: z.string().optional(),
  anam_avatar_id: z.string().optional(),
  anam_voice_id: z.string().optional(),
  anam_persona_id: z.string().optional(),
  anam_llm_id: z.string().optional(),
  avatar_provider: z.enum(['lemonslice', 'anam']).optional(),
});

// ---------------------------------------------------------------------------
// ヘルパー: JWT から tenantId / super_admin 判定
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
  const isSuperAdmin: boolean =
    (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";
  return { tenantId, isSuperAdmin };
}

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerAvatarConfigRoutes(app: Express, db: any): void {
  if (!db) return;

  app.use("/v1/admin/avatar", supabaseAuthMiddleware);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  // POST /v1/admin/avatar/defaults/upload — Super Adminのみ: デフォルトアバター画像をStorageにアップロード
  app.post(
    "/v1/admin/avatar/defaults/upload",
    upload.single("file"),
    async (req: Request, res: Response) => {
      const { isSuperAdmin } = extractAuth(req);
      if (!isSuperAdmin) {
        return res.status(403).json({ error: 'Super Admin権限が必要です' });
      }
      if (!supabaseAdmin) {
        return res.status(503).json({ error: 'Supabase Storage が利用できません' });
      }

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: 'ファイルが必要です' });
      }

      const templateId = (req.body?.template_id as string | undefined)?.trim();
      if (!templateId || !templateId.match(/^default_0[1-8]$/)) {
        return res.status(400).json({ error: 'template_id は default_01〜default_08 で指定してください' });
      }

      const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const filePath = `${templateId}.${ext}`;

      // avatar-defaults バケットを作成（なければ）
      await supabaseAdmin.storage.createBucket(DEFAULT_AVATARS_BUCKET, {
        public: true,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        fileSizeLimit: 5 * 1024 * 1024,
      }).catch(() => {}); // already exists は無視

      const { error } = await supabaseAdmin.storage
        .from(DEFAULT_AVATARS_BUCKET)
        .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });

      if (error) {
        logger.warn('[POST /v1/admin/avatar/defaults/upload] upload error:', error.message);
        return res.status(500).json({ error: 'アップロードに失敗しました' });
      }

      const { data: urlData } = supabaseAdmin.storage
        .from(DEFAULT_AVATARS_BUCKET)
        .getPublicUrl(filePath);

      return res.json({ url: urlData?.publicUrl ?? null });
    }
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/avatar/configs/all — Super Admin: 全テナント横断一覧 (tenant_name付き)
  // -----------------------------------------------------------------------
  app.get("/v1/admin/avatar/configs/all", async (req: Request, res: Response) => {
    const { isSuperAdmin } = extractAuth(req);
    if (!isSuperAdmin) {
      return res.status(403).json({ error: "Super Admin権限が必要です" });
    }
    try {
      const result = await db.query(
        `SELECT ac.*, COALESCE(t.name, ac.tenant_id) AS tenant_name
         FROM avatar_configs ac
         LEFT JOIN tenants t ON t.id = ac.tenant_id
         ORDER BY t.name ASC, ac.created_at DESC`
      );
      return res.json({ configs: result.rows, total: result.rows.length });
    } catch (err) {
      logger.warn("[GET /v1/admin/avatar/configs/all]", err);
      return res.status(500).json({ error: "アバター設定の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /v1/admin/avatar/configs — テナント一覧
  // -----------------------------------------------------------------------
  app.get("/v1/admin/avatar/configs", async (req: Request, res: Response) => {
    const { tenantId, isSuperAdmin } = extractAuth(req);

    // Bug-3 fix: client_admin は tenantId が空でも JWT から取得済みの tenantId を必ず使う。
    // isSuperAdmin の場合のみ query パラメータによるテナント絞り込みを許可する。
    const filterTenantId = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || undefined)
      : (tenantId || undefined);

    // client_admin で tenantId が取れない場合は 403 を返す（全件公開を防ぐ）
    if (!isSuperAdmin && !filterTenantId) {
      return res.status(403).json({ error: "テナント情報が取得できません" });
    }

    try {
      let result;
      if (filterTenantId) {
        result = await db.query(
          "SELECT * FROM avatar_configs WHERE tenant_id = $1 ORDER BY created_at DESC",
          [filterTenantId]
        );
      } else {
        result = await db.query(
          "SELECT * FROM avatar_configs ORDER BY created_at DESC"
        );
      }
      return res.json({ configs: result.rows, total: result.rows.length });
    } catch (err) {
      logger.warn("[GET /v1/admin/avatar/configs]", err);
      return res.status(500).json({ error: "アバター設定の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/configs — 新規作成
  // -----------------------------------------------------------------------
  app.post("/v1/admin/avatar/configs", async (req: Request, res: Response) => {
    const { tenantId } = extractAuth(req);

    if (!tenantId) {
      return res.status(403).json({ error: "テナント情報が取得できません" });
    }

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const {
      name,
      image_url,
      image_prompt,
      voice_id,
      voice_description,
      personality_prompt,
      behavior_description,
      emotion_tags,
      lemonslice_agent_id,
      anam_avatar_id,
      anam_voice_id,
      anam_persona_id,
      anam_llm_id,
      avatar_provider,
    } = parsed.data;

    try {
      // base64 data URL → Supabase Storage HTTP URL に変換
      let resolvedImageUrl = image_url ?? null;
      if (resolvedImageUrl?.startsWith("data:")) {
        const uploaded = await uploadBase64ToStorage(
          resolvedImageUrl,
          tenantId,
          `avatar-${Date.now()}`
        );
        resolvedImageUrl = uploaded ?? resolvedImageUrl;
      }

      const result = await db.query(
        `INSERT INTO avatar_configs
          (tenant_id, name, image_url, image_prompt, voice_id, voice_description,
           personality_prompt, behavior_description, emotion_tags, lemonslice_agent_id,
           anam_avatar_id, anam_voice_id, anam_persona_id, anam_llm_id, avatar_provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          tenantId,
          name,
          resolvedImageUrl,
          image_prompt ?? null,
          voice_id ?? null,
          voice_description ?? null,
          personality_prompt ?? null,
          behavior_description ?? null,
          JSON.stringify(emotion_tags ?? []),
          lemonslice_agent_id ?? null,
          anam_avatar_id ?? null,
          anam_voice_id ?? null,
          anam_persona_id ?? null,
          anam_llm_id ?? null,
          avatar_provider ?? 'lemonslice',
        ]
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.warn("[POST /v1/admin/avatar/configs]", err);
      return res.status(500).json({ error: "アバター設定の作成に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/avatar/configs/:id — 更新
  // -----------------------------------------------------------------------
  app.patch(
    "/v1/admin/avatar/configs/:id",
    async (req: Request, res: Response) => {
      const { tenantId, isSuperAdmin } = extractAuth(req);
      const id = req.params["id"];

      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const data = parsed.data;

      // is_default=true の場合は image_url の変更を禁止
      if (data.image_url !== undefined) {
        const checkResult = await db.query(
          "SELECT is_default FROM avatar_configs WHERE id = $1",
          [id]
        );
        if (checkResult.rows[0]?.is_default === true) {
          return res.status(400).json({ error: 'デフォルトアバターの画像は変更できません' });
        }
      }

      // base64 data URL → Supabase Storage HTTP URL に変換
      if (data.image_url?.startsWith("data:")) {
        const uploaded = await uploadBase64ToStorage(
          data.image_url,
          tenantId,
          `avatar-${id}-${Date.now()}`
        );
        if (uploaded) data.image_url = uploaded;
      }

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          const dbValue = key === "emotion_tags" ? JSON.stringify(value) : value;
          setClauses.push(`${key} = $${idx}`);
          values.push(dbValue);
          idx++;
        }
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: "更新するフィールドがありません" });
      }

      // owner filter
      values.push(id);
      const idParam = `$${idx}`;
      idx++;

      let query = `UPDATE avatar_configs SET ${setClauses.join(", ")} WHERE id = ${idParam}`;
      if (!isSuperAdmin) {
        values.push(tenantId);
        query += ` AND tenant_id = $${idx}`;
      }
      query += " RETURNING *";

      try {
        const result = await db.query(query, values);
        if (result.rows.length === 0) {
          return res
            .status(404)
            .json({ error: "設定が見つからないかアクセス権限がありません" });
        }
        return res.json(result.rows[0]);
      } catch (err) {
        logger.warn("[PATCH /v1/admin/avatar/configs/:id]", err);
        return res.status(500).json({ error: "アバター設定の更新に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/avatar/configs/:id — 削除（is_active=true は 403）
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/avatar/configs/:id",
    async (req: Request, res: Response) => {
      const { tenantId, isSuperAdmin } = extractAuth(req);
      const id = req.params["id"];

      try {
        // まず対象を取得して is_active チェック
        let checkQuery = "SELECT * FROM avatar_configs WHERE id = $1";
        const checkValues: unknown[] = [id];
        if (!isSuperAdmin) {
          checkQuery += " AND tenant_id = $2";
          checkValues.push(tenantId);
        }

        const existing = await db.query(checkQuery, checkValues);
        if (existing.rows.length === 0) {
          return res
            .status(404)
            .json({ error: "設定が見つからないかアクセス権限がありません" });
        }

        if (existing.rows[0].is_active) {
          return res
            .status(403)
            .json({ error: "アクティブな設定は削除できません。先に別の設定を有効化してください" });
        }

        await db.query("DELETE FROM avatar_configs WHERE id = $1", [id]);
        return res.json({ ok: true, id });
      } catch (err) {
        logger.warn("[DELETE /v1/admin/avatar/configs/:id]", err);
        return res.status(500).json({ error: "アバター設定の削除に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/configs/:id/activate — 有効化
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/configs/:id/activate",
    async (req: Request, res: Response) => {
      const { tenantId, isSuperAdmin } = extractAuth(req);
      const id = req.params["id"];

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        // 全て deactivate
        await client.query(
          "UPDATE avatar_configs SET is_active = false WHERE tenant_id = $1",
          [isSuperAdmin ? (req.query["tenant"] as string || tenantId) : tenantId]
        );

        // 対象を activate
        const effectiveTenantId = isSuperAdmin
          ? (req.query["tenant"] as string || tenantId)
          : tenantId;

        const result = await client.query(
          "UPDATE avatar_configs SET is_active = true WHERE id = $1 AND tenant_id = $2 RETURNING *",
          [id, effectiveTenantId]
        );

        if (result.rows.length === 0) {
          await client.query("ROLLBACK");
          return res
            .status(404)
            .json({ error: "設定が見つからないかアクセス権限がありません" });
        }

        await client.query("COMMIT");
        return res.json(result.rows[0]);
      } catch (err) {
        await client.query("ROLLBACK");
        logger.warn("[POST /v1/admin/avatar/configs/:id/activate]", err);
        return res.status(500).json({ error: "アバター設定の有効化に失敗しました" });
      } finally {
        client.release();
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/configs/:id/reset-to-default — デフォルト値にリセット
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/configs/:id/reset-to-default",
    async (req: Request, res: Response) => {
      const { tenantId, isSuperAdmin } = extractAuth(req);
      const id = req.params["id"];

      try {
        let checkQuery = "SELECT * FROM avatar_configs WHERE id = $1";
        const checkValues: unknown[] = [id];
        if (!isSuperAdmin) {
          checkQuery += " AND tenant_id = $2";
          checkValues.push(tenantId);
        }

        const existing = await db.query(checkQuery, checkValues);
        if (existing.rows.length === 0) {
          return res.status(404).json({ error: '設定が見つからないかアクセス権限がありません' });
        }

        const config = existing.rows[0];
        if (!config.is_default) {
          return res.status(404).json({ error: 'デフォルトアバターではありません' });
        }

        const result = await db.query(
          `UPDATE avatar_configs
           SET voice_id = default_voice_id,
               personality_prompt = default_personality_prompt,
               name = default_name,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [id]
        );

        return res.json(result.rows[0]);
      } catch (err) {
        logger.warn('[POST /v1/admin/avatar/configs/:id/reset-to-default]', err);
        return res.status(500).json({ error: 'リセットに失敗しました' });
      }
    }
  );
}
