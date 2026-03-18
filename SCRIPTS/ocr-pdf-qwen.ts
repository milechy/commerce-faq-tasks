import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromPath } from "pdf2pic";
import { embedTextOpenAI } from "../src/agent/llm/openaiEmbeddingClient";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg") as { Pool: any };

const CHUNK_SIZE = 500;
const PAGE_DELAY_MS = 6000;
const QWEN_API_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_MODEL = "qwen-vl-max-latest";
const MAX_RETRIES = 3;

const pgUrl = process.env.DATABASE_URL;
if (!pgUrl) {
  console.error("[ocr-pdf-qwen] ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const qwenApiKey = process.env.QWEN_API_KEY;
if (!qwenApiKey) {
  console.error("[ocr-pdf-qwen] ERROR: QWEN_API_KEY is not set.");
  process.exit(1);
}

const pool = new Pool({ connectionString: pgUrl });

function splitIntoChunks(text: string, chunkSize: number): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

async function pdfToImages(
  pdfPath: string
): Promise<{ imagePaths: string[]; tmpDir: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));

  const convert = fromPath(pdfPath, {
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

  return { imagePaths, tmpDir };
}

function imageToBase64(imagePath: string): string {
  const safePath = path.resolve(imagePath);
  return fs.readFileSync(safePath).toString("base64");
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function callQwenWithRetry(
  base64Image: string,
  pageNum: number
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
                  image_url: { url: `data:image/png;base64,${base64Image}` },
                },
              ],
            },
          ],
          max_tokens: 4096,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "(empty)");
        throw new Error(`Qwen API HTTP ${res.status}: ${errBody.slice(0, 100)}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("Qwen returned empty content");

      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[ocr-pdf-qwen] page ${pageNum} attempt ${attempt + 1} failed: ${lastError.message}`
      );
    }
  }

  throw lastError ?? new Error("Qwen API failed after all retries");
}

async function saveChunk(params: {
  pdfBaseName: string;
  chunkText: string;
  chunkIndex: number;
  chunkCount: number;
  page: number;
  tenantId: string;
}): Promise<void> {
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
        pdfName: params.pdfBaseName,
        page: params.page,
        chunkIndex: params.chunkIndex,
        chunkCount: params.chunkCount,
        processedAt: new Date().toISOString(),
      },
    ]
  );
}

async function main(): Promise<void> {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error(
      "Usage: NODE_ENV=development npx ts-node --require dotenv/config SCRIPTS/ocr-pdf-qwen.ts <PDFパス> [tenantId]"
    );
    process.exit(1);
  }

  if (!fs.existsSync(pdfPath)) {
    console.error(`[ocr-pdf-qwen] ERROR: file not found: ${pdfPath}`);
    process.exit(1);
  }

  const tenantId = process.argv[3] ?? "partner";
  const pdfBaseName = path.basename(pdfPath);

  console.log(`[ocr-pdf-qwen] start: ${pdfBaseName}, tenant=${tenantId}`);

  const { imagePaths, tmpDir } = await pdfToImages(pdfPath);
  const totalPages = imagePaths.length;

  console.log(`[ocr-pdf-qwen] pages: ${totalPages}`);

  let totalChunks = 0;

  try {
    for (let i = 0; i < imagePaths.length; i++) {
      const pageNum = i + 1;

      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      }

      console.log(`[ocr-pdf-qwen] processing page ${pageNum}/${totalPages}`);

      const base64 = imageToBase64(imagePaths[i]);
      const ocrText = await callQwenWithRetry(base64, pageNum);

      // 書籍内容保護: 先頭30文字のみログ
      console.log(`[ocr-pdf-qwen] page ${pageNum} OCR: ${ocrText.slice(0, 30)}...`);

      const chunks = splitIntoChunks(ocrText, CHUNK_SIZE);

      for (let j = 0; j < chunks.length; j++) {
        await saveChunk({
          pdfBaseName,
          chunkText: chunks[j],
          chunkIndex: j,
          chunkCount: chunks.length,
          page: pageNum,
          tenantId,
        });
      }

      totalChunks += chunks.length;
      console.log(`[ocr-pdf-qwen] page ${pageNum}: inserted ${chunks.length} chunks`);
    }
  } finally {
    cleanup(tmpDir);
  }

  await pool.end();
  console.log(
    `[ocr-pdf-qwen] done: ${totalPages} pages, ${totalChunks} chunks total`
  );
}

main().catch(async (err: unknown) => {
  console.error("[ocr-pdf-qwen] failed", err);
  try {
    await pool.end();
  } catch {
    // ignore pool close error on crash path
  }
  process.exit(1);
});
