// src/search/pgvector.ts

// @ts-ignore - pg types are not bundled in this project, treat as any
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg") as { Pool: any };

const pgUrl = process.env.DATABASE_URL;
const pg = pgUrl ? new Pool({ connectionString: pgUrl }) : null;

export interface PgVectorHit {
  id: string;
  text: string;
  score: number; // 類似度（1 に近いほど類似）
  metadata?: any;
}

export interface PgVectorSearchResult {
  items: PgVectorHit[];
  ms: number;
  note?: string;
}

export interface PgVectorSearchParams {
  tenantId: string;
  embedding: number[]; // クエリ埋め込み
  topK?: number;
}

/**
 * pgvector を使った Multi-tenant ベクトル検索
 *
 * 期待テーブル構成（例）:
 *
 *   create table faq_embeddings (
 *     id bigserial primary key,
 *     tenant_id text not null,
 *     text text not null,
 *     embedding vector(1536) not null,
 *     metadata jsonb
 *   );
 *
 *   create index faq_embeddings_tenant_id_idx
 *     on faq_embeddings(tenant_id);
 *
 *   create index faq_embeddings_embedding_idx
 *     on faq_embeddings
 *     using ivfflat (embedding vector_cosine_ops)
 *     with (lists = 100);
 */
export async function searchPgVector(
  params: PgVectorSearchParams
): Promise<PgVectorSearchResult> {
  const { tenantId, embedding, topK = 20 } = params;

  if (!pg) {
    return {
      items: [],
      ms: 0,
      note: "pg:not_configured",
    };
  }

  const t0 = Date.now();
  const notes: string[] = [];

  if (!embedding.length) {
    return {
      items: [],
      ms: 0,
      note: "pgvector:empty_embedding",
    };
  }

  // pgvector 用に '[0.1,0.2,...]' 形式のリテラルを作る
  const embedLiteral = `[${embedding.join(",")}]`;

  const sql = `
    select
      id::text as id,
      text,
      metadata,
      -- cosine 類似度に変換 (1 - 距離)
      1 - (embedding <-> $2::vector) as score
    from faq_embeddings
    where tenant_id = $1
    order by embedding <-> $2::vector
    limit $3;
  `;

  try {
    const res = await pg.query(sql, [tenantId, embedLiteral, topK]);
    const ms = Date.now() - t0;

    const items: PgVectorHit[] = (res.rows || []).map((row: any) => ({
      id: String(row.id),
      text: row.text,
      metadata: row.metadata ?? undefined,
      score: typeof row.score === "number" ? row.score : 0,
    }));

    if (!items.length) {
      notes.push("pgvector:no_hits");
    }

    return {
      items,
      ms,
      note: notes.length ? notes.join(" | ") : undefined,
    };
  } catch (err: any) {
    const ms = Date.now() - t0;
    notes.push(
      `pgvector_error:${err?.name || "Error"}:${err?.message || String(err)}`
    );
    return {
      items: [],
      ms,
      note: notes.join(" | "),
    };
  }
}
