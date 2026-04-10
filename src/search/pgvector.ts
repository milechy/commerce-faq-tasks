// src/search/pgvector.ts

import { decryptText } from "../lib/crypto/textEncrypt";
import { pool as pg } from "../lib/db";

export interface PgVectorHit {
  id: string;
  text: string;
  score: number; // 類似度（1 に近いほど類似）
  metadata?: Record<string, unknown>;
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

  // faq_docs と LEFT JOIN して is_published = false のエントリを除外
  // (metadata に faq_id がない古いエントリはそのまま返す)
  const sql = `
    select
      fe.id::text as id,
      fe.text,
      fe.metadata,
      1 - (fe.embedding <-> $2::vector) as score
    from faq_embeddings fe
    left join faq_docs fd
      on fd.id = (fe.metadata->>'faq_id')::bigint
    where (fe.tenant_id = $1 OR fe.tenant_id = 'global')
      and (fd.is_published = true OR fd.id IS NULL)
    order by fe.embedding <-> $2::vector
    limit $3;
  `;

  try {
    const res = await pg.query(sql, [tenantId, embedLiteral, topK]);
    const ms = Date.now() - t0;

    type PgRow = { id: string; text: string | null; metadata: Record<string, unknown> | null; score: number };
    const items: PgVectorHit[] = (res.rows as PgRow[] || []).map((row) => ({
      id: String(row.id),
      text: decryptText(row.text ?? ""),
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
  } catch (err: unknown) {
    const ms = Date.now() - t0;
    const e = err as Error;
    notes.push(
      `pgvector_error:${e?.name || "Error"}:${e?.message || String(err)}`
    );
    return {
      items: [],
      ms,
      note: notes.join(" | "),
    };
  }
}
