// SCRIPTS/structurize-existing-books.ts
// Phase47 Stream B: 既存書籍データのバッチ構造化
// 使い方: npx tsx SCRIPTS/structurize-existing-books.ts [--tenant=xxx] [--dry-run] [--limit=N]

import 'dotenv/config';
import { getPool } from '../src/lib/db';
import { supabaseAdmin } from '../src/auth/supabaseClient';
import { extractPdfText } from '../src/lib/book-pipeline/pdfExtractor';
import { structurizeBook } from '../src/agent/knowledge/bookStructurizer';
import { splitIntoChunks } from '../src/agent/knowledge/bookChunker';

// ── CLI 引数パース ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  tenant: string | null;
  dryRun: boolean;
  limit: number | null;
} {
  let tenant: string | null = null;
  let dryRun = false;
  let limit: number | null = null;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--tenant=')) {
      tenant = arg.slice('--tenant='.length) || null;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      const val = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(val) && val > 0) limit = val;
    }
  }

  return { tenant, dryRun, limit };
}

// ── 既に構造化済みかチェック ──────────────────────────────────────────────────

async function isAlreadyStructurized(tenantId: string, bookId: number): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM faq_embeddings
     WHERE tenant_id = $1
       AND metadata->>'source' = 'book'
       AND metadata->>'book_id' = $2::text
       AND metadata->>'principle' IS NOT NULL`,
    [tenantId, String(bookId)],
  );
  const cnt = parseInt(res.rows[0]?.cnt ?? '0', 10);
  return cnt > 0;
}

// ── メイン処理 ────────────────────────────────────────────────────────────────

interface BookRow {
  id: number;
  tenant_id: string;
  storage_path: string;
  encryption_iv: string | null;
}

async function main(): Promise<void> {
  const { tenant, dryRun, limit } = parseArgs(process.argv);

  // BOOK_STRUCTURIZE_ENABLED チェック
  if (process.env['BOOK_STRUCTURIZE_ENABLED'] !== 'true') {
    console.log(
      'Error: BOOK_STRUCTURIZE_ENABLED is not set to "true". ' +
        'Set it in your .env file and retry.',
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log('[DRY RUN] No Gemini calls will be made.');
  }

  // DB から対象レコードを取得
  const pool = getPool();

  let queryText =
    `SELECT id, tenant_id, storage_path, encryption_iv ` +
    `FROM book_uploads WHERE status = 'embedded'`;
  const queryParams: unknown[] = [];

  if (tenant) {
    queryParams.push(tenant);
    queryText += ` AND tenant_id = $${queryParams.length}`;
  }

  queryText += ' ORDER BY id ASC';

  const dbRes = await pool.query<BookRow>(queryText, queryParams);
  let books = dbRes.rows;

  if (limit !== null) {
    books = books.slice(0, limit);
  }

  const total = books.length;
  console.log(`Found ${total} book_uploads with status='embedded'${tenant ? ` (tenant: ${tenant})` : ''}.`);

  if (total === 0) {
    console.log('Nothing to process.');
    process.exit(0);
  }

  // サマリー集計
  let structuredTotal = 0;
  let skippedTotal = 0;
  let failedTotal = 0;

  for (let i = 0; i < books.length; i++) {
    const book = books[i]!;
    const progress = `${i + 1}/${total}`;

    console.log(`Processing ${progress}: book_id=${book.id} (tenant: ${book.tenant_id})`);

    // 既に構造化済みかチェック
    let alreadyStructurized = false;
    try {
      alreadyStructurized = await isAlreadyStructurized(book.tenant_id, book.id);
    } catch (err) {
      console.log(
        `  Warning: failed to check structurized status for book_id=${book.id}: ${String(err)}`,
      );
    }

    if (alreadyStructurized) {
      console.log(`  Skipping ${book.id}: already structurized`);
      skippedTotal++;
      continue;
    }

    // ドライランの場合: PDF抽出してチャンク数だけ表示、Geminiは呼ばない
    if (dryRun) {
      if (!supabaseAdmin) {
        console.log(`  Error: supabaseAdmin is null, skipping book_id=${book.id}`);
        failedTotal++;
        continue;
      }

      let pages: { pageNumber: number; text: string }[] = [];
      try {
        const extracted = await extractPdfText(
          { supabase: supabaseAdmin },
          book.storage_path,
          book.encryption_iv,
        );
        pages = extracted.pages;
      } catch (err) {
        console.log(`  Failed to extract: bookId=${book.id} — ${String(err)}`);
        failedTotal++;
        continue;
      }

      const fullText = pages.map((p) => p.text).join('\n\n');
      const chunks = splitIntoChunks(fullText);
      console.log(
        `  [DRY RUN] Would structurize book_id=${book.id}: ${chunks.length} chunks from ${pages.length} pages`,
      );
      structuredTotal++;
      continue;
    }

    // 本番処理
    if (!supabaseAdmin) {
      console.log(`  Error: supabaseAdmin is null, skipping book_id=${book.id}`);
      failedTotal++;
      continue;
    }

    // PDF テキスト抽出
    let pages: { pageNumber: number; text: string }[] = [];
    try {
      const extracted = await extractPdfText(
        { supabase: supabaseAdmin },
        book.storage_path,
        book.encryption_iv,
      );
      pages = extracted.pages;
    } catch (err) {
      console.log(`  Failed to extract: bookId=${book.id} — ${String(err)}`);
      failedTotal++;
      continue;
    }

    const fullText = pages.map((p) => p.text).join('\n\n');

    // 構造化実行
    let result: Awaited<ReturnType<typeof structurizeBook>>;
    try {
      result = await structurizeBook(book.tenant_id, book.id, fullText);
    } catch (err) {
      console.log(`  Error during structurizeBook for book_id=${book.id}: ${String(err)}`);
      failedTotal++;
      continue;
    }

    console.log(
      `  book_id=${book.id}: totalChunks=${result.totalChunks}, ` +
        `structured=${result.structuredCount}, ` +
        `skipped=${result.skippedCount}, ` +
        `failed=${result.failedCount}`,
    );

    structuredTotal += result.structuredCount > 0 ? 1 : 0;
    if (result.failedCount > 0) {
      console.log(`  Note: ${result.failedCount} chunks failed during structurization.`);
      failedTotal += result.failedCount > result.structuredCount ? 1 : 0;
    }
  }

  // サマリー出力
  console.log('');
  console.log(
    `Done. Structured: ${structuredTotal}, Skipped: ${skippedTotal}, Failed: ${failedTotal}`,
  );

  process.exit(0);
}

main().catch((err: unknown) => {
  console.log(`Fatal error: ${String(err)}`);
  process.exit(1);
});
