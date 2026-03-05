import { embedTextOpenAI } from "../src/agent/llm/openaiEmbeddingClient";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg") as { Pool: any };

const TARGET_TENANT_ID = "carnation";
const CHUNK_SIZE = 500;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "commerce-faq-tasks-carnation-scraper/1.0 (+https://www.s-time.co.jp/company/)";

const TARGET_URLS = [
  "https://www.s-time.co.jp/faq/",
  "https://www.s-time.co.jp/portfolio-item/car-concierge/",
  "https://www.s-time.co.jp/portfolio-item/warranty-service/",
  "https://www.s-time.co.jp/portfolio-item/autoloan/",
  "https://www.s-time.co.jp/portfolio-item/in-house-certified-factory/",
  "https://www.s-time.co.jp/company/",
] as const;

const pgUrl = process.env.DATABASE_URL;
if (!pgUrl) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new Pool({ connectionString: pgUrl });

function stripHtmlToText(html: string): string {
  const withoutIgnoredTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");

  const withLineHints = withoutIgnoredTags
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/div>/gi, "\n");

  const plain = withLineHints
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');

  return plain
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    start = end;
  }
  return chunks;
}

async function fetchHtmlWithRetry(url: string): Promise<string> {
  const tryFetch = async (): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    return await tryFetch();
  } catch (firstError) {
    console.warn(`[scrape-carnation] first attempt failed: ${url}`, firstError);
    return await tryFetch();
  }
}

async function saveChunk(params: {
  url: string;
  chunkText: string;
  chunkIndex: number;
  chunkCount: number;
}): Promise<void> {
  const embedding = await embedTextOpenAI(params.chunkText);
  const embedLiteral = `[${embedding.join(",")}]`;

  await pool.query(
    `
      INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
      VALUES ($1, $2, $3::vector, $4)
    `,
    [
      TARGET_TENANT_ID,
      params.chunkText,
      embedLiteral,
      {
        source: "carnation:web",
        url: params.url,
        chunkIndex: params.chunkIndex,
        chunkCount: params.chunkCount,
        chunkSize: CHUNK_SIZE,
        scrapedAt: new Date().toISOString(),
      },
    ]
  );
}

async function main(): Promise<void> {
  console.log("[scrape-carnation] start");
  console.log(`[scrape-carnation] tenant=${TARGET_TENANT_ID}`);

  for (const url of TARGET_URLS) {
    console.log(`[scrape-carnation] fetching: ${url}`);
    const html = await fetchHtmlWithRetry(url);
    const text = stripHtmlToText(html);
    const chunks = splitIntoChunks(text, CHUNK_SIZE);

    if (chunks.length === 0) {
      console.warn(`[scrape-carnation] no chunks extracted: ${url}`);
      continue;
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      await saveChunk({
        url,
        chunkText: chunk,
        chunkIndex: i,
        chunkCount: chunks.length,
      });
    }

    console.log(`[scrape-carnation] inserted ${chunks.length} chunks: ${url}`);
  }

  await pool.end();
  console.log("[scrape-carnation] done");
}

main().catch(async (err: unknown) => {
  console.error("[scrape-carnation] failed", err);
  try {
    await pool.end();
  } catch {
    // ignore pool close error on crash path
  }
  process.exit(1);
});
