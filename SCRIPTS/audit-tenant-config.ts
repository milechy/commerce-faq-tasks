#!/usr/bin/env ts-node
/**
 * SCRIPTS/audit-tenant-config.ts
 * P0-5 (GID 1217808301788163): 全テナントの allowed_origins / system_prompt を点検する
 * 読み取り専用レポートツール。
 *
 * 背景: carnation(稼働中の実テナント)の allowed_origins が R2C 自身の運用ドメイン
 * (admin.r2c.biz / api.r2c.biz)のみで、テナントの実サイトのURLが1つも入っていなかった
 * (2026-08-25 実測)。空なら originCheck.ts が全ドメイン許可にフォールバックするが、
 * 値が入っていて中身が誤っているこのケースは無言で止まる。同じ画面で system_prompt も
 * 空だった。4テナントでも目視は漏れる、テナントが増えると必ず漏れるため機械的に点検する。
 *
 * このスクリプトは **読み取り専用**。tenants テーブルへの書き込みは一切行わない。
 * 判定ロジックは src/lib/tenantConfigAudit.ts の純関数(ユニットテストは同ディレクトリの
 * tenantConfigAudit.test.ts)を使い、ここには判定を埋め込まない。
 *
 * 使い方:
 *   pnpm ts-node SCRIPTS/audit-tenant-config.ts            # 人間向けテーブル
 *   pnpm ts-node SCRIPTS/audit-tenant-config.ts --json     # JSON
 *
 * 是正(実データの投入)はこのスクリプトの範囲外。点検結果を hkobayashi に共有し、
 * 投入するURL/system_promptの内容は人間が判断する(Asana GID 1217808301788163 参照)。
 */

import "dotenv/config";
import pino from "pino";
// @ts-ignore
import { Pool } from "pg";
import { auditTenantConfig, hasAnyIssue, type TenantConfigIssues } from "../src/lib/tenantConfigAudit";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

interface TenantRow {
  id: string;
  name: string;
  allowed_origins: string[] | null;
  system_prompt: string | null;
}

interface TenantReport {
  id: string;
  name: string;
  allowedOrigins: string[];
  issues: TenantConfigIssues;
}

function formatIssueLabels(issues: TenantConfigIssues): string[] {
  const labels: string[] = [];
  if (issues.emptyOrigins) labels.push("allowed_origins空(fail-open)");
  if (issues.r2cOwnDomainOnly) labels.push("R2C自身のドメインのみ(致命的: ウィジェットが1ページも動かない)");
  if (issues.r2cOwnDomainMixed) labels.push("R2C自身のドメインが混在(軽度: 動くが不要なエントリ)");
  if (issues.invalidOriginPattern) labels.push("不正なオリジン形式(パブリックサフィックスワイルドカード等)");
  if (issues.unmatchableOrigins.length > 0) {
    // 完全一致で照合されるため、これらは1件も一致せず全ページでウィジェットが止まる。
    labels.push(`ブラウザOriginと一致し得ない登録: ${issues.unmatchableOrigins.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  if (issues.emptySystemPrompt) labels.push("system_prompt空");
  return labels;
}

async function main() {
  const jsonOutput = process.argv.includes("--json");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    logger.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const db = new Pool({ connectionString: dbUrl });

  try {
    // 読み取り専用: SELECT のみ。このスクリプトに書き込みクエリを追加しないこと。
    const result = await db.query(
      "SELECT id, name, allowed_origins, system_prompt FROM tenants ORDER BY id"
    );
    const rows = result.rows as TenantRow[];

    const reports: TenantReport[] = rows.map((row) => {
      const allowedOrigins = row.allowed_origins ?? [];
      return {
        id: row.id,
        name: row.name,
        allowedOrigins,
        issues: auditTenantConfig({ allowedOrigins, systemPrompt: row.system_prompt }),
      };
    });

    const flagged = reports.filter((r) => hasAnyIssue(r.issues));

    if (jsonOutput) {
      console.log(JSON.stringify({ total: reports.length, flagged: flagged.length, reports }, null, 2));
      return;
    }

    console.log("\n=== テナント設定点検 (allowed_origins / system_prompt) ===\n");
    for (const r of reports) {
      const labels = formatIssueLabels(r.issues);
      const status = labels.length > 0 ? `⚠️  ${labels.join(" / ")}` : "OK";
      console.log(`- ${r.id} (${r.name})`);
      console.log(`    allowed_origins: ${JSON.stringify(r.allowedOrigins)}`);
      console.log(`    判定: ${status}`);
    }
    console.log(`\n合計 ${reports.length} テナント中 ${flagged.length} 件で要確認\n`);

    logger.info({ total: reports.length, flagged: flagged.length }, "[audit-tenant-config] scan complete");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  logger.error({ err }, "[audit-tenant-config] fatal error");
  process.exit(1);
});
