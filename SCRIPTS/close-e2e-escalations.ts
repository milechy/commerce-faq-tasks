// SCRIPTS/close-e2e-escalations.ts
// GID 1217808492496192: 「対応中の会話」に溜まった e2e/内部テスト由来の
// エスカレーション残骸(本番実測373件、carnation / 「営業時間を教えてください」/
// 2メッセージ / 数分〜数時間おき)を一括クローズするワンショットスクリプト。
//
// 対象条件は src/api/admin/chat-history/chatHistoryRepository.ts の
// getActiveEscalations() が「対応中」とみなす条件(is_escalated=true AND
// escalation_resolved_at IS NULL)に、metadata->>'source' != 'user' を重ねたもの。
// metadata->>'source' が NULL(記録開始前の古いセッション)のものは対象にしない
// (NULL != 'user' は SQL 上 NULL になり、そのまま false 扱いで除外される。
//  API 側のデフォルト絞り込みが「NULLはuser扱い」で安全側に倒しているのと
//  同じ判断に揃えている)。
//
// 使い方:
//   Dry-run(既定。何も更新しない。件数と内訳だけ表示):
//     DATABASE_URL=... npx ts-node SCRIPTS/close-e2e-escalations.ts
//
//   実際にクローズ(escalation_resolved_at = NOW() を一括UPDATE):
//     DATABASE_URL=... npx ts-node SCRIPTS/close-e2e-escalations.ts --apply
//
// 前提:
//   - DATABASE_URL が設定されていること。
//   - 実データへの --apply 実行は必ず対象件数を目視確認してから行うこと。

import "dotenv/config";
import { Pool } from "pg";

const TARGET_CONDITION = `
  s.is_escalated = true
  AND s.escalation_resolved_at IS NULL
  AND s.metadata->>'source' != 'user'
`;

interface TargetRow {
  id: string;
  tenant_id: string;
  session_id: string;
  source: string | null;
  escalated_at: string;
  message_count: number;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");

  const pool = new Pool({ connectionString: dbUrl });

  try {
    const targetResult = await pool.query<TargetRow>(
      `SELECT s.id, s.tenant_id, s.session_id, s.metadata->>'source' AS source,
              s.escalated_at, s.message_count
       FROM chat_sessions s
       WHERE ${TARGET_CONDITION}
       ORDER BY s.escalated_at DESC`,
    );
    const rows = targetResult.rows;

    console.log(`[close-e2e-escalations] target rows: ${rows.length}`);

    // テナント別 / source別の内訳(想定外の混入がないか目視確認するため)
    const byTenant = new Map<string, number>();
    const bySource = new Map<string, number>();
    for (const row of rows) {
      byTenant.set(row.tenant_id, (byTenant.get(row.tenant_id) ?? 0) + 1);
      const sourceKey = row.source ?? "(null)";
      bySource.set(sourceKey, (bySource.get(sourceKey) ?? 0) + 1);
    }
    console.log("[close-e2e-escalations] by tenant:", Object.fromEntries(byTenant));
    console.log("[close-e2e-escalations] by source:", Object.fromEntries(bySource));

    if (rows.length === 0) {
      console.log("[close-e2e-escalations] nothing to close.");
      return;
    }

    if (!apply) {
      console.log(
        '\n[close-e2e-escalations] dry-run only. To actually close these escalations, run with "--apply".',
      );
      return;
    }

    // 上で表示した内訳(rows)と実際に更新する行を一致させる。TARGET_CONDITION を
    // UPDATE 側で単独に再実行すると、この関数内での SELECT〜UPDATE のわずかな間に
    // 新たにescalateしたセッションを巻き込んだり、逆に人間が対応完了させたセッションを
    // 上書きしうる(TOCTOU)。id = ANY(...) で対象を上のSELECT結果に固定したうえで、
    // AND TARGET_CONDITION は再確認として残す(その間に人間が対応完了させていたら
    // escalation_resolved_at IS NULL が外れ、その行はUPDATEされない=安全側)。
    const targetIds = rows.map((row) => row.id);
    const updateResult = await pool.query(
      `UPDATE chat_sessions s
       SET escalation_resolved_at = NOW()
       WHERE s.id = ANY($1::uuid[]) AND ${TARGET_CONDITION}`,
      [targetIds],
    );
    console.log(`[close-e2e-escalations] closed ${updateResult.rowCount ?? 0} escalations.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[close-e2e-escalations] failed:", error);
    process.exit(1);
  });
}
