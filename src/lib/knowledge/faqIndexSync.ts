// src/lib/knowledge/faqIndexSync.ts
//
// FAQ の検索索引（Elasticsearch + pgvector）を書き込む唯一の実装。
//
// これまで faqCrudRoutes.ts / faqAdminRoutes.ts / faqImport.ts / actionExecutor.ts が
// それぞれ個別に（あるいは一部は同期そのものを欠いたまま）ES/pgvectorへ書き込んでおり、
// ESドキュメントIDの規約も faqCrudRoutes.ts 系の `${faqId}_${tenantId}` と、
// faqAdminRoutes.ts の未使用 `es_doc_id` 列（常にNULLで一度も埋まらない）の
// 2方式が並行していた。本モジュールが単一の実装・単一のID規約を持つ。
//
// 「検索索引の同期は"記録"ではない」— 失敗すると「登録したのに答えない」という
// ユーザーに見える機能不全になる。fire-and-forget にはするが、失敗は
// logger.error（warn より重大度を上げる）で残し、黙って握り潰さない。

import type { Pool } from "pg";
import { embedText } from "../../agent/llm/openaiEmbeddingClient";
import { logger } from "../logger";
import { resolveFaqWriteIndex } from "../../search/langIndex";

/** ESドキュメントIDの唯一の生成規約。呼び出し側で文字列を組み立てさせない。 */
export function faqEsDocId(tenantId: string, faqId: number): string {
  return `${faqId}_${tenantId}`;
}

/** ESにFAQドキュメントをupsertする（fire-and-forget） */
export function upsertFaqToEs(
  tenantId: string,
  faqId: number,
  question: string,
  answer: string,
  isPublished = true,
  isExcludedFromSearch = false
): void {
  const esUrl = process.env.ES_URL;
  if (!esUrl) return;
  const index = resolveFaqWriteIndex(tenantId);
  const doc = {
    tenant_id: tenantId,
    question,
    answer,
    faq_id: faqId,
    is_published: isPublished,
    is_excluded_from_search: isExcludedFromSearch,
  };
  const url = `${esUrl.replace(/\/$/, "")}/${index}/_doc/${faqEsDocId(tenantId, faqId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  }).catch((e) =>
    logger.error("[faqIndexSync] ES upsert failed", { tenantId, faqId, err: e })
  );
}

/** ESからFAQドキュメントを削除する（best-effort） */
export async function deleteFaqFromEs(tenantId: string, faqId: number): Promise<void> {
  const esUrl = process.env.ES_URL;
  if (!esUrl) return;
  const index = resolveFaqWriteIndex(tenantId);
  const url = `${esUrl.replace(/\/$/, "")}/${index}/_doc/${faqEsDocId(tenantId, faqId)}`;
  await fetch(url, { method: "DELETE" }).catch((e) =>
    logger.error("[faqIndexSync] ES delete failed", { tenantId, faqId, err: e })
  );
}

/** ESインデックスの is_excluded_from_search のみ partial update（fire-and-forget） */
export function syncFaqExcludedToEs(
  tenantId: string,
  faqId: number,
  isExcludedFromSearch: boolean
): void {
  const esUrl = process.env.ES_URL;
  if (!esUrl) return;
  const index = resolveFaqWriteIndex(tenantId);
  const url = `${esUrl.replace(/\/$/, "")}/${index}/_update/${faqEsDocId(tenantId, faqId)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc: { is_excluded_from_search: isExcludedFromSearch } }),
  }).catch((e) =>
    logger.error("[faqIndexSync] ES is_excluded_from_search sync failed", {
      tenantId,
      faqId,
      err: e,
    })
  );
}

/**
 * embedding を非同期でpgvectorへ挿入する（fire-and-forget）。
 * `encrypt: true` を指定すると保存前に本文を暗号化する
 * （呼び出し元ごとに既存の挙動を保つためのオプション。新規呼び出しでは
 * 保存対象の性質に応じて明示的に選ぶこと。デフォルトはfalse）。
 */
export function insertFaqEmbeddingAsync(
  db: Pool,
  tenantId: string,
  text: string,
  faqId: number,
  meta: Record<string, unknown>,
  opts?: { encrypt?: boolean }
): void {
  const isExcluded = Boolean(meta.is_excluded_from_search);
  embedText(text)
    .then(async (vec) => {
      let storedText = text;
      if (opts?.encrypt) {
        const { encryptText } = await import("../crypto/textEncrypt");
        storedText = encryptText(text);
      }
      return db.query(
        "INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata, is_excluded_from_search) VALUES ($1, $2, $3::vector, $4::jsonb, $5)",
        [tenantId, storedText, `[${vec.join(",")}]`, JSON.stringify(meta), isExcluded]
      );
    })
    .catch((e) =>
      logger.error("[faqIndexSync] embedding insert failed", { tenantId, faqId, err: e })
    );
}

/**
 * DB(faq_docs, is_published=true)とES(同条件)の件数を突き合わせる。
 * 索引の不整合を検知するためのヘルパー。呼び出し元・定期実行(cron化)は
 * このタスクのスコープ外。件数を返すだけで自動修復はしない。
 */
export async function countFaqIndexMismatch(
  pool: Pool,
  tenantId: string
): Promise<{ dbCount: number; esCount: number }> {
  const dbResult = await pool.query(
    "SELECT COUNT(*)::int AS c FROM faq_docs WHERE tenant_id = $1 AND is_published = true",
    [tenantId]
  );
  const dbCount = (dbResult.rows[0] as { c: number }).c;

  const esUrl = process.env.ES_URL;
  if (!esUrl) return { dbCount, esCount: -1 };
  const index = resolveFaqWriteIndex(tenantId);
  try {
    const res = await fetch(`${esUrl.replace(/\/$/, "")}/${index}/_count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: {
          bool: {
            filter: [
              { term: { tenant_id: tenantId } },
              { term: { is_published: true } },
            ],
          },
        },
      }),
    });
    if (!res.ok) return { dbCount, esCount: -1 };
    const body = (await res.json()) as { count: number };
    return { dbCount, esCount: body.count };
  } catch (e) {
    logger.error("[faqIndexSync] countFaqIndexMismatch ES query failed", { tenantId, err: e });
    return { dbCount, esCount: -1 };
  }
}
