// src/api/admin/avatar/generationRoutes.ts

// Phase41: Avatar Customization Studio — 画像生成・声マッチング・プロンプト生成API

import { GPT_OSS_120B, groqReasoningParams } from '../../../config/groqModels';
import type { Express, NextFunction, Request, Response } from "express";

type AvatarReq = Request & { supabaseUser?: Record<string, unknown>; requestId?: string };
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { roleAuthMiddleware, requireRole, resolveEffectiveTenantId, type AuthedReq } from "../../middleware/roleAuth";
import { trackUsage } from "../../../lib/billing/usageTracker";
import { getPool } from "../../../lib/db";
import { avatarCustomizeDenial } from "./avatarCustomizeGate";
import { logger } from '../../../lib/logger';
import { containsBannedWord } from '../../../lib/contentGuard';

// ---------------------------------------------------------------------------
// Groq LLM helper
// ---------------------------------------------------------------------------

async function callGroqLLM(system: string, user: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("Groq API key not configured");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GPT_OSS_120B,
      // gpt-oss は推論トークンが max_tokens を食う（groqModels.ts 参照）
      ...groqReasoningParams(GPT_OSS_120B),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const generateImageSchema = z.object({
  description: z.string().min(1).max(500),
});

const matchVoiceSchema = z.object({
  description: z.string().min(1).max(300),
});

// GID 1217084040137242: 上限は公式APIのバリデーション制約と一致させる
// (instruction: 1-2000字 / reference_text: 最大150字 / n: 1-4)。
const designVoiceSchema = z.object({
  instruction: z.string().min(1).max(2000),
  reference_text: z.string().max(150).optional(),
  n: z.number().int().min(1).max(4).optional(),
  // 公式仕様: 0 < speed <= 3 (0自体は不可)
  speed: z.number().gt(0).max(3).optional(),
});

const generatePromptSchema = z.object({
  rules: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// Authorization middleware
// ---------------------------------------------------------------------------

const AVATAR_GEN_ALLOWED_ROLES = ['super_admin', 'client_admin'] as const;

function avatarGenAuthzLogger(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthedReq).user;
  if (!user || !(AVATAR_GEN_ALLOWED_ROLES as readonly string[]).includes(user.role)) {
    logger.warn({
      event: 'avatar_generation_authz_denied',
      path: req.path,
      method: req.method,
      actor_role: user?.role ?? 'unknown',
      actor_email: user?.email ? user.email.slice(0, 3) + '***' : 'unknown',
    });
  }
  next();
}

const AVATAR_GEN_AUTHZ = [roleAuthMiddleware, avatarGenAuthzLogger, requireRole(...AVATAR_GEN_ALLOWED_ROLES)];

// ---------------------------------------------------------------------------
// Plan gate (avatar_customize)
// ---------------------------------------------------------------------------
//
// このファイルの4ルートはいずれも「自社アバターを作り込む」操作なので Growth 以上。
// Standard は R2C の既定アバターをそのまま使う段で、ここには入れない。
// ロール認可(AVATAR_GEN_AUTHZ)だけでは client_admin なら誰でも通ってしまい、
// Standard の「既定のみ」が成立しない。
//
// ミドルウェアではなく各ハンドラ内で呼ぶのは、premium_avatar ゲートと同じ順序
// (body検証400 → テナント解決400 → プラン403)を保つため。順序を変えると、
// 不正なbodyが403として返るなど、呼び出し側の切り分けが変わる。
async function denyIfCannotCustomize(req: Request, res: Response, tenantId: string): Promise<boolean> {
  const isSuperAdmin = (req as AuthedReq).user?.role === "super_admin";
  const denial = await avatarCustomizeDenial(getPool(), isSuperAdmin, tenantId);
  if (!denial) return false;
  res.status(403).json(denial);
  return true;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAvatarGenerationRoutes(app: Express, _db: any): void {
  app.use("/v1/admin/avatar", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/generate-image
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/generate-image",
    ...AVATAR_GEN_AUTHZ,
    async (req: Request, res: Response) => {
      const parsed = generateImageSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { description } = parsed.data;

      // Phase5-D: 禁止ワードチェック（二重防御）
      if (containsBannedWord(description)) {
        return res.status(400).json({ error: "このプロンプトにはビジネスに不適切な表現が含まれています" });
      }

      const tenantId: string = resolveEffectiveTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: "テナント情報が取得できません" });
      }
      if (await denyIfCannotCustomize(req, res, tenantId)) return;
      const requestId: string =
        (req as AvatarReq).requestId ?? crypto.randomUUID();

      try {
        // Step 1: Groq LLM で Leonardo.ai 用英語プロンプト生成
        const leonardoPrompt = await callGroqLLM(
          `Convert the user's description into an English prompt for AI image generation.
The prompt must describe a photorealistic professional headshot portrait.
Include these elements:
- "professional headshot portrait photograph"
- "single person, one face, solo portrait"
- "front facing, looking at camera, centered face, passport photo style"
- specific physical features mentioned by the user (age, gender, hair, clothing)
- "natural studio lighting, soft shadows"
- "looking directly at camera, neutral or office background"
- "high resolution, detailed skin texture"
Do NOT include any anime, cartoon, or illustration-related terms.
Output ONLY the English prompt, nothing else.`,
          description
        );

        logger.info("[generate-image] prompt generated", { requestId, tenantId, leonardoPrompt });

        // Step 2: Leonardo.ai で4枚生成（2段階: POST生成 → GETポーリング）
        const leonardoKey = process.env.LEONARDO_API_KEY?.trim();
        if (!leonardoKey) {
          return res
            .status(500)
            .json({ error: "Leonardo API key not configured" });
        }

        const LEONARDO_BASE = "https://cloud.leonardo.ai/api/rest/v1";

        // 2a. 生成ジョブ作成
        const genRes = await fetch(`${LEONARDO_BASE}/generations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${leonardoKey}`,
          },
          body: JSON.stringify({
            prompt: leonardoPrompt,
            negative_prompt:
              "nude, nsfw, violent, gore, copyrighted character, celebrity, anime, manga, cartoon, illustration, CGI, 3D render, painting, drawing, sketch, deformed face, extra fingers, blurry, watermark, text, logo, multiple faces, two faces, duplicate face, side view, profile view, turned head, looking away, three-quarter view",
            nsfw: false,
            sd_version: "PHOENIX",
            presetStyle: "PHOTOGRAPHY",
            alchemy: true,
            num_images: 4,
            width: 512,
            height: 768,
            public: false,
            enhancePrompt: false,
          }),
        });

        if (!genRes.ok) {
          const text = await genRes.text();
          throw new Error(`Leonardo generation error ${genRes.status}: ${text.slice(0, 200)}`);
        }

        const genData = await genRes.json() as Record<string, unknown>;
        const sdJob = genData?.sdGenerationJob as Record<string, unknown> | undefined;
        const gByPk = genData?.generations_by_pk as Record<string, unknown> | undefined;
        const generationId: string =
          sdJob?.generationId as string ??
          gByPk?.id as string ??
          genData?.id as string ?? "";

        if (!generationId) {
          throw new Error("Leonardo: generationId not found in response");
        }

        // 2b. ポーリング（最大30秒、2秒間隔）
        const pollUntilComplete = async (): Promise<string[]> => {
          const maxAttempts = 15;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise((r) => setTimeout(r, 2000));
            const pollRes = await fetch(`${LEONARDO_BASE}/generations/${generationId}`, {
              headers: { Authorization: `Bearer ${leonardoKey}` },
            });
            if (!pollRes.ok) continue;
            const pollData = await pollRes.json() as Record<string, unknown>;
            const gen = (
              pollData?.generations_by_pk ??
              pollData?.generation ??
              pollData
            ) as Record<string, unknown>;
            if (gen?.status === "COMPLETE") {
              const imgs: string[] = ((gen?.generated_images ?? []) as Array<{ url?: string } | null>)
                .map((img) => img?.url ?? "")
                .filter(Boolean);
              return imgs;
            }
            if (gen?.status === "FAILED") {
              throw new Error("Leonardo generation failed");
            }
          }
          throw new Error("Leonardo generation timed out");
        };

        const images = await pollUntilComplete();
        logger.info("[generate-image] images generated", { requestId, tenantId, count: images.length, urls: images });

        // Step 3: Usage tracking
        trackUsage({
          tenantId,
          requestId,
          featureUsed: "avatar_config_image",
          model: "leonardo-photorealistic",
          inputTokens: 0,
          outputTokens: 0,
          imageCount: images.length,
        });

        return res.json({ images });
      } catch (err) {
        logger.warn("[POST /v1/admin/avatar/generate-image]", err);
        return res
          .status(500)
          .json({ error: "画像生成に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/match-voice
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/match-voice",
    ...AVATAR_GEN_AUTHZ,
    async (req: Request, res: Response) => {
      const parsed = matchVoiceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { description } = parsed.data;
      const tenantId: string = resolveEffectiveTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: "テナント情報が取得できません" });
      }
      if (await denyIfCannotCustomize(req, res, tenantId)) return;
      const requestId: string =
        (req as AvatarReq).requestId ?? crypto.randomUUID();

      try {
        // Step 1: Groq LLM でキーワード抽出（日本語優先）
        const keyword = await callGroqLLM(
          `ユーザーの声の説明から、Fish Audio APIの検索に使う日本語キーワードを1〜2語抽出してください。
例: 「若い女性」「落ち着いた男性」「明るい」「プロフェッショナル」など。
日本語のキーワードのみ返してください。説明や英語は不要です。`,
          description
        );

        // Step 2: Fish Audio API で検索（language=ja フィルタ付き）
        const fishApiKey = process.env.FISH_AUDIO_API_KEY?.trim();
        if (!fishApiKey) {
          return res
            .status(500)
            .json({ error: "Fish Audio API key not configured" });
        }

        const FISH_BASE = "https://api.fish.audio/model";
        const encodedKeyword = encodeURIComponent(keyword.trim());

        const fishRes = await fetch(
          `${FISH_BASE}?page_size=10&page_number=1&sort_by=score&language=ja&title=${encodedKeyword}`,
          { headers: { Authorization: `Bearer ${fishApiKey}` } }
        );

        if (!fishRes.ok) {
          const text = await fishRes.text();
          throw new Error(`Fish Audio API error ${fishRes.status}: ${text}`);
        }

        const fishData = await fishRes.json() as Record<string, unknown>;
        let models: Array<Record<string, unknown>> = (fishData.items ?? fishData.data ?? (Array.isArray(fishData) ? fishData : [])) as Array<Record<string, unknown>>;

        // Step 2b: キーワード検索が0件 → language=ja の人気順トップにフォールバック
        if (models.length === 0) {
          logger.info(`[match-voice] keyword "${keyword}" returned 0 results, falling back to language=ja top models`);
          const fallbackRes = await fetch(
            `${FISH_BASE}?page_size=10&page_number=1&sort_by=score&language=ja`,
            { headers: { Authorization: `Bearer ${fishApiKey}` } }
          );
          if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json() as Record<string, unknown>;
            models = (fallbackData.items ?? fallbackData.data ?? (Array.isArray(fallbackData) ? fallbackData : [])) as Array<Record<string, unknown>>;
          }
        }

        // Step 3: Groq LLM でランキング + 日本語推薦コメント
        // Groqに渡す前に必要フィールドのみ抽出（トークン節約）
        const modelSummaries = models.slice(0, 10).map((m: any) => ({
          id: m._id ?? m.id ?? "",
          title: m.title ?? m.name ?? "",
          description: m.description ?? "",
          tags: m.tags ?? [],
          languages: m.languages ?? [],
        }));

        const rankingResult = await callGroqLLM(
          `あなたは音声モデルの専門家です。以下のFish Audioの音声モデルリストから、ユーザーの要望に最も合うものをTop5でランキングしてください。
モデルの "_id" フィールドをそのまま "id" として使用してください。
JSON配列で返してください: [{"id": "モデルの_id値", "title": "モデル名", "description": "日本語での推薦コメント（30字以内）", "score": 0.0-1.0}]
JSONのみ返してください。`,
          `ユーザーの要望: ${description}\n\nモデルリスト:\n${JSON.stringify(modelSummaries, null, 2)}`
        );

        let recommendations: Array<{
          id: string;
          title: string;
          description: string;
          score: number;
        }> = [];
        try {
          const cleaned = rankingResult
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
          recommendations = JSON.parse(cleaned);
        } catch {
          // If parsing fails, return raw models as fallback
          recommendations = (Array.isArray(models) ? models : [])
            .slice(0, 5)
            .map((m: any, i: number) => ({
              id: m._id ?? m.id ?? `unknown-${i}`,
              title: m.title ?? m.name ?? "Unknown",
              description: m.description ?? "",
              score: 1 - i * 0.1,
            }));
        }

        // Step 4: Usage tracking
        trackUsage({
          tenantId,
          requestId,
          featureUsed: "avatar_config_voice",
          model: GPT_OSS_120B,
          inputTokens: 0,
          outputTokens: 0,
        });

        return res.json({ recommendations });
      } catch (err) {
        logger.warn("[POST /v1/admin/avatar/match-voice]", err);
        return res
          .status(500)
          .json({ error: "声マッチングに失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/design-voice
  // GID 1217084040137242: 説明文から声の候補を生成する(Fish Audio Voice Design)。
  // 実音声ファイルが不要な点が voice-clone / match-voice との違い。
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/design-voice",
    ...AVATAR_GEN_AUTHZ,
    async (req: Request, res: Response) => {
      const parsed = designVoiceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { instruction, reference_text, n, speed } = parsed.data;

      // Phase5-D: 禁止ワードチェック（二重防御。generate-imageと同じ判定を再利用）
      if (containsBannedWord(instruction)) {
        return res.status(400).json({ error: "この指示にはビジネスに不適切な表現が含まれています" });
      }

      const tenantId: string = resolveEffectiveTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: "テナント情報が取得できません" });
      }
      if (await denyIfCannotCustomize(req, res, tenantId)) return;
      const requestId: string =
        (req as AvatarReq).requestId ?? crypto.randomUUID();

      const fishApiKey = process.env.FISH_AUDIO_API_KEY?.trim();
      if (!fishApiKey) {
        return res
          .status(500)
          .json({ error: "Fish Audio API key not configured" });
      }

      try {
        // GID 1217084040142043 (スパイク調査で実API確認済み):
        // model は JSON body ではなく HTTP ヘッダで送る。TTS/ASR の body 指定と混同しないこと。
        const fishRes = await fetch("https://api.fish.audio/v1/voice-design", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fishApiKey}`,
            model: "voice-design-1",
          },
          body: JSON.stringify({
            instruction,
            language: "ja",
            ...(reference_text ? { reference_text } : {}),
            ...(n !== undefined ? { n } : {}),
            ...(speed !== undefined ? { speed } : {}),
          }),
        });

        if (!fishRes.ok) {
          // 公式仕様: 失敗リクエストは非課金。trackUsageを呼ばない。
          const detail = await fishRes.text().catch(() => "");
          logger.warn(
            { status: fishRes.status, detail: detail.slice(0, 300), tenantId },
            "[design-voice] Fish Audio API error",
          );
          return res.status(502).json({ error: "声の生成に失敗しました" });
        }

        const data = (await fishRes.json()) as {
          candidates?: Array<{
            id: string;
            index: number;
            audio_base64: string;
            sample_rate: number;
            duration_ms: number;
            text?: string | null;
            language?: string | null;
          }>;
        };
        const candidates = data.candidates ?? [];

        // Step: Usage tracking（成功時のみ計上。avatar_config_voiceはEND_USER_FEATURES外＝原価のみ）
        trackUsage({
          tenantId,
          requestId,
          featureUsed: "avatar_config_voice",
          model: "fish-audio-voice-design-1",
          inputTokens: 0,
          outputTokens: 0,
          voiceDesignRequestCount: 1,
        });

        return res.json({
          candidates: candidates.map((c) => ({
            id: c.id,
            index: c.index,
            audioBase64: c.audio_base64,
            sampleRate: c.sample_rate,
            durationMs: c.duration_ms,
            text: c.text ?? null,
            language: c.language ?? null,
          })),
        });
      } catch (err) {
        logger.warn("[POST /v1/admin/avatar/design-voice]", err);
        return res
          .status(500)
          .json({ error: "声の生成に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/avatar/generate-prompt
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/generate-prompt",
    ...AVATAR_GEN_AUTHZ,
    async (req: Request, res: Response) => {
      const parsed = generatePromptSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { rules } = parsed.data;
      const tenantId: string = resolveEffectiveTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: "テナント情報が取得できません" });
      }
      if (await denyIfCannotCustomize(req, res, tenantId)) return;
      const requestId: string =
        (req as AvatarReq).requestId ?? crypto.randomUUID();

      try {
        // Step 1: Groq LLM で SYSTEM_PROMPT + emotion_tags 生成
        const result = await callGroqLLM(
          'あなたはAIアバターのプロンプトエンジニアです。ユーザーが提供する接客ルールとペルソナ情報から、以下のJSON形式で出力してください:\n{"system_prompt": "...", "emotion_tags": ["happy", "professional", ...]}\nJSONのみ返してください。',
          rules
        );

        let parsed_result: {
          system_prompt: string;
          emotion_tags: string[];
        };
        try {
          const cleaned = result
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
          parsed_result = JSON.parse(cleaned);
        } catch {
          return res
            .status(500)
            .json({ error: "LLMの出力をパースできませんでした" });
        }

        // Step 2: Usage tracking
        trackUsage({
          tenantId,
          requestId,
          featureUsed: "avatar_config_prompt",
          model: GPT_OSS_120B,
          inputTokens: 0,
          outputTokens: 0,
        });

        return res.json({
          system_prompt: parsed_result.system_prompt,
          emotion_tags: parsed_result.emotion_tags,
        });
      } catch (err) {
        logger.warn("[POST /v1/admin/avatar/generate-prompt]", err);
        return res
          .status(500)
          .json({ error: "プロンプト生成に失敗しました" });
      }
    }
  );
}
