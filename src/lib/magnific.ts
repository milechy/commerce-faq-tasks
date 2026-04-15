// src/lib/magnific.ts
// Phase64 タスク5: Freepik Magnific Upscale APIクライアント

import { logger } from "./logger";

const MAGNIFIC_BASE = "https://api.freepik.com/v1/ai/magnific-upscaler";
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 120_000;

export interface MagnificUpscaleOptions {
  /** base64エンコードされた画像（data:image/jpeg;base64,... 形式でも可） */
  imageBase64: string;
  scaleFactor?: 2 | 4;
  creativity?: "low" | "medium" | "high";
  style?: "portrait" | "generic";
}

export interface MagnificResult {
  /** base64エンコードされたアップスケール後画像 */
  imageBase64: string;
  taskId: string;
}

type TaskStatus = "pending" | "processing" | "done" | "failed" | "error";

interface CreateTaskResponse {
  data: { task_id: string };
}

interface PollResponse {
  data: {
    status: TaskStatus;
    generated?: Array<{ base64?: string; url?: string }>;
  };
}

// ── 内部ヘルパー ──────────────────────────────────────────────────────────────

function stripDataUri(base64: string): string {
  // "data:image/jpeg;base64,..." → "..."
  const idx = base64.indexOf(",");
  return idx >= 0 ? base64.slice(idx + 1) : base64;
}

async function createTask(apiKey: string, opts: MagnificUpscaleOptions): Promise<string> {
  const body = {
    image: stripDataUri(opts.imageBase64),
    scale_factor: opts.scaleFactor ?? 2,
    creativity: opts.creativity ?? "low",
    style: opts.style ?? "portrait",
  };

  const res = await fetch(MAGNIFIC_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Magnific create task failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as CreateTaskResponse;
  return data.data.task_id;
}

async function pollTask(apiKey: string, taskId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(`${MAGNIFIC_BASE}/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Magnific poll failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = await res.json() as PollResponse;
    const { status, generated } = data.data;

    if (status === "done") {
      const first = generated?.[0];
      if (first?.base64) return first.base64;
      if (first?.url) {
        // URLから取得してbase64化
        const imgRes = await fetch(first.url);
        const buf = await imgRes.arrayBuffer();
        return Buffer.from(buf).toString("base64");
      }
      throw new Error("Magnific task done but no image data returned");
    }

    if (status === "failed" || status === "error") {
      throw new Error(`Magnific task ${status}: taskId=${taskId}`);
    }

    // pending / processing → 待機
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Magnific upscale timed out after ${TIMEOUT_MS / 1000}s: taskId=${taskId}`);
}

// ── 公開API ───────────────────────────────────────────────────────────────────

/**
 * 画像をMagnific AIでアップスケールする。
 * FREEPIK_API_KEY が未設定の場合は null を返す（スキップ）。
 */
export async function upscaleWithMagnific(
  opts: MagnificUpscaleOptions
): Promise<MagnificResult | null> {
  const apiKey = process.env.FREEPIK_API_KEY?.trim();
  if (!apiKey) {
    logger.warn("[magnific] FREEPIK_API_KEY not set — skipping upscale");
    return null;
  }

  logger.info("[magnific] creating upscale task");
  const taskId = await createTask(apiKey, opts);
  logger.info("[magnific] polling task", { taskId });

  const imageBase64 = await pollTask(apiKey, taskId);
  logger.info("[magnific] task complete", { taskId });

  return { imageBase64, taskId };
}
