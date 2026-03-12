#!/usr/bin/env tsx
// SCRIPTS/encrypt-existing-embeddings.ts
// 既存の faq_embeddings.text（平文）を暗号化するマイグレーションスクリプト
//
// 使用方法:
//   DATABASE_URL=... KNOWLEDGE_ENCRYPTION_KEY=<64hex> tsx SCRIPTS/encrypt-existing-embeddings.ts
//   --dry-run フラグで実際には更新しないプレビュー実行が可能
//
// 生成方法 (KNOWLEDGE_ENCRYPTION_KEY):
//   python3 -c "import secrets; print(secrets.token_hex(32))"

import { Pool } from "pg";
import { encryptText, isEncrypted } from "../src/lib/crypto/textEncrypt";

const BATCH_SIZE = 100;
const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  if (!process.env.KNOWLEDGE_ENCRYPTION_KEY) {
    console.error("ERROR: KNOWLEDGE_ENCRYPTION_KEY is not set");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("[encrypt-embeddings] DRY RUN mode — no changes will be written");
  }

  const pool = new Pool({ connectionString: dbUrl });

  try {
    // 総件数取得
    const countRes = await pool.query("SELECT COUNT(*) FROM faq_embeddings");
    const total = parseInt(countRes.rows[0].count as string, 10);
    console.log(`[encrypt-embeddings] Total records: ${total}`);

    let offset = 0;
    let encrypted = 0;
    let skipped = 0;
    let errors = 0;

    while (offset < total) {
      const batchRes = await pool.query(
        "SELECT id, text FROM faq_embeddings ORDER BY id LIMIT $1 OFFSET $2",
        [BATCH_SIZE, offset]
      );

      const rows: Array<{ id: string; text: string }> = batchRes.rows;

      for (const row of rows) {
        if (isEncrypted(row.text)) {
          // 既に暗号化済みはスキップ
          skipped++;
          continue;
        }

        if (DRY_RUN) {
          console.log(
            `[dry-run] Would encrypt id=${row.id} text_preview="${row.text.slice(0, 20)}..."`
          );
          encrypted++;
          continue;
        }

        try {
          const encryptedText = encryptText(row.text);
          await pool.query(
            "UPDATE faq_embeddings SET text = $1 WHERE id = $2",
            [encryptedText, row.id]
          );
          encrypted++;
        } catch (err) {
          console.error(`[encrypt-embeddings] ERROR: failed to encrypt id=${row.id}`, err);
          errors++;
        }
      }

      offset += BATCH_SIZE;
      const progress = Math.min(offset, total);
      console.log(
        `[encrypt-embeddings] Progress: ${progress}/${total} (encrypted=${encrypted}, skipped=${skipped}, errors=${errors})`
      );
    }

    console.log(
      `\n[encrypt-embeddings] Done. encrypted=${encrypted}, skipped=${skipped}, errors=${errors}`
    );

    if (errors > 0) {
      console.error("[encrypt-embeddings] Completed with errors");
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[encrypt-embeddings] Fatal error:", err);
  process.exit(1);
});
