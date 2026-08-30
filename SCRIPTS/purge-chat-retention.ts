#!/usr/bin/env ts-node
/**
 * SCRIPTS/purge-chat-retention.ts
 *
 * 会話データの保持期間(retention)バッチ + テナント退会消去予約の実行。
 * 個情法/GDPR 対応。chat_messages.content は無期限・平文で溜まり続けるため、
 * 期限超過分と、退会予約済みテナント分を定期的に消去する。
 *
 * ★破壊的操作。既定は no-op(環境変数が未設定なら何もしない)★
 *   CHAT_RETENTION_DAYS      未設定 → 保持期間パージをスキップ
 *   TENANT_PURGE_GRACE_DAYS  未設定 → テナント退会消去をスキップ
 *
 * 使い方:
 *   pnpm ts-node SCRIPTS/purge-chat-retention.ts --dry-run   # 件数のみ表示・無変更
 *   CHAT_RETENTION_DAYS=180 pnpm ts-node SCRIPTS/purge-chat-retention.ts
 *
 * VPS cron 例(毎日 04:00 UTC):
 *   0 4 * * * cd /opt/rajiuce && CHAT_RETENTION_DAYS=180 TENANT_PURGE_GRACE_DAYS=30 \
 *     pnpm ts-node SCRIPTS/purge-chat-retention.ts >> /var/log/chat-retention.log 2>&1
 */

import "dotenv/config";
import pino from "pino";
// @ts-ignore
import { Pool } from "pg";
import {
  purgeExpiredChatData,
  purgeTenantChatData,
  findTenantsDueForPurge,
} from "../src/api/admin/chat-history/retentionRepository";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const actorEmail = "cron:purge-chat-retention";

  const retentionDays = parsePositiveInt(process.env.CHAT_RETENTION_DAYS);
  const graceDays = parsePositiveInt(process.env.TENANT_PURGE_GRACE_DAYS);

  if (retentionDays === null && graceDays === null) {
    logger.info(
      "CHAT_RETENTION_DAYS も TENANT_PURGE_GRACE_DAYS も未設定のため何もしません(既定 no-op)。",
    );
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    logger.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const db = new Pool({ connectionString: dbUrl });

  try {
    if (dryRun) {
      logger.info("[purge-chat-retention] DRY RUN — 一切書き込みません");
    }

    // 1) 保持期間による期限超過セッションの消去
    if (retentionDays !== null) {
      const result = await purgeExpiredChatData({
        retentionDays,
        dryRun,
        actorEmail,
        pool: db,
      });
      logger.info(
        {
          retention_days: retentionDays,
          cutoff: result.cutoff,
          dry_run: dryRun,
          sessions: result.sessions,
          messages: result.messages,
          option_orders_nulled: result.option_orders_nulled,
          batches: result.batches,
        },
        dryRun
          ? "[retention] 対象(dry-run): これだけ削除されます"
          : "[retention] 期限超過セッションを削除しました",
      );
    } else {
      logger.info("[retention] CHAT_RETENTION_DAYS 未設定のためスキップ");
    }

    // 2) テナント退会消去予約の実行(猶予期間経過分)
    if (graceDays !== null) {
      const due = await findTenantsDueForPurge(graceDays, db);
      logger.info(
        { grace_days: graceDays, due_count: due.length },
        "[tenant-purge] 消去対象テナント",
      );
      for (const t of due) {
        const result = await purgeTenantChatData({
          tenantId: t.tenant_id,
          actorRole: "system",
          actorEmail,
          reason: `retention batch: purge scheduled at ${t.requested_at}`,
          dryRun,
          pool: db,
        });
        logger.info(
          {
            tenant_id: t.tenant_id,
            requested_at: t.requested_at,
            dry_run: dryRun,
            sessions: result.sessions,
            messages: result.messages,
          },
          dryRun
            ? "[tenant-purge] 対象(dry-run)"
            : "[tenant-purge] テナント会話データを消去しました",
        );
      }
    } else {
      logger.info("[tenant-purge] TENANT_PURGE_GRACE_DAYS 未設定のためスキップ");
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  logger.error({ err }, "[purge-chat-retention] fatal error");
  process.exit(1);
});
