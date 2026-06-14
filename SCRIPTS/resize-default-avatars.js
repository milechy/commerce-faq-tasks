// SCRIPTS/resize-default-avatars.js
// デフォルトアバター画像（avatar-defaults バケット）を368×560にリサイズして上書きする一回限りスクリプト
//
// 実行方法:
//   node SCRIPTS/resize-default-avatars.js
// (.env から SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を読み込む)

'use strict';

require('dotenv/config');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'avatar-defaults';
const WIDTH = 368;
const HEIGHT = 560;
const IDS = Array.from({ length: 18 }, (_, i) => `default_${String(i + 1).padStart(2, '0')}`);

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  for (const id of IDS) {
    const path = `${id}.png`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;

    process.stdout.write(`[${id}] ダウンロード中... `);
    let buffer;
    try {
      const res = await fetch(publicUrl);
      if (!res.ok) {
        console.log(`スキップ (${res.status})`);
        continue;
      }
      buffer = Buffer.from(await res.arrayBuffer());
      process.stdout.write(`${(buffer.length / 1024 / 1024).toFixed(1)}MB → `);
    } catch (e) {
      console.log(`エラー: ${e.message}`);
      continue;
    }

    let resized;
    try {
      resized = await sharp(buffer)
        .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'top' })
        .png({ quality: 85, compressionLevel: 8 })
        .toBuffer();
      process.stdout.write(`${(resized.length / 1024 / 1024).toFixed(1)}MB → `);
    } catch (e) {
      console.log(`リサイズ失敗: ${e.message}`);
      continue;
    }

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, resized, { contentType: 'image/png', upsert: true });

    if (error) {
      console.log(`アップロード失敗: ${error.message}`);
    } else {
      console.log('完了');
    }
  }

  console.log('\n全処理完了');
}

main().catch(console.error);
