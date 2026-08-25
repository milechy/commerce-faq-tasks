#!/usr/bin/env ts-node
/**
 * SCRIPTS/reconcile-billing.ts
 * B-2: 月次請求突合 — usage_logs の再計算値と、Stripeへ送信を記録した値を照合する
 *
 * 使い方:
 *   pnpm ts-node SCRIPTS/reconcile-billing.ts                 # 先月分
 *   pnpm ts-node SCRIPTS/reconcile-billing.ts --period=202603  # 指定月分
 *
 * VPS cron 例（毎月2日 03:00 UTC。report-stripe-usage.ts の日次バッチが
 * 先月分を送り終えている想定で1日ずらす）:
 *   0 3 2 * * cd /opt/rajiuce && pnpm ts-node SCRIPTS/reconcile-billing.ts >> /var/log/billing-reconcile.log 2>&1
 */

import "dotenv/config";
import pino from "pino";
// @ts-ignore
import { Pool } from "pg";
import { reconcileMonth } from "../src/lib/billing/billingReconciliation";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const args = process.argv.slice(2);
  const periodArg = args.find((a) => a.startsWith("--period="))?.split("=")[1];

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    logger.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const db = new Pool({ connectionString: dbUrl });

  try {
    const results = await reconcileMonth(db, logger, periodArg);
    const mismatches = results.filter((r) => !r.matches);

    logger.info(
      { period: periodArg ?? "(先月)", totalTenants: results.length, mismatches: mismatches.length },
      "[reconcile-billing] completed"
    );

    if (mismatches.length > 0) {
      for (const m of mismatches) {
        logger.warn(m, "[reconcile-billing] mismatch");
      }
      process.exitCode = 1; // cron のメール通知等に引っ掛けられるよう非ゼロで終了する
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  logger.error({ err }, "[reconcile-billing] fatal error");
  process.exit(1);
});
