// src/lib/ocrPipeline.ts
// OCR pipeline: PDF → pdf2pic(GraphicsMagick) → Qwen2.5-VL → embeddings → faq_embeddings

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromPath } from "pdf2pic";
import { embedTextWithUsage } from "../agent/llm/openaiEmbeddingClient";
import { encryptText } from "./crypto/textEncrypt";
import { trackUsage } from "./billing/usageTracker";

const CHUNK_SIZE = 500;
const PAGE_DELAY_MS = 6000;
const QWEN_API_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_MODEL = "qwen-vl-max-latest";
const MAX_RETRIES = 3;

export interface OcrPipelineResult {
  pages: number;
  chunks: number;
}

/** テキストを chunkSize 文字単位で分割する */
export function splitIntoChunks(text: string, chunkSize: number): string[] {
  if (!text) return [];
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) result.push(chunk);
    start = end;
  }
  return result;
}

async function callQwenWithRetry(
  base64Image: string,
  pageNum: number,
  qwenApiKey: string
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      const res = await fetch(QWEN_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${qwenApiKey}`,
        },
        body: JSON.stringify({
          model: QWEN_MODEL,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "この画像のテキストを正確に抽出してください。レイアウトは無視してテキストのみ出力してください。",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 4096,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "(empty)");
        throw new Error(
          `Qwen API HTTP ${res.status}: ${errBody.slice(0, 100)}`
        );
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("Qwen returned empty content");

      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Qwen API failed after all retries");
}

/** @returns 埋め込みに使ったOpenAIトークン数（課金集計用、テストモードでは0） */
async function saveChunk(
  pool: { query: (text: string, values: unknown[]) => Promise<unknown> },
  params: {
    chunkText: string;
    chunkIndex: number;
    chunkCount: number;
    page: number;
    tenantId: string;
  }
): Promise<number> {
  // PR-2(2026-08-25収益監査): skipTracking=true — このトークンは runOcrPipeline末尾で
  // 全チャンク分を合算し extraLlmUsages としてジョブ単位の1行に内包する(下記参照)。
  // ここで計上すると、チャンクごとに tenant_id='unknown' の行が別途できて二重計上になる。
  const { embedding, totalTokens } = await embedTextWithUsage(params.chunkText, { skipTracking: true });
  const embedLiteral = `[${embedding.join(",")}]`;
  const encryptedText = encryptText(params.chunkText);

  await pool.query(
    `INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
     VALUES ($1, $2, $3::vector, $4)`,
    [
      params.tenantId,
      encryptedText,
      embedLiteral,
      {
        source: "book:pdf:qwen-ocr",
        page: params.page,
        chunkIndex: params.chunkIndex,
        chunkCount: params.chunkCount,
        processedAt: new Date().toISOString(),
      },
    ]
  );

  return totalTokens;
}

/**
 * PDF バッファを Qwen OCR でテキスト化し faq_embeddings へ投入する。
 * Buffer はいったん /tmp に書き出してから pdf2pic で変換する。
 * 書籍内容はログに出力しない（先頭30文字 + "..." のみ）。
 */
export async function runOcrPipeline(
  pdfBuffer: Buffer,
  tenantId: string
): Promise<OcrPipelineResult> {
  const pgUrl = process.env.DATABASE_URL;
  if (!pgUrl) throw new Error("DATABASE_URL is not set");

  const qwenApiKey = process.env.QWEN_API_KEY;
  if (!qwenApiKey) throw new Error("QWEN_API_KEY is not set");

  // Lazy require to avoid module-level side effects during tests
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require("pg") as {
    Pool: new (opts: object) => {
      query: (text: string, values: unknown[]) => Promise<unknown>;
      end: () => Promise<void>;
    };
  };
  const pool = new Pool({ connectionString: pgUrl });

  // Buffer → /tmp に一時PDF保存 → pdf2pic で変換
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-pipeline-"));
  const tmpPdfPath = path.join(tmpDir, "input.pdf");
  fs.writeFileSync(tmpPdfPath, pdfBuffer);

  try {
    const convert = fromPath(tmpPdfPath, {
      density: 300,
      saveFilename: "page",
      savePath: tmpDir,
      format: "png",
      width: 2480,
      height: 3508,
    });

    const result = await convert.bulk(-1, { responseType: "image" });
    const imagePaths = result
      .filter((r) => r.path)
      .map((r) => r.path as string);

    const totalPages = imagePaths.length;
    let totalChunks = 0;
    let totalEmbeddingTokens = 0;

    for (let i = 0; i < imagePaths.length; i++) {
      const pageNum = i + 1;

      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      }

      const base64 = fs.readFileSync(imagePaths[i]).toString("base64");
      const ocrText = await callQwenWithRetry(base64, pageNum, qwenApiKey);

      // 書籍内容保護: テキスト内容をログに含めない（Anti-Slopルール準拠）
      process.stdout.write(
        `[ocrPipeline] page ${pageNum}/${totalPages}: ${ocrText.length} chars extracted\n`
      );

      const chunks = splitIntoChunks(ocrText, CHUNK_SIZE);

      for (let j = 0; j < chunks.length; j++) {
        totalEmbeddingTokens += await saveChunk(pool, {
          chunkText: chunks[j],
          chunkIndex: j,
          chunkCount: chunks.length,
          page: pageNum,
          tenantId,
        });
      }

      totalChunks += chunks.length;
    }

    // GID 1216944049264977: Qwen OCR(全ページ) + OpenAI embedding(全チャンク)は
    // これまで未計測だった。請求は usage_logs の行数ベースのため、ページ/チャンク単位で
    // 別行を作らず1回のPDF取り込みにつき1リクエストとしてまとめて記録する。
    if (totalPages > 0) {
      trackUsage({
        tenantId,
        requestId: `ocr-pipeline:${crypto.randomUUID()}`,
        model: QWEN_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: "book_analysis",
        ocrPages: totalPages,
        extraLlmUsages:
          totalEmbeddingTokens > 0
            ? [{ model: "openai-embedding", inputTokens: totalEmbeddingTokens, outputTokens: 0 }]
            : undefined,
      });
    }

    return { pages: totalPages, chunks: totalChunks };
  } finally {
    // 一時ファイルを必ず削除
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await pool.end().catch(() => {
      // ignore pool close errors
    });
  }
}
