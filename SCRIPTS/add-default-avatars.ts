#!/usr/bin/env tsx
// SCRIPTS/add-default-avatars.ts
// Phase44 P2-12: 既存テナント全件にデフォルト8体アバターを追加
// 実行: npx tsx SCRIPTS/add-default-avatars.ts [--dry-run]

import 'dotenv/config';
// @ts-ignore
import { Pool } from 'pg';
import { supabaseAdmin } from '../src/auth/supabaseClient';

const DEFAULT_AVATARS = [
  { id: 'default_01', name: 'さくら', personality: '明るく元気な営業アシスタント' },
  { id: 'default_02', name: 'あおい', personality: '落ち着いた丁寧なカスタマーサポート' },
  { id: 'default_03', name: 'ひなた', personality: '親しみやすいフレンドリーな案内役' },
  { id: 'default_04', name: 'みずき', personality: '知的で信頼感のあるコンサルタント' },
  { id: 'default_05', name: 'りん', personality: 'テキパキした効率的なアドバイザー' },
  { id: 'default_06', name: 'かえで', personality: '温かみのある相談しやすいスタッフ' },
  { id: 'default_07', name: 'すずな', personality: '誠実で安心感のある対応スタッフ' },
  { id: 'default_08', name: 'つむぎ', personality: '柔らかく寄り添うサポートスタッフ' },
];

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });

  try {
    // 全テナント取得
    const tenantsResult = await pool.query('SELECT id, name FROM tenants ORDER BY created_at');
    const tenants: { id: string; name: string }[] = tenantsResult.rows;
    console.log(`Found ${tenants.length} tenants`);

    let totalInserted = 0;
    let totalSkipped = 0;

    for (const tenant of tenants) {
      for (const avatar of DEFAULT_AVATARS) {
        // 既存チェック
        const existing = await pool.query(
          'SELECT id FROM avatar_configs WHERE tenant_id = $1 AND default_template_id = $2',
          [tenant.id, avatar.id]
        );

        if (existing.rows.length > 0) {
          totalSkipped++;
          continue;
        }

        const imageUrl = supabaseAdmin
          ? supabaseAdmin.storage.from('avatar-defaults').getPublicUrl(`${avatar.id}.png`).data?.publicUrl ?? null
          : null;

        if (isDryRun) {
          console.log(`[DRY RUN] Would insert ${avatar.id} (${avatar.name}) for tenant ${tenant.id}`);
          totalInserted++;
          continue;
        }

        await pool.query(
          `INSERT INTO avatar_configs
            (tenant_id, name, image_url, personality_prompt, is_default,
             default_template_id, default_name, default_personality_prompt,
             default_voice_id, is_active, avatar_provider)
           VALUES ($1, $2, $3, $4, true, $5, $6, $7, null, false, 'lemonslice')`,
          [
            tenant.id,
            avatar.name,
            imageUrl,
            avatar.personality,
            avatar.id,
            avatar.name,
            avatar.personality,
          ]
        );
        console.log(`Inserted ${avatar.id} (${avatar.name}) for tenant ${tenant.id}`);
        totalInserted++;
      }
    }

    console.log(`\nDone. Inserted: ${totalInserted}, Skipped (already exists): ${totalSkipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
