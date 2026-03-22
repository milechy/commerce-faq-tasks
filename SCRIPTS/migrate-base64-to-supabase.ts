#!/usr/bin/env npx ts-node
/**
 * SCRIPTS/migrate-base64-to-supabase.ts
 *
 * avatar_configs テーブルの image_url に保存されている base64 データを
 * Supabase Storage にアップロードし、公開 HTTP URL に変換します。
 *
 * 実行: npx ts-node SCRIPTS/migrate-base64-to-supabase.ts
 *
 * 必要な環境変数:
 *   DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// @ts-ignore
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "avatar-images";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // バケット作成（存在する場合は無視）
  const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    fileSizeLimit: 5 * 1024 * 1024,
  });
  if (bucketErr && !bucketErr.message.toLowerCase().includes("already exists")) {
    console.warn("[migrate] bucket create warn:", bucketErr.message);
  } else {
    console.log(`[migrate] bucket '${BUCKET}' ready`);
  }

  // base64 image_url を持つレコードを取得
  const { rows } = await pool.query(
    "SELECT id, tenant_id, image_url FROM avatar_configs WHERE image_url LIKE 'data:%'"
  );

  console.log(`[migrate] Found ${rows.length} records with base64 image_url`);

  let successCount = 0;
  let failCount = 0;

  for (const row of rows as { id: string; tenant_id: string; image_url: string }[]) {
    const match = row.image_url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      console.warn(`[migrate] Skipping ${row.id}: invalid data URL format`);
      failCount++;
      continue;
    }

    const mimeType = match[1] as string;
    const base64Data = match[2] as string;
    const buffer = Buffer.from(base64Data, "base64");
    const ext =
      mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const filePath = `${row.tenant_id}/avatar-${row.id}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadErr) {
      console.error(`[migrate] Upload failed for ${row.id}:`, uploadErr.message);
      failCount++;
      continue;
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    const publicUrl = urlData?.publicUrl;

    if (!publicUrl) {
      console.error(`[migrate] Could not get public URL for ${row.id}`);
      failCount++;
      continue;
    }

    await pool.query(
      "UPDATE avatar_configs SET image_url = $1 WHERE id = $2",
      [publicUrl, row.id]
    );

    console.log(`[migrate] ✓ ${row.id} → ${publicUrl}`);
    successCount++;
  }

  console.log(`\n[migrate] Done: ${successCount} succeeded, ${failCount} failed`);
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
