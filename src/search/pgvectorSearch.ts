import { Pool } from "pg";

export type PgvectorSearchParams = {
  tenantId: string;
  embedding: number[];
  topK?: number;
};

export type PgvectorSearchItem = {
  id: string;
  text: string;
  score: number;
  source: "pgvector";
};

export type PgvectorSearchResult = {
  items: PgvectorSearchItem[];
  ms: number;
};

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
    })
  : null;

export async function searchPgVector(
  params: PgvectorSearchParams,
): Promise<PgvectorSearchResult> {
  const { tenantId, embedding, topK = 5 } = params;
  const t0 = performance.now();

  if (!databaseUrl || !pool) {
    return { items: [], ms: 0 };
  }

  if (!embedding || embedding.length === 0) {
    return { items: [], ms: 0 };
  }

  const query = `
      SELECT
        id::text,
        text,
        1 - (embedding <-> $1::vector) / 2 AS score
      FROM faq_embeddings
      WHERE tenant_id = $2
      ORDER BY embedding <-> $1::vector
      LIMIT $3
    `;

  // pgvector expects a literal like "[0.1,0.2,...]".
  // node-postgres would otherwise send this as a Postgres array ("{0.1,0.2,...}"),
  // which causes a "malformed vector literal" error.
  const embeddingLiteral = `[${embedding.join(",")}]`;

  try {
    const result = await pool.query(query, [embeddingLiteral, tenantId, topK]);
    const t1 = performance.now();

    const items: PgvectorSearchItem[] = result.rows.map((row: any) => ({
      id: String(row.id),
      text: row.text as string,
      score: (() => {
        const s = typeof row.score === "number" ? row.score : Number(row.score) || 0;
        return Math.max(0, Math.min(1, s));
      })(),
      source: "pgvector",
    }));

    return {
      items,
      ms: Math.round(t1 - t0),
    };
  } catch (err) {
    const t1 = performance.now();
    console.error("[pgvectorSearch] query failed", err);
    return {
      items: [],
      ms: Math.round(t1 - t0),
    };
  }
}
