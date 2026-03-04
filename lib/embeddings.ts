/**
 * lib/embeddings.ts
 *
 * OpenAI text-embedding-3-small を使ったテキスト埋め込み生成。
 *
 * - 1536 次元ベクター（pgvector / Pinecone と互換）
 * - バッチ対応（最大 100 テキスト）
 * - 書籍テキストの埋め込みに使用する場合、生テキストは API に送信されるが
 *   戻り値（ベクター）のみを保持し、生テキストはログに出力しないこと
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMENSIONS = 1536;

export interface EmbedResult {
  embedding: number[];
  totalTokens: number;
  latencyMs: number;
}

export interface EmbedBatchResult {
  embeddings: number[][];
  totalTokens: number;
  latencyMs: number;
  note?: string;
}

interface OpenAIEmbedResponse {
  data: { index: number; embedding: number[] }[];
  usage: { total_tokens: number };
}

/**
 * 単一テキストの埋め込みを生成する。
 *
 * @param text - 埋め込み対象テキスト（書籍内容を含む場合も可）
 * @throws {EmbedError} OpenAI API エラー時
 */
export async function embed(text: string): Promise<EmbedResult> {
  const result = await embedBatch([text]);
  return {
    embedding: result.embeddings[0] ?? [],
    totalTokens: result.totalTokens,
    latencyMs: result.latencyMs,
  };
}

/**
 * 複数テキストの埋め込みをバッチ生成する（最大 100 件）。
 *
 * 大量インデックス構築時のレート制限対策として、
 * 100 件を超える場合は呼び出し元でチャンク分割すること。
 */
export async function embedBatch(texts: string[]): Promise<EmbedBatchResult> {
  if (!OPENAI_API_KEY) {
    return {
      embeddings: texts.map(() => new Array(EMBED_DIMENSIONS).fill(0) as number[]),
      totalTokens: 0,
      latencyMs: 0,
      note: "embeddings:not_configured",
    };
  }

  if (!texts.length) {
    return { embeddings: [], totalTokens: 0, latencyMs: 0, note: "embeddings:empty_input" };
  }

  if (texts.length > 100) {
    throw new EmbedError(
      `embedBatch: テキスト数が上限 (100) を超えています (${texts.length})。チャンク分割して呼び出してください。`,
    );
  }

  const t0 = Date.now();

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: texts,
        dimensions: EMBED_DIMENSIONS,
      }),
    });

    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      throw new EmbedError(
        `OpenAI Embeddings API error: status=${res.status}, body=${snippet}`,
        res.status,
      );
    }

    const json: OpenAIEmbedResponse = await res.json();

    // index 順に並べ直す（API は順序を保証するが念のため）
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);

    return {
      embeddings,
      totalTokens: json.usage.total_tokens,
      latencyMs,
    };
  } catch (err: unknown) {
    if (err instanceof EmbedError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new EmbedError(`OpenAI Embeddings fetch error: ${msg.slice(0, 200)}`);
  }
}

export class EmbedError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbedError";
    this.status = status;
  }
}

/** embed 用の定数エクスポート（テスト・他モジュール参照用） */
export const EMBEDDING_MODEL = EMBED_MODEL;
export const EMBEDDING_DIMENSIONS = EMBED_DIMENSIONS;
