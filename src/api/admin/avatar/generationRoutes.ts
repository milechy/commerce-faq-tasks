// src/api/admin/avatar/generationRoutes.ts
// Phase41: Avatar Customization Studio — 画像生成・声マッチング・プロンプト生成API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { trackUsage } from "../../../lib/billing/usageTracker";

// ---------------------------------------------------------------------------
// Groq LLM helper
// ---------------------------------------------------------------------------

async function callGroqLLM(system: string, user: string): Promise<string> {
  const apiKey = process.env.QWEN_API_KEY || process.env.GROQ_API_KEY;
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

  const data = (await res.json()) as any;
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
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const tenantId: string =
        su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const requestId: string =
        (req as any).requestId ?? crypto.randomUUID();

      try {
        // Step 1: Groq LLM で DALL-E 用英語プロンプト生成
        const dallePrompt = await callGroqLLM(
          "You are an expert prompt engineer for DALL-E 3. Convert the user's description into a detailed English prompt for generating a professional avatar image. Return only the prompt text.",
          description
        );

        // Step 2: DALL-E 3 で4枚生成（n=1 を4回並列）
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
          return res
            .status(500)
            .json({ error: "OpenAI API key not configured" });
        }

        const generateOne = async (): Promise<string> => {
          const dalleRes = await fetch(
            "https://api.openai.com/v1/images/generations",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${openaiKey}`,
              },
              body: JSON.stringify({
                model: "dall-e-3",
                prompt: dallePrompt,
                n: 1,
                size: "1024x1024",
                quality: "standard",
              }),
            }
          );

          if (!dalleRes.ok) {
            const text = await dalleRes.text();
            throw new Error(`DALL-E API error ${dalleRes.status}: ${text}`);
          }

          const dalleData = (await dalleRes.json()) as any;
          return dalleData.data?.[0]?.url ?? "";
        };

        const images = await Promise.all([
          generateOne(),
          generateOne(),
          generateOne(),
          generateOne(),
        ]);

        // Step 3: Usage tracking
        trackUsage({
          tenantId,
          requestId,
          featureUsed: "avatar_config_image",
          model: "dall-e-3",
          inputTokens: 0,
          outputTokens: 0,
        });

        return res.json({ images });
      } catch (err) {
        console.warn("[POST /v1/admin/avatar/generate-image]", err);
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
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const tenantId: string =
        su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const requestId: string =
        (req as any).requestId ?? crypto.randomUUID();

      try {
        // Step 1: Groq LLM でキーワード抽出
        const keyword = await callGroqLLM(
          "Extract 1-2 English keywords that best describe the voice characteristics from the user's description. Return only the keywords, nothing else.",
          description
        );

        // Step 2: Fish Audio API で検索
        const fishApiKey = process.env.FISH_AUDIO_API_KEY;
        if (!fishApiKey) {
          return res
            .status(500)
            .json({ error: "Fish Audio API key not configured" });
        }

        const encodedKeyword = encodeURIComponent(keyword.trim());
        const fishRes = await fetch(
          `https://api.fish.audio/model?page_size=10&title=${encodedKeyword}`,
          {
            headers: {
              Authorization: `Bearer ${fishApiKey}`,
            },
          }
        );

        if (!fishRes.ok) {
          const text = await fishRes.text();
          throw new Error(`Fish Audio API error ${fishRes.status}: ${text}`);
        }

        const fishData = (await fishRes.json()) as any;
        const models = fishData.items ?? fishData.data ?? fishData ?? [];

        // Step 3: Groq LLM でランキング + 日本語推薦コメント
        const rankingResult = await callGroqLLM(
          `あなたは音声モデルの専門家です。以下のFish Audioの音声モデルリストから、ユーザーの要望に最も合うものをランキングしてください。
JSON配列で返してください: [{"id": "モデルID", "title": "モデル名", "description": "日本語での推薦コメント", "score": 0.0-1.0}]
JSONのみ返してください。`,
          `ユーザーの要望: ${description}\n\nモデルリスト:\n${JSON.stringify(models, null, 2)}`
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
        console.warn("[POST /v1/admin/avatar/match-voice]", err);
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
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const tenantId: string =
        su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const requestId: string =
        (req as any).requestId ?? crypto.randomUUID();

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
        console.warn("[POST /v1/admin/avatar/generate-prompt]", err);
        return res
          .status(500)
          .json({ error: "プロンプト生成に失敗しました" });
      }
    }
  );
}
