/**
 * lib/pinecone.ts
 *
 * Pinecone ベクター検索クライアント。
 * tenantId フィルタは常に強制注入され、省略不可。
 * RAG 抜粋は呼び出し元で .slice(0, 200) を適用すること。
 */

const PINECONE_API_KEY = process.env.PINECONE_API_KEY ?? "";
const PINECONE_HOST = process.env.PINECONE_HOST ?? ""; // e.g. https://index-name-xxxx.svc.environment.pinecone.io

export interface PineconeHit {
  id: string;
  score: number;
  /** 生テキスト。RAG 利用時は必ず .slice(0, 200) を適用すること */
  text: string;
  metadata?: Record<string, unknown>;
}

export interface PineconeSearchResult {
  hits: PineconeHit[];
  latencyMs: number;
  note?: string;
}

export interface PineconeSearchParams {
  /** JWT 由来の tenantId（body からの取得禁止） */
  tenantId: string;
  embedding: number[];
  topK?: number;
  namespace?: string;
}

interface PineconeMatch {
  id: string;
  score: number;
  metadata?: {
    tenantId?: string;
    text?: string;
    [key: string]: unknown;
  };
}

interface PineconeQueryResponse {
  matches?: PineconeMatch[];
}

/**
 * Pinecone REST API を使ったマルチテナント対応ベクター検索。
 *
 * tenantId メタデータフィルタを強制注入するため、
 * 呼び出し側が独自にフィルタを上書きすることはできない。
 */
export async function searchPinecone(
  params: PineconeSearchParams,
): Promise<PineconeSearchResult> {
  const { tenantId, embedding, topK = 20, namespace } = params;

  if (!PINECONE_API_KEY || !PINECONE_HOST) {
    return { hits: [], latencyMs: 0, note: "pinecone:not_configured" };
  }

  if (!embedding.length) {
    return { hits: [], latencyMs: 0, note: "pinecone:empty_embedding" };
  }

  const t0 = Date.now();

  const body: Record<string, unknown> = {
    vector: embedding,
    topK,
    includeMetadata: true,
    // tenantId フィルタを強制注入 — これを除去・上書きすることは禁止
    filter: { tenantId: { $eq: tenantId } },
  };

  if (namespace) {
    body.namespace = namespace;
  }

  try {
    const res = await fetch(`${PINECONE_HOST}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": PINECONE_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      return {
        hits: [],
        latencyMs,
        note: `pinecone:http_error:${res.status}:${snippet}`,
      };
    }

    const json: PineconeQueryResponse = await res.json();
    const matches = json.matches ?? [];

    const hits: PineconeHit[] = matches.map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      // text は metadata.text から取得する。RAG 利用時は呼び出し元で .slice(0, 200) 必須
      text: typeof m.metadata?.text === "string" ? m.metadata.text : "",
      metadata: m.metadata,
    }));

    const note = hits.length === 0 ? "pinecone:no_hits" : undefined;

    return { hits, latencyMs, note };
  } catch (err: unknown) {
    const latencyMs = Date.now() - t0;
    const msg =
      err instanceof Error ? err.message : String(err);
    return {
      hits: [],
      latencyMs,
      note: `pinecone:fetch_error:${msg.slice(0, 100)}`,
    };
  }
}

/**
 * Pinecone にベクターを upsert する（インデックス構築用）。
 * tenantId は metadata に必ず含める。
 */
export interface PineconeUpsertItem {
  id: string;
  embedding: number[];
  /** テナントID（JWT 由来） */
  tenantId: string;
  /** 暗号化済みテキスト参照 ID（生テキストは含めない） */
  textRef: string;
  metadata?: Record<string, unknown>;
}

export async function upsertPinecone(
  items: PineconeUpsertItem[],
  namespace?: string,
): Promise<{ upsertedCount: number; note?: string }> {
  if (!PINECONE_API_KEY || !PINECONE_HOST) {
    return { upsertedCount: 0, note: "pinecone:not_configured" };
  }

  if (!items.length) {
    return { upsertedCount: 0, note: "pinecone:empty_items" };
  }

  const vectors = items.map((item) => ({
    id: item.id,
    values: item.embedding,
    metadata: {
      ...item.metadata,
      tenantId: item.tenantId, // 常に上書きして整合性を保証
      textRef: item.textRef,
      // 生テキストは metadata に含めない（書籍内容漏洩防止）
    },
  }));

  const body: Record<string, unknown> = { vectors };
  if (namespace) body.namespace = namespace;

  try {
    const res = await fetch(`${PINECONE_HOST}/vectors/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": PINECONE_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      return {
        upsertedCount: 0,
        note: `pinecone:upsert_error:${res.status}:${snippet}`,
      };
    }

    const json: { upsertedCount?: number } = await res.json();
    return { upsertedCount: json.upsertedCount ?? items.length };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      upsertedCount: 0,
      note: `pinecone:upsert_fetch_error:${msg.slice(0, 100)}`,
    };
  }
}
