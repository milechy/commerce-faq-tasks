// src/lib/ocrPipeline.ts
// OCR pipeline: PDF → Qwen2.5-VL → embeddings → faq_embeddings

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { embedTextOpenAI } from "../agent/llm/openaiEmbeddingClient";

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
    if (chunk.length > 0) {
      result.push(chunk);
    }
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

async function renderPageToPngBuffer(
  page: PDFPageProxy
): Promise<Buffer> {
  // Lazy require to avoid test failures when native canvas module isn't available
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas } = require("canvas") as typeof import("canvas");

  const scale = 300 / 72; // DPI 300
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height)
  );
  const context = canvas.getContext("2d");

  // pdfjs-dist v5: canvas must be null when using canvasContext
  await page
    .render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    })
    .promise;

  return canvas.toBuffer("image/png");
}

async function saveChunk(
  pool: { query: (text: string, values: unknown[]) => Promise<unknown> },
  params: {
    chunkText: string;
    chunkIndex: number;
    chunkCount: number;
    page: number;
    tenantId: string;
  }
): Promise<void> {
  const embedding = await embedTextOpenAI(params.chunkText);
  const embedLiteral = `[${embedding.join(",")}]`;

  await pool.query(
    `INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
     VALUES ($1, $2, $3::vector, $4)`,
    [
      params.tenantId,
      params.chunkText,
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
}

/**
 * PDF バッファを Qwen OCR でテキスト化し faq_embeddings へ投入する。
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
  const { Pool } = require("pg") as { Pool: new (opts: object) => {
    query: (text: string, values: unknown[]) => Promise<unknown>;
    end: () => Promise<void>;
  } };
  const pool = new Pool({ connectionString: pgUrl });

  try {
    // Dynamic import for ESM-only pdfjs-dist v5
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "";

    const pdfDoc: PDFDocumentProxy = await pdfjsLib
      .getDocument({ data: new Uint8Array(pdfBuffer) })
      .promise;

    const totalPages = pdfDoc.numPages;
    let totalChunks = 0;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (pageNum > 1) {
        await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      }

      const page = await pdfDoc.getPage(pageNum);
      const pngBuffer = await renderPageToPngBuffer(page);
      const base64 = pngBuffer.toString("base64");

      const ocrText = await callQwenWithRetry(base64, pageNum, qwenApiKey);
      // 書籍内容保護: ログには先頭30文字のみ出力
      process.stdout.write(
        `[ocrPipeline] page ${pageNum}/${totalPages}: ${ocrText.slice(0, 30)}...\n`
      );

      const chunks = splitIntoChunks(ocrText, CHUNK_SIZE);

      for (let i = 0; i < chunks.length; i++) {
        await saveChunk(pool, {
          chunkText: chunks[i],
          chunkIndex: i,
          chunkCount: chunks.length,
          page: pageNum,
          tenantId,
        });
      }

      totalChunks += chunks.length;
    }

    return { pages: totalPages, chunks: totalChunks };
  } finally {
    await pool.end().catch(() => {
      // ignore pool close errors
    });
  }
}
