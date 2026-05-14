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
  /** Phase69-2: 検索結果から除外するエントリID一覧（テナント分離保証） */
  excludedIds?: string[];
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
  const { tenantId, embedding, topK = 20, excludedIds } = params;

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

  const safeExcludedIds = (excludedIds ?? []).filter(Boolean);
  const excludeClause = safeExcludedIds.length > 0
    ? `and fe.id::text != ALL($4::text[])`
    : "";

  // Phase69-2 Round 3: source 判定で FAQ 系 / 非 FAQ 系を分離 (Codex Adversarial #1 対応)
  //   - FAQ 系 (source IN ('scrape','text','faq')) は faq_docs 厳格チェック
  //     → fd.id IS NOT NULL 必須。faq_id を持たない legacy embedding は FAQ 検索から除外。
  //   - 非 FAQ 系 (book/web/groq 等、または source NULL) は faq_docs を見ない
  //     → faq_embeddings.is_excluded_from_search のみで判定。
  // JOIN ON 句に numeric guard を入れて非数値 faq_id での bigint キャスト失敗を防ぐ。
  const sql = `
    select
      fe.id::text as id,
      fe.text,
      fe.metadata,
      1 - (fe.embedding <-> $2::vector) as score
    from faq_embeddings fe
    left join faq_docs fd
      on fe.metadata->>'faq_id' ~ '^[0-9]+$'
     and fd.id = (fe.metadata->>'faq_id')::bigint
    where (fe.tenant_id = $1 OR fe.tenant_id = 'global')
      and (
        (
          fe.metadata->>'source' IN ('scrape', 'text', 'faq')
          and fd.id IS NOT NULL
          and fd.is_published = true
          and (fd.is_excluded_from_search IS NULL OR fd.is_excluded_from_search = false)
        )
        OR
        (
          fe.metadata->>'source' IS NULL
          OR fe.metadata->>'source' NOT IN ('scrape', 'text', 'faq')
        )
      )
      and (fe.is_excluded_from_search IS NULL OR fe.is_excluded_from_search = false)
      ${excludeClause}
    order by fe.embedding <-> $2::vector
    limit $3;
  `;

  const queryParams: unknown[] = [tenantId, embedLiteral, topK];
  if (safeExcludedIds.length > 0) queryParams.push(safeExcludedIds);

  try {
    const res = await pg.query(sql, queryParams);
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
