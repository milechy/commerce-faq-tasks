// src/api/admin/avatar/generationRoutes.ts

// Phase41: Avatar Customization Studio — 画像生成・声マッチング・プロンプト生成API

import type { Express, Request, Response } from "express";

type AvatarReq = Request & { supabaseUser?: Record<string, unknown>; requestId?: string };
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { trackUsage } from "../../../lib/billing/usageTracker";
import { logger } from '../../../lib/logger';

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
      model: "llama-3.3-70b-versatile",
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

const generatePromptSchema = z.object({
  rules: z.string().min(1).max(2000),
});

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
    async (req: Request, res: Response) => {
      const parsed = generateImageSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { description } = parsed.data;
      const su = (req as AvatarReq).supabaseUser;
      const suMeta = (su?.app_metadata as Record<string, unknown> | undefined);
      const tenantId: string =
        suMeta?.tenant_id as string ?? su?.tenant_id as string ?? "";
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
              "anime, cartoon, illustration, CGI, 3D render, painting, drawing, sketch, deformed face, extra fingers, blurry, watermark, text, logo, multiple faces, two faces, duplicate face, side view, profile view, turned head, looking away, three-quarter view",
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
    async (req: Request, res: Response) => {
      const parsed = matchVoiceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { description } = parsed.data;
      const su = (req as AvatarReq).supabaseUser;
      const suMeta = (su?.app_metadata as Record<string, unknown> | undefined);
      const tenantId: string =
        suMeta?.tenant_id as string ?? su?.tenant_id as string ?? "";
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
          model: "llama-3.3-70b-versatile",
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
  // POST /v1/admin/avatar/generate-prompt
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/avatar/generate-prompt",
    async (req: Request, res: Response) => {
      const parsed = generatePromptSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { rules } = parsed.data;
      const su = (req as AvatarReq).supabaseUser;
      const suMeta = (su?.app_metadata as Record<string, unknown> | undefined);
      const tenantId: string =
        suMeta?.tenant_id as string ?? su?.tenant_id as string ?? "";
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
          model: "llama-3.3-70b-versatile",
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
