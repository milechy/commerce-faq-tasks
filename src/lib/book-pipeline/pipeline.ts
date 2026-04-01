// src/lib/book-pipeline/pipeline.ts
// Phase44: 書籍チャンク構造化パイプライン オーケストレーター
// status 遷移: uploaded → processing → chunked → embedded / error

// @ts-ignore
import type { Pool } from "pg";
import { supabaseAdmin } from "../../auth/supabaseClient";
import { extractPdfText } from "./pdfExtractor";
import { splitIntoChunks } from "./chunkSplitter";
import { structurizeChunks } from "./structurizer";
import { embedAndStore } from "./embedAndStore";
import type { EmbedAndStoreDeps } from "./embedAndStore";
import type { StructurizerDeps } from "./structurizer";
import { createNotification } from "../notifications";

export interface PipelineDeps {
  db: Pool;
  supabase?: typeof supabaseAdmin;
  structurizer?: StructurizerDeps;
  embedAndStoreDeps?: Partial<EmbedAndStoreDeps>;
}

interface BookRow {
  id: number;
  tenant_id: string;
  storage_path: string;
  encryption_iv: string | null;
  status: string;
}

async function setStatus(
  db: Pool,
  bookId: number,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const setClauses = ["status = $2", "updated_at = NOW()"];
  const params: unknown[] = [bookId, status];
  let idx = 3;

  if (extra.page_count !== undefined) {
    setClauses.push(`page_count = $${idx++}`);
    params.push(extra.page_count);
  }
  if (extra.chunk_count !== undefined) {
    setClauses.push(`chunk_count = $${idx++}`);
    params.push(extra.chunk_count);
  }
  if (extra.error_message !== undefined) {
    setClauses.push(`error_message = $${idx++}`);
    params.push(extra.error_message);
  }

  await db.query(
    `UPDATE book_uploads SET ${setClauses.join(", ")} WHERE id = $1`,
    params
  );
}

/**
 * 書籍 ID を受け取り、全 pipeline ステップを実行する。
 *
 * 1. book_uploads からレコード取得
 * 2. status → processing
 * 3. PDF テキスト抽出 (Supabase Storage + AES 復号)
 * 4. チャンク分割 (500–1000 chars, 100-char overlap)
 * 5. status → chunked, chunk_count / page_count 更新
 * 6. Groq 8b 構造化
 * 7. Embedding + faq_embeddings 保存 + ES sync
 * 8. status → embedded
 *
 * エラー時は status → error, error_message に記録。
 */
export async function runBookPipeline(
  bookId: number,
  deps: PipelineDeps
): Promise<{ chunkCount: number; pageCount: number }> {
  const { db } = deps;
  const supabase = deps.supabase ?? supabaseAdmin;

  // 1. レコード取得
  const lookup = await db.query<BookRow>(
    "SELECT id, tenant_id, storage_path, encryption_iv, status FROM book_uploads WHERE id = $1",
    [bookId]
  );
  if (lookup.rows.length === 0) {
    throw new Error(`book_uploads id=${bookId} not found`);
  }

  const book = lookup.rows[0];

  // 2. status → processing
  await setStatus(db, bookId, "processing");

  try {
    if (!supabase) {
      throw new Error("Supabase クライアントが設定されていません");
    }

    // 3. PDF テキスト抽出
    const { pages, pageCount } = await extractPdfText(
      { supabase },
      book.storage_path,
      book.encryption_iv
    );

    // 4. チャンク分割
    const chunks = splitIntoChunks(pages);

    // 5. status → chunked
    await setStatus(db, bookId, "chunked", {
      page_count: pageCount,
      chunk_count: chunks.length,
    });

    // 6. Groq 8b 構造化
    const structuredChunks = await structurizeChunks(
      chunks,
      deps.structurizer ?? {}
    );

    // 7. Embedding + 保存 + ES sync
    const embedDeps: EmbedAndStoreDeps = {
      db,
      ...(deps.embedAndStoreDeps ?? {}),
    };
    await embedAndStore(book.tenant_id, bookId, structuredChunks, embedDeps);

    // Phase47 Stream B: Gemini心理原則構造化（fire-and-forget、既存パイプラインをブロックしない）
    if (process.env['BOOK_STRUCTURIZE_ENABLED'] === 'true') {
      const fullText = pages.map((p: { text: string }) => p.text).join('\n\n');
      setImmediate(() => {
        import('../../agent/knowledge/bookStructurizer')
          .then(({ structurizeBook }) => structurizeBook(book.tenant_id, bookId, fullText))
          .catch((err: unknown) => {
            console.warn(
              '[book-pipeline] structurizeBook failed (non-blocking):',
              err instanceof Error ? err.message : String(err),
            );
          });
      });
    }

    // 8. status → embedded
    await setStatus(db, bookId, "embedded", {
      chunk_count: chunks.length,
      page_count: pageCount,
    });

    // Phase52h: Trigger 9 — PDF処理完了通知
    void createNotification({
      recipientRole: 'client_admin',
      recipientTenantId: book!.tenant_id,
      type: 'pdf_processed',
      title: 'PDFの処理が完了しました',
      message: `${chunks.length}チャンク、${pageCount}ページの処理が完了しました`,
      link: '/admin/knowledge',
      metadata: { bookId, chunkCount: chunks.length, pageCount },
    });

    return { chunkCount: chunks.length, pageCount };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    // エラーメッセージに書籍内容を含めない（Anti-Slop）
    const safeMessage = message.slice(0, 200);
    await setStatus(db, bookId, "error", { error_message: safeMessage });
    throw err;
  }
}
