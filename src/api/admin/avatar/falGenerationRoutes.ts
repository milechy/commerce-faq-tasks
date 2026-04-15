// src/api/admin/avatar/falGenerationRoutes.ts
// Phase64 タスク4: fal.ai Flux Pro v1.1 を使ったアバター画像生成API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import { logger } from "../../../lib/logger";

type AuthReq = Request & { supabaseUser?: Record<string, unknown>; requestId?: string };

const FAL_BASE = "https://fal.run/fal-ai/flux-pro/v1.1";

// ── リクエストスキーマ ─────────────────────────────────────────────────────────

const generateSchema = z.object({
  prompt: z.string().min(10).max(2000),
  negativePrompt: z.string().max(1000).optional(),
  numImages: z.number().int().min(1).max(4).default(4),
});

// ── Supabase Storage アップロード（公開URL変換）─────────────────────────────

async function uploadImageFromUrl(
  imageUrl: string,
  tenantId: string,
  filename: string
): Promise<string | null> {
  if (!supabaseAdmin) return imageUrl;

  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return imageUrl;
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";
    const filePath = `${tenantId}/${filename}.${ext}`;

    const { error } = await supabaseAdmin.storage
      .from("avatar-images")
      .upload(filePath, buffer, { contentType, upsert: true });

    if (error) {
      logger.warn("[fal] supabase upload failed:", error.message);
      return imageUrl; // フォールバック: fal.ai URL をそのまま使う
    }

    const { data } = supabaseAdmin.storage.from("avatar-images").getPublicUrl(filePath);
    return data?.publicUrl ?? imageUrl;
  } catch (err) {
    logger.warn("[fal] uploadImageFromUrl error:", err);
    return imageUrl;
  }
}

// ── ルート登録 ────────────────────────────────────────────────────────────────

export function registerFalGenerationRoutes(app: Express): void {
  app.use("/v1/admin/avatar/fal", supabaseAuthMiddleware);

  // POST /v1/admin/avatar/fal/generate
  app.post(
    "/v1/admin/avatar/fal/generate",
    async (req: Request, res: Response) => {
      const parsed = generateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { prompt, negativePrompt, numImages } = parsed.data;

      const su = (req as AuthReq).supabaseUser;
      const suMeta = su?.app_metadata as Record<string, unknown> | undefined;
      const tenantId = (suMeta?.tenant_id as string) ?? "";
      const requestId = (req as AuthReq).requestId ?? crypto.randomUUID();

      const falKey = process.env.FAL_KEY?.trim();
      if (!falKey) {
        return res.status(500).json({ error: "FAL_KEY が設定されていません" });
      }

      try {
        logger.info("[fal/generate] start", { requestId, tenantId, promptLen: prompt.length });

        const falRes = await fetch(FAL_BASE, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Key ${falKey}`,
          },
          body: JSON.stringify({
            prompt,
            negative_prompt: negativePrompt ?? "blurry, distorted, watermark, nsfw, low quality",
            num_images: numImages,
            image_size: "portrait_4_3",
            guidance_scale: 3.5,
            num_inference_steps: 28,
            enable_safety_checker: true,
            output_format: "jpeg",
          }),
        });

        if (!falRes.ok) {
          const errText = await falRes.text();
          logger.warn("[fal/generate] API error", { status: falRes.status, body: errText.slice(0, 300) });
          return res.status(502).json({ error: "画像生成サービスでエラーが発生しました" });
        }

        const falData = await falRes.json() as {
          images?: Array<{ url: string; width: number; height: number }>;
          seed?: number;
        };

        const rawImages = (falData.images ?? []).map((img) => img.url);
        if (rawImages.length === 0) {
          return res.status(502).json({ error: "画像が生成されませんでした" });
        }

        // Supabase Storageへ永続化（fal.ai URLは一時的なため）
        const images = await Promise.all(
          rawImages.map((url, i) =>
            uploadImageFromUrl(url, tenantId, `fal-${requestId}-${i}-${Date.now()}`)
          )
        );

        logger.info("[fal/generate] done", { requestId, tenantId, count: images.length });
        return res.json({ images, seed: falData.seed });
      } catch (err) {
        logger.warn("[POST /v1/admin/avatar/fal/generate]", err);
        return res.status(500).json({ error: "画像の生成に失敗しました" });
      }
    }
  );
}
