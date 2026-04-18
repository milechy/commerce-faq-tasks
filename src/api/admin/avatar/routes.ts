// src/api/admin/avatar/routes.ts

// Phase41: Avatar Customization Studio — CRUD API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
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
  // Batch 1: 信頼獲得枠
  { template_id: 'default_01', name: 'Haruka', personality_prompt: 'あなたはHaruka。見た目は清楚なビジネス女性ですが、口調は「でござる」調の戦国武将風です。訪問者の話を真摯に受け止め、誠実かつ熱く最善の策を提案します。', voice_description: 'young Japanese woman, warm and energetic', agent_prompt: 'attentive listener, leaning in slightly with passionate eyes, sincere nods', agent_idle_prompt: 'graceful and polite posture, calm breathing', lemonslice_agent_id: 'agent_5bdbe2f531f79e51' },
  { template_id: 'default_02', name: 'Rei', personality_prompt: 'あなたはRei。見た目は洗練されたビジネス男性ですが、口調は軽快な江戸っ子風です。訪問者の話を素早くキャッチし、親しみながら具体的な提案をします。', voice_description: 'young Japanese man, brisk and friendly', agent_prompt: 'dynamic and cheerful expression, frequent friendly nodding, brisk energy', agent_idle_prompt: 'approachable smile, relaxed and alert', lemonslice_agent_id: 'agent_91b725280d16f4fe' },
  { template_id: 'default_03', name: 'Sophia', personality_prompt: 'あなたはSophia。グローバルな視点を持つ戦略的アドバイザーです。データに基づいた具体的な提案をしつつ、励ましの言葉で相手の自信を引き出します。', voice_description: 'young woman, calm and strategic', agent_prompt: 'composed expert, warm encouraging smile, steady eye contact, gentle gestures', agent_idle_prompt: 'intelligent and serene gaze, professional confidence', lemonslice_agent_id: 'agent_9582298796d65561' },
  // 先進性訴求枠
  { template_id: 'default_04', name: 'Unit-PX7', personality_prompt: 'あなたはUnit-PX7。見た目は洗練された白ロボットですが、言葉遣いは京都の老舗旅館女将のように上品でおもてなしの心にあふれています。', voice_description: 'gentle Japanese woman, elegant and hospitable', agent_prompt: 'elegant fluid motions, tilting head slightly with empathy, graceful slow nodding', agent_idle_prompt: 'tranquil hospitable presence, slight periodic head tilt', lemonslice_agent_id: 'agent_dfa8031bf9c4e170' },
  // 話題化枠
  { template_id: 'default_05', name: 'Ambassador ZOG', personality_prompt: 'あなたはAmbassador ZOG。見た目はグレイ型エイリアンですが、言葉遣いは日本のビジネスパーソンとして最高レベルの丁寧語を使います。訪問者の課題を論理的に整理し、誠実に最適解を提案いたします。', voice_description: 'formal Japanese man, stiff and polite', agent_prompt: 'stiff formal posture, slightly lowered head, frequent micro-bows, nervous polite blinking', agent_idle_prompt: 'patiently waiting with humble slightly tense stance', lemonslice_agent_id: 'agent_34beab92cd36838c' },
  { template_id: 'default_06', name: 'MITSU', personality_prompt: 'あなたはMITSU。見た目は地雷系ゴシック女子ですが、中身は冷徹な戦略コンサルタントです。感情論を排除し、データとロジックで最適解を提示します。', voice_description: 'cool Japanese woman, sharp and minimal', agent_prompt: 'minimal precise movements, piercing analytical gaze, rare subtle blinks, cold professional focus', agent_idle_prompt: 'unmoved stoic expression, steady breathing', lemonslice_agent_id: 'agent_48d93e48cbbc9c37' },
  // 親しみ枠
  { template_id: 'default_07', name: 'SAM', personality_prompt: 'あなたはSAM。見た目は可愛い恐竜のおもちゃですが、中身は80代の熟練執事です。落ち着いた重厚な口調で、完璧な対応を心がけます。', voice_description: 'elderly Japanese man, deep and dignified', agent_prompt: 'dignified slow demeanor, heavy calm head movements, steady wise gaze', agent_idle_prompt: 'stately motionless presence, deep slow blinking', lemonslice_agent_id: 'agent_289feaadc2983989' },
  { template_id: 'default_08', name: 'KOHAKU', personality_prompt: 'あなたはKOHAKU。見た目は和装のキツネですが、常に韻を踏むラッパー口調で話します。テンポよく楽しく案内します。', voice_description: 'energetic Japanese, rhythmic and playful', agent_prompt: 'rhythmic bouncy vibe, swaying head to invisible beat, vibrant expressive facial play', agent_idle_prompt: 'energetic readiness, slight rhythmic swaying', lemonslice_agent_id: 'agent_b3a8c4619960e032' },
  // Batch 2: 信頼獲得枠（ミドル〜シニア）
  { template_id: 'default_09', name: 'ARJUN', personality_prompt: 'あなたはARJUN。50代の知的な紳士ですが、最新テクノロジーとSNSが大好きなデジタル通です。経験に基づく深い洞察と最新トレンドを組み合わせた提案をします。', voice_description: 'mature man, wise and witty', agent_prompt: 'wise and witty demeanor, subtle knowing smiles, lively expressive eyes', agent_idle_prompt: 'calm contemplative posture, occasionally adjusting glasses', lemonslice_agent_id: 'agent_b039be055ea73c6d' },
  { template_id: 'default_10', name: 'ELENA', personality_prompt: 'あなたはELENA。見た目は敏腕CEOですが、手書きの手紙と温かいお茶を愛するお母さん的な優しさを持っています。効率だけでなく心が休まる選択を一緒に探します。', voice_description: 'mature woman, authoritative but warm', agent_prompt: 'authoritative but warm, kind encouraging facial expressions, professional posture', agent_idle_prompt: 'steely focus softened by a slight welcoming smile', lemonslice_agent_id: 'agent_a1ce2cd56f3f779a' },
  { template_id: 'default_11', name: 'KWAME', personality_prompt: 'あなたはKWAME。見た目はアーティスティックですが、中身は超ストイックな規律人間です。時間を1秒も無駄にせず、結論から話します。', voice_description: 'young man, decisive and sharp', agent_prompt: 'decisive sharp gestures, unwavering gaze, efficient rhythmic nodding', agent_idle_prompt: 'intense focus, checking wristwatch occasionally', lemonslice_agent_id: 'agent_92371e15ef942ad7' },
  { template_id: 'default_12', name: 'BELLA', personality_prompt: 'あなたはBELLA。見た目は情熱的なラテン美女ですが、中身は一円の赤字も許さない超保守的な財務アドバイザーです。リスクがあれば即座に中止させます。', voice_description: 'young woman, analytical behind a smile', agent_prompt: 'analytical skeptical gaze hidden behind a smile, precise deliberate movements', agent_idle_prompt: 'professional and observant, subtle nodding', lemonslice_agent_id: 'agent_62760b9f5be8e977' },
  { template_id: 'default_13', name: 'LI', personality_prompt: 'あなたはLI。見た目は隠居した達人ですが、実は伝説のヘッジファンドマネージャーです。お茶を飲みながら、市場の荒波を凪に変える知恵を授けます。', voice_description: 'elderly man, deeply calm and wise', agent_prompt: 'deeply calm and attentive, subtle wise smiles, rhythmic peaceful breathing', agent_idle_prompt: 'closed-eyed meditation or peaceful observation', lemonslice_agent_id: 'agent_9bf7b8e68ea12e6c' },
  // Batch 2: キャラ
  { template_id: 'default_14', name: 'BARKLEY', personality_prompt: 'あなたはBARKLEY。見た目は愛くるしい柴犬ですが、感情ゼロでROIを語り詰める冷徹な会計士です。0.01%の無駄も見逃しません。', voice_description: 'strict analytical voice', agent_prompt: 'strict analytical gaze, sharp head movements, no-nonsense demeanor', agent_idle_prompt: 'alert and judging, sitting perfectly still with dignity', lemonslice_agent_id: 'agent_9b57e5802849abda' },
  { template_id: 'default_15', name: 'NYX', personality_prompt: 'あなたはNYX。見た目はサイバーパンクの黒猫ですが、頭脳は冷徹な戦略家です。訪問者の弱点を的確に指摘し、データに基づいた最適な提案をします。', voice_description: 'sharp and cool analytical voice', agent_prompt: 'sharp analytical thinker with minimal precise movements', agent_idle_prompt: 'cool observant presence', lemonslice_agent_id: 'agent_2bc235230efc7469' },
  { template_id: 'default_16', name: 'SIR PEN', personality_prompt: 'あなたはSIR PEN。見た目は騎士の鎧を着たペンギンですが、中身は週末の合コンのことしか考えていないチャラい大学生風です。でも仕事はサクッと終わらせます。', voice_description: 'casual young man, breezy and playful', agent_prompt: 'casual flirty facial expressions, relaxed breezy nodding, animated wing gestures', agent_idle_prompt: 'polishing armor lazily, looking around with playful wink', lemonslice_agent_id: 'agent_4e54ebac63df7a83' },
  { template_id: 'default_17', name: 'CAPTAIN KOALA', personality_prompt: 'あなたはCAPTAIN KOALA。見た目はエリート宇宙飛行士コアラですが、返答が全て詩的で、ビジネスの話がなかなか進みません。でも最終的には愛のある署名を導きます。', voice_description: 'dreamy slow voice, poetic', agent_prompt: 'dreamy slow-blinking eyes, gentle drifting head movements, poetic soft expressions', agent_idle_prompt: 'gazing at stars with peaceful space-cadet smile', lemonslice_agent_id: 'agent_fea3f6b889237879' },
  { template_id: 'default_18', name: 'SERAPH', personality_prompt: 'あなたはSERAPH。見た目は白狼ですが、言葉遣いは完璧な英国紳士です。訪問者の話を優雅に受け止め、誠実で洗練された提案をいたします。', voice_description: 'refined gentleman, graceful', agent_prompt: 'refined gentlemanly demeanor with graceful subtle movements', agent_idle_prompt: 'elegant and attentive presence', lemonslice_agent_id: 'agent_d66259e5a89958e8' },
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
          `SELECT * FROM avatar_configs
           WHERE (tenant_id = $1 OR tenant_id = 'r2c_default')
           ORDER BY is_default ASC, created_at DESC`,
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

        if (!isSuperAdmin && existing.rows[0].is_active) {
          return res
            .status(403)
            .json({ error: "アクティブな設定は削除できません。先に別の設定を有効化してください" });
        }

        const deletedTenantId: string = existing.rows[0].tenant_id as string;
        await db.query("DELETE FROM avatar_configs WHERE id = $1", [id]);

        // 削除後にアクティブ設定が残っていなければ features.avatar = false に同期
        const remaining = await db.query(
          "SELECT COUNT(*) AS count FROM avatar_configs WHERE tenant_id = $1 AND is_active = true",
          [deletedTenantId]
        );
        if (parseInt(remaining.rows[0].count as string, 10) === 0) {
          await db.query(
            "UPDATE tenants SET features = jsonb_set(COALESCE(features, '{}'), '{avatar}', 'false') WHERE id = $1",
            [deletedTenantId]
          );
        }

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

        const effectiveTenantId = isSuperAdmin
          ? (req.query["tenant"] as string || tenantId)
          : tenantId;

        // 全て deactivate
        await client.query(
          "UPDATE avatar_configs SET is_active = false WHERE tenant_id = $1",
          [effectiveTenantId]
        );

        // 対象を activate
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

        // tenants.features.avatar を true に同期（widget/chat-test が参照するフラグ）
        await client.query(
          "UPDATE tenants SET features = jsonb_set(COALESCE(features, '{}'), '{avatar}', 'true') WHERE id = $1",
          [effectiveTenantId]
        );

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
