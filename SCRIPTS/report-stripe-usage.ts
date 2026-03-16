#!/usr/bin/env ts-node
/**
 * SCRIPTS/report-stripe-usage.ts
 * Phase37 Step6: Stripe 課金 — usage_logs → Stripe UsageRecord 手動送信
 *
 * 使い方:
 *   pnpm ts-node SCRIPTS/report-stripe-usage.ts
 *   pnpm ts-node SCRIPTS/report-stripe-usage.ts --tenant=demo-tenant
 *   pnpm ts-node SCRIPTS/report-stripe-usage.ts --period=202603
 *
 * VPS cron 例（毎日 02:00 UTC）:
 *   0 2 * * * cd /opt/rajiuce && pnpm ts-node SCRIPTS/report-stripe-usage.ts >> /var/log/stripe-usage.log 2>&1
 */

import "dotenv/config";
import pino from "pino";
// @ts-ignore
import { Pool } from "pg";
import { reportUsageToStripe } from "../src/lib/billing/stripeSync";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const args = process.argv.slice(2);
  const tenantArg = args.find((a) => a.startsWith("--tenant="))?.split("=")[1];
  const periodArg = args.find((a) => a.startsWith("--period="))?.split("=")[1];

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    logger.error("DATABASE_URL is not set");
    process.exit(1);
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    logger.error("STRIPE_SECRET_KEY is not set");
    process.exit(1);
  }

  const db = new Pool({ connectionString: dbUrl });

  try {
    // 送信前: usage_logs の未送信件数を確認
    const countRes = await db.query(
      `SELECT COUNT(*) AS cnt FROM usage_logs WHERE billing_status = 'pending'`
    );
    const pendingCount = Number(countRes.rows[0].cnt);
    logger.info({ pendingCount, tenant: tenantArg ?? "all", period: periodArg ?? "current" },
      "[report-stripe] starting"
    );

    if (pendingCount === 0) {
      logger.info("[report-stripe] no pending usage logs, nothing to report");
      return;
    }

    await reportUsageToStripe(db, logger, {
      tenantId: tenantArg,
      periodYyyyMm: periodArg,
    });

    // 送信後: 確認
    const afterRes = await db.query(
      `SELECT billing_status, COUNT(*) AS cnt
       FROM usage_logs
       GROUP BY billing_status
       ORDER BY billing_status`
    );
    const summary = Object.fromEntries(afterRes.rows.map((r: any) => [r.billing_status, Number(r.cnt)]));
    logger.info({ summary }, "[report-stripe] completed");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  logger.error({ err }, "[report-stripe] fatal error");
  process.exit(1);
});
