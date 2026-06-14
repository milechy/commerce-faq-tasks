import { performance } from "node:perf_hooks";


import { decryptText } from "../lib/crypto/textEncrypt";
import { pool } from "../lib/db";
import { logger } from '../lib/logger';

export type PgvectorSearchParams = {
  tenantId: string;
  embedding: number[];
  topK?: number;
  /** Phase69-2: 検索結果から除外するエントリID一覧（テナント分離保証） */
  excludedIds?: string[];
};

export type PgvectorSearchItem = {
  id: string;
  text: string;
  score: number;
  source: "pgvector";
  /** Phase68: faq_embeddings.metadata（source='faq'|'book', principle, book_id 等） */
  metadata?: Record<string, unknown>;
};

export type PgvectorSearchResult = {
  items: PgvectorSearchItem[];
  ms: number;
};


export async function searchPgVector(
  params: PgvectorSearchParams
): Promise<PgvectorSearchResult> {
  const { tenantId, embedding, topK = 5, excludedIds } = params;
  const t0 = performance.now();

  if (!pool) {
    return { items: [], ms: 0 };
  }

  if (!embedding || embedding.length === 0) {
    return { items: [], ms: 0 };
  }

  const safeExcludedIds = (excludedIds ?? []).filter(Boolean);
  const excludeClause = safeExcludedIds.length > 0
    ? `AND id::text != ALL($4::text[])`
    : "";

  const query = `
      SELECT
        id::text,
        text,
        metadata,
        1 - (embedding <-> $1::vector) / 2 AS score
      FROM faq_embeddings
      WHERE (tenant_id = $2 OR tenant_id = 'global' OR tenant_id = 'r2c_docs')
        AND (is_excluded_from_search IS NULL OR is_excluded_from_search = false)
        ${excludeClause}
      ORDER BY embedding <-> $1::vector
      LIMIT $3
    `;

  // pgvector expects a literal like "[0.1,0.2,...]".
  // node-postgres would otherwise send this as a Postgres array ("{0.1,0.2,...}"),
  // which causes a "malformed vector literal" error.
  const embeddingLiteral = `[${embedding.join(",")}]`;
  const queryParams: unknown[] = [embeddingLiteral, tenantId, topK];
  if (safeExcludedIds.length > 0) queryParams.push(safeExcludedIds);

  try {
    const result = await pool.query(query, queryParams);
    const t1 = performance.now();

    const items: PgvectorSearchItem[] = (result.rows as Array<{ id: string; text: string | null; score: number; metadata: Record<string, unknown> | null }>).map((row) => ({
      id: String(row.id),
      text: decryptText(row.text ?? ""),
      score: (() => {
        const s =
          typeof row.score === "number" ? row.score : Number(row.score) || 0;
        return Math.max(0, Math.min(1, s));
      })(),
      source: "pgvector",
      metadata: row.metadata ?? undefined,
    }));

    return {
      items,
      ms: Math.round(t1 - t0),
    };
  } catch (err) {
    const t1 = performance.now();
    logger.error("[pgvectorSearch] query failed", err);
    return {
      items: [],
      ms: Math.round(t1 - t0),
    };
  }
}
