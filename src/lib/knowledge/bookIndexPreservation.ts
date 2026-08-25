// src/lib/knowledge/bookIndexPreservation.ts
//
// ナレッジ配線是正 P8 (Asana GID 1217811006126792): SCRIPTS/sync-es.ts の
// alias-swap 再構築は faq_docs だけから新インデックスを組み立てるため、
// faq_docs 行を持たない書籍/OCR由来チャンク(faq_embeddings のみに存在)が
// 新インデックスに含まれず、swap で旧インデックスごと削除されて消える。
//
// faq_embeddings を復号・再構成するのではなく、旧ESインデックス(または
// その alias)に既に存在するドキュメントを _mget で実体コピーする方式にする。
// 復号を経由しないため書籍内容がログ・メモリに露出する経路が増えない
// (CLAUDE.md: 書籍内容をログに出力しない)。

import type { Pool } from "pg";

const ES_HEADERS = {
  "Content-Type": "application/vnd.elasticsearch+json; compatible-with=8",
  Accept: "application/vnd.elasticsearch+json; compatible-with=8",
};

export interface BookChunkRef {
  docId: string;
  bookId: number;
  chunkIndex: number;
}

/**
 * faq_embeddings のうち書籍/OCR由来('book' または 'book:pdf:qwen-ocr' 等、
 * 'book' で始まる source)チャンクの ES ドキュメントIDを列挙する。
 * doc id 規約(`book_${bookId}_chunk_${chunkIndex}`)は
 * src/lib/book-pipeline/embedAndStore.ts と同一にする(第2の規約を作らない)。
 */
export async function findBookChunkDocIds(
  pool: Pick<Pool, "query">,
  tenantId: string,
): Promise<BookChunkRef[]> {
  const res = await pool.query(
    `SELECT metadata FROM faq_embeddings
     WHERE tenant_id = $1
       AND metadata->>'source' LIKE 'book%'
       AND metadata->>'book_id' IS NOT NULL
       AND metadata->>'chunk_index' IS NOT NULL`,
    [tenantId],
  );
  const refs: BookChunkRef[] = [];
  for (const row of res.rows as Array<{ metadata: Record<string, unknown> }>) {
    const bookId = Number(row.metadata?.["book_id"]);
    const chunkIndex = Number(row.metadata?.["chunk_index"]);
    if (!Number.isFinite(bookId) || !Number.isFinite(chunkIndex)) continue;
    refs.push({ docId: `book_${bookId}_chunk_${chunkIndex}`, bookId, chunkIndex });
  }
  return refs;
}

export interface CopyBookDocsResult {
  expected: number;
  copied: number;
  missing: string[];
}

/**
 * 旧ESインデックス(または alias)から書籍チャンクのドキュメントを実体コピーで
 * 新インデックスへ引き継ぐ(_mget → _bulk)。oldIndexOrAlias が null(初回同期で
 * 旧インデックスが存在しない)場合はコピー対象が無いだけで、docIds.length > 0
 * なら全件 missing として報告する(=想定と食い違うため呼び出し元が気づける)。
 */
export async function copyBookDocsToNewIndex(
  esUrl: string,
  oldIndexOrAlias: string | null,
  newIndex: string,
  docIds: BookChunkRef[],
): Promise<CopyBookDocsResult> {
  const expected = docIds.length;
  if (expected === 0) {
    return { expected: 0, copied: 0, missing: [] };
  }
  if (!oldIndexOrAlias) {
    return { expected, copied: 0, missing: docIds.map((d) => d.docId) };
  }

  const mgetRes = await fetch(`${esUrl.replace(/\/$/, "")}/${oldIndexOrAlias}/_mget`, {
    method: "POST",
    headers: ES_HEADERS,
    body: JSON.stringify({ ids: docIds.map((d) => d.docId) }),
  });
  if (!mgetRes.ok) {
    const body = await mgetRes.text();
    throw new Error(`book chunk _mget failed: ${mgetRes.status} ${body}`);
  }
  const mgetBody = (await mgetRes.json()) as {
    docs: Array<{ _id: string; found: boolean; _source?: unknown }>;
  };

  const found = mgetBody.docs.filter((d) => d.found);
  const missing = mgetBody.docs.filter((d) => !d.found).map((d) => d._id);

  if (found.length === 0) {
    return { expected, copied: 0, missing };
  }

  const lines: string[] = [];
  for (const doc of found) {
    lines.push(JSON.stringify({ index: { _index: newIndex, _id: doc._id } }));
    lines.push(JSON.stringify(doc._source));
  }
  const bulkRes = await fetch(`${esUrl.replace(/\/$/, "")}/_bulk`, {
    method: "POST",
    headers: ES_HEADERS,
    body: lines.join("\n") + "\n",
  });
  if (!bulkRes.ok) {
    const body = await bulkRes.text();
    throw new Error(`book chunk bulk copy failed: ${bulkRes.status} ${body}`);
  }
  const bulkBody = (await bulkRes.json()) as {
    errors: boolean;
    items?: Array<{ index?: { error?: unknown } }>;
  };
  let copied = found.length;
  if (bulkBody.errors) {
    const erroredCount = (bulkBody.items ?? []).filter((i) => i.index?.error).length;
    copied = found.length - erroredCount;
  }

  return { expected, copied, missing };
}
