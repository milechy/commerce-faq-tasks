#!/usr/bin/env tsx
// SCRIPTS/upload-avatar-defaults.ts
// Phase50: default_01.png〜default_18.png を Supabase Storage の avatar-defaults バケットにアップロード
// 実行: npx tsx SCRIPTS/upload-avatar-defaults.ts

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'avatar-defaults';
const DOWNLOADS_DIR = path.join(process.env.HOME ?? '/Users', 'Downloads');
const TOTAL = 18;

// default_15..png (ダブルドット) 対応マッピング
function resolveLocalPath(id: string): string {
  const canonical = path.join(DOWNLOADS_DIR, `${id}.png`);
  if (fs.existsSync(canonical)) return canonical;

  // ダブルドットフォールバック
  const doubleDot = path.join(DOWNLOADS_DIR, `${id}..png`);
  if (fs.existsSync(doubleDot)) {
    console.warn(`  [WARN] Found "${id}..png" (double dot) — using it as "${id}.png"`);
    return doubleDot;
  }

  return canonical; // 存在しなければ canonical を返してエラーを出させる
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('ERROR: SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が .env に未設定');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // バケット存在確認（なければ作成）
  const { data: buckets } = await supabase.storage.listBuckets();
  const bucketExists = buckets?.some((b) => b.name === BUCKET);
  if (!bucketExists) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (createErr && !createErr.message.toLowerCase().includes('already exists')) {
      console.error('ERROR: バケット作成失敗:', createErr.message);
      process.exit(1);
    }
    console.log(`バケット "${BUCKET}" を作成しました`);
  } else {
    console.log(`バケット "${BUCKET}" 確認済み`);
  }

  console.log(`\n${TOTAL}体の画像をアップロード開始...\n`);

  const results: { id: string; url: string | null; ok: boolean }[] = [];

  for (let i = 1; i <= TOTAL; i++) {
    const id = `default_${String(i).padStart(2, '0')}`;
    const localPath = resolveLocalPath(id);
    const storagePath = `${id}.png`;

    // ファイル存在チェック
    if (!fs.existsSync(localPath)) {
      console.error(`  [SKIP] ${id}.png — ファイルが見つかりません: ${localPath}`);
      results.push({ id, url: null, ok: false });
      continue;
    }

    const buffer = fs.readFileSync(localPath);

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadErr) {
      console.error(`  [FAIL] ${id}.png — ${uploadErr.message}`);
      results.push({ id, url: null, ok: false });
      continue;
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl ?? null;
    console.log(`  [OK]   ${id}.png → ${publicUrl}`);
    results.push({ id, url: publicUrl, ok: true });
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${succeeded}/${TOTAL}  失敗: ${failed}/${TOTAL}`);

  if (failed > 0) {
    console.error('\n失敗したファイル:');
    results.filter((r) => !r.ok).forEach((r) => console.error(`  - ${r.id}`));
    process.exit(1);
  }

  console.log('\n=== 公開URL一覧 ===');
  results.forEach((r) => console.log(`${r.id}: ${r.url}`));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
