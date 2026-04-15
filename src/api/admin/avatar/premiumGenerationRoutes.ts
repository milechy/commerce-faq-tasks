// src/api/admin/avatar/premiumGenerationRoutes.ts
// Phase64 タスク5: Flux 2 Pro + Magnific AI プレミアムアバター生成API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import { logger } from "../../../lib/logger";
import { upscaleWithMagnific } from "../../../lib/magnific";
import { trackUsage } from "../../../lib/billing/usageTracker";

type AuthReq = Request & { supabaseUser?: Record<string, unknown>; requestId?: string };

const FAL_BASE = "https://fal.run/fal-ai/flux-pro/v1.1";

// Flux 2 Pro モデル（プレミアムは高解像度1枚）
const PREMIUM_AVATAR_PRICE_CENTS = parseInt(
  process.env.PREMIUM_AVATAR_PRICE_CENTS ?? "100",
  10
);

// ── スキーマ ──────────────────────────────────────────────────────────────────

const premiumSchema = z.object({
  prompt: z.string().min(10).max(2000),
  negativePrompt: z.string().max(1000).optional(),
});

// ── Supabase Storage アップロード ─────────────────────────────────────────────

async function uploadBase64ToStorage(
  base64: string,
  tenantId: string,
  filename: string
): Promise<string | null> {
  if (!supabaseAdmin) return null;
  try {
    const buffer = Buffer.from(base64, "base64");
    const filePath = `${tenantId}/${filename}.jpg`;
    const { error } = await supabaseAdmin.storage
      .from("avatar-images")
      .upload(filePath, buffer, { contentType: "image/jpeg", upsert: true });
    if (error) {
      logger.warn("[premium] supabase upload failed:", error.message);
      return null;
    }
    const { data } = supabaseAdmin.storage.from("avatar-images").getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err) {
    logger.warn("[premium] uploadBase64ToStorage error:", err);
    return null;
  }
}

async function uploadUrlToStorage(
  imageUrl: string,
  tenantId: string,
  filename: string
): Promise<string> {
  if (!supabaseAdmin) return imageUrl;
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return imageUrl;
    const buffer = Buffer.from(await res.arrayBuffer());
    const filePath = `${tenantId}/${filename}.jpg`;
    const { error } = await supabaseAdmin.storage
      .from("avatar-images")
      .upload(filePath, buffer, { contentType: "image/jpeg", upsert: true });
    if (error) {
      logger.warn("[premium] url upload failed:", error.message);
      return imageUrl;
    }
    const { data } = supabaseAdmin.storage.from("avatar-images").getPublicUrl(filePath);
    return data?.publicUrl ?? imageUrl;
  } catch (err) {
    logger.warn("[premium] uploadUrlToStorage error:", err);
    return imageUrl;
  }
}

// ── ルート登録 ────────────────────────────────────────────────────────────────

export function registerPremiumGenerationRoutes(app: Express): void {
  app.use("/v1/admin/avatar/generate-premium", supabaseAuthMiddleware);

  // POST /v1/admin/avatar/generate-premium
  app.post("/v1/admin/avatar/generate-premium", async (req: Request, res: Response) => {
    const parsed = premiumSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { prompt, negativePrompt } = parsed.data;

    const su = (req as AuthReq).supabaseUser;
    const suMeta = su?.app_metadata as Record<string, unknown> | undefined;
    const tenantId = (suMeta?.tenant_id as string) ?? "";
    const requestId = (req as AuthReq).requestId ?? crypto.randomUUID();

    const falKey = process.env.FAL_KEY?.trim();
    if (!falKey) {
      return res.status(500).json({ error: "FAL_KEY が設定されていません" });
    }

    logger.info("[premium/generate] start", { requestId, tenantId, promptLen: prompt.length });

    try {
      // ── ステップ1: Flux 2 Pro で高品質1枚生成 ─────────────────────────────
      const falRes = await fetch(FAL_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${falKey}`,
        },
        body: JSON.stringify({
          prompt,
          negative_prompt:
            negativePrompt ?? "blurry, distorted, watermark, nsfw, low quality",
          num_images: 1,
          image_size: "portrait_4_3",
          guidance_scale: 3.5,
          num_inference_steps: 28,
          enable_safety_checker: true,
          output_format: "jpeg",
        }),
      });

      if (!falRes.ok) {
        const errText = await falRes.text();
        logger.warn("[premium/generate] fal error", {
          status: falRes.status,
          body: errText.slice(0, 300),
        });
        return res.status(502).json({ error: "画像生成サービスでエラーが発生しました" });
      }

      const falData = await falRes.json() as {
        images?: Array<{ url: string }>;
        seed?: number;
      };
      const falImageUrl = falData.images?.[0]?.url;
      if (!falImageUrl) {
        return res.status(502).json({ error: "画像が生成されませんでした" });
      }

      logger.info("[premium/generate] fal done", { requestId, falImageUrl: falImageUrl.slice(0, 60) });

      // Supabase Storageにオリジナル保存
      const ts = Date.now();
      const originalUrl = await uploadUrlToStorage(
        falImageUrl,
        tenantId,
        `premium-orig-${requestId}-${ts}`
      );

      // ── ステップ2: Magnific AI アップスケール（FREEPIK_API_KEY設定時のみ） ─
      let enhancedUrl = originalUrl;
      const freepikKey = process.env.FREEPIK_API_KEY?.trim();

      if (freepikKey) {
        try {
          // fal.ai 画像をbase64変換
          const imgRes = await fetch(falImageUrl);
          const imgBuf = await imgRes.arrayBuffer();
          const imageBase64 = Buffer.from(imgBuf).toString("base64");

          const magnResult = await upscaleWithMagnific({
            imageBase64,
            scaleFactor: 2,
            creativity: "low",
            style: "portrait",
          });

          if (magnResult) {
            const savedUrl = await uploadBase64ToStorage(
              magnResult.imageBase64,
              tenantId,
              `premium-enhanced-${requestId}-${ts}`
            );
            enhancedUrl = savedUrl ?? originalUrl;
            logger.info("[premium/generate] magnific done", {
              requestId,
              taskId: magnResult.taskId,
            });
          }
        } catch (magnErr) {
          // Magnificエラーはフォールバック（オリジナル画像を使用）
          logger.warn("[premium/generate] magnific failed, using original", { magnErr });
          enhancedUrl = originalUrl;
        }
      } else {
        logger.warn("[premium/generate] FREEPIK_API_KEY not set — skipping Magnific");
      }

      // ── 課金記録 ──────────────────────────────────────────────────────────
      if (tenantId) {
        trackUsage({
          tenantId,
          requestId,
          model: "flux-pro-v1.1",
          inputTokens: 0,
          outputTokens: 0,
          featureUsed: "premium_avatar_generation",
          imageCount: 1,
          marginOverride: PREMIUM_AVATAR_PRICE_CENTS / 100, // $1.00相当
        });
      }

      logger.info("[premium/generate] complete", { requestId, tenantId });

      return res.json({
        imageUrl: enhancedUrl,
        originalUrl,
        enhancedUrl,
      });
    } catch (err) {
      logger.warn("[POST /v1/admin/avatar/generate-premium]", err);
      return res.status(500).json({ error: "プレミアム画像の生成に失敗しました" });
    }
  });
}
