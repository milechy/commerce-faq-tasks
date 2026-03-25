// src/lib/book-pipeline/embedAndStore.ts
// Phase44: Embedding 生成 + faq_embeddings 保存 + ES 同期
// CLAUDE.md: RAG excerpt ≤200 chars, 書籍内容をログに出力しない

// @ts-ignore
import type { Pool } from "pg";
import { embedText } from "../../agent/llm/openaiEmbeddingClient";
import { encryptText } from "../crypto/textEncrypt";
import type { StructuredChunk } from "./structurizer";

export interface EmbedAndStoreDeps {
  db: Pool;
  embedFn?: (text: string) => Promise<number[]>;
}

const ES_INDEX = process.env.ES_FAQ_INDEX ?? "faqs";

async function upsertToEs(
  esUrl: string,
  docId: string,
  doc: Record<string, unknown>
): Promise<void> {
  const url = `${esUrl.replace(/\/$/, "")}/${ES_INDEX}/_doc/${encodeURIComponent(docId)}`;
  try {
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
  } catch {
    // best-effort: ES sync failure should not block pipeline
  }
}

/**
 * 構造化チャンクを faq_embeddings に保存し ES に同期する。
 * テキストは encryptText() で暗号化（KNOWLEDGE_ENCRYPTION_KEY 未設定時は平文）。
 * question が空の場合は summary を embedding テキストとして使う。
 *
 * @returns 保存された embedding ID の配列
 */
export async function embedAndStore(
  tenantId: string,
  bookId: number,
  chunks: StructuredChunk[],
  deps: EmbedAndStoreDeps
): Promise<number[]> {
  const { db } = deps;
  const embed = deps.embedFn ?? embedText;
  const esUrl = process.env.ES_URL;

  const insertedIds: number[] = [];

  for (const chunk of chunks) {
    // embedding テキスト: question + answer (answer は ≤200 chars 保証済み)
    const embeddingSource =
      chunk.question.length > 0
        ? `${chunk.question}\n${chunk.answer}`
        : chunk.summary;

    const vector = await embed(embeddingSource);

    // faq_embeddings.text に保存するテキスト（暗号化）
    const storedText = encryptText(embeddingSource);

    const metadata = {
      source: "book",
      book_id: bookId,
      chunk_index: chunk.chunkIndex,
      page_number: chunk.pageNumber,
      category: chunk.category,
      keywords: chunk.keywords,
      confidence: chunk.confidence,
    };

    const result = await db.query<{ id: number }>(
      `INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
       VALUES ($1, $2, $3::vector, $4::jsonb)
       RETURNING id`,
      [
        tenantId,
        storedText,
        `[${vector.join(",")}]`,
        JSON.stringify(metadata),
      ]
    );

    const embeddingId = result.rows[0].id;
    insertedIds.push(embeddingId);

    // ES sync（best-effort, fire-and-forget 風だが await して例外は無視）
    if (esUrl) {
      const docId = `book_${bookId}_chunk_${chunk.chunkIndex}`;
      const doc = {
        tenant_id: tenantId,
        // ES には question/answer のみ（書籍本文は含めない — Anti-Slop）
        question: chunk.question.slice(0, 200),
        answer: chunk.answer.slice(0, 200),
        source: "book",
        book_id: bookId,
        chunk_index: chunk.chunkIndex,
        category: chunk.category,
        keywords: chunk.keywords,
        is_published: true,
      };
      await upsertToEs(esUrl, docId, doc);
    }
  }

  return insertedIds;
}
