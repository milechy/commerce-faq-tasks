#!/usr/bin/env tsx
// SCRIPTS/weekly-report.ts
// Phase46: 週次レポート手動実行スクリプト
// 使い方: tsx SCRIPTS/weekly-report.ts [tenantId]

import 'dotenv/config';
// @ts-ignore
import { Pool } from 'pg';
import { runWeeklyReport } from '../src/agent/report/weeklyReportGenerator';

async function main() {
  const tenantId = process.argv[2] ?? process.env.DEFAULT_TENANT_ID ?? 'english-demo';

  if (!process.env.DATABASE_URL) {
    console.error('[weekly-report] ERROR: DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log(`[weekly-report] Running weekly report for tenant: ${tenantId}`);
    const result = await runWeeklyReport(tenantId, pool);

    console.log('\n=== Weekly Report Result ===');
    console.log(`Slack posted: ${result.slackPosted}`);
    console.log('\n--- Report Text ---');
    console.log(result.reportText);
    console.log('===================\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[weekly-report] Unexpected error:', err);
  process.exit(1);
});
