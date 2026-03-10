#!/usr/bin/env ts-node
// SCRIPTS/sync-es.ts
// faq_docs → ESインデックス同期スクリプト
//
// 使い方:
//   # 特定テナントのみ
//   DATABASE_URL=... ES_URL=... pnpm ts-node SCRIPTS/sync-es.ts --tenant carnation
//
//   # 全テナント（faq_docsに存在するtenant_id全件）
//   DATABASE_URL=... ES_URL=... pnpm ts-node SCRIPTS/sync-es.ts --all

// @ts-ignore - pg types なしで require する
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg") as { Pool: any };

const pgUrl = process.env.DATABASE_URL;
const esUrl = (process.env.ES_URL || "").replace(/\/$/, "");

if (!pgUrl) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}
if (!esUrl) {
  console.error("ERROR: ES_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: pgUrl });

// 引数解析
const args = process.argv.slice(2);
const tenantIdx = args.indexOf("--tenant");
const allMode = args.includes("--all");
const tenantArg = tenantIdx >= 0 ? args[tenantIdx + 1] : null;

if (!allMode && !tenantArg) {
  console.log("使い方:");
  console.log("  pnpm ts-node SCRIPTS/sync-es.ts --tenant <tenantId>");
  console.log("  pnpm ts-node SCRIPTS/sync-es.ts --all");
  process.exit(0);
}

// ESインデックスのmappings（kuromojiアナライザー付き）
const MAPPINGS_KUROMOJI = {
  mappings: {
    properties: {
      tenant_id: { type: "keyword" },
      question: { type: "text", analyzer: "kuromoji" },
      answer: { type: "text", analyzer: "kuromoji" },
      category: { type: "keyword" },
      tags: { type: "keyword" },
      faq_id: { type: "integer" },
      created_at: { type: "date" },
    },
  },
};

// フォールバック用（standardアナライザー）
const MAPPINGS_STANDARD = {
  mappings: {
    properties: {
      tenant_id: { type: "keyword" },
      question: { type: "text", analyzer: "standard" },
      answer: { type: "text", analyzer: "standard" },
      category: { type: "keyword" },
      tags: { type: "keyword" },
      faq_id: { type: "integer" },
      created_at: { type: "date" },
    },
  },
};

const ES_HEADERS = {
  "Content-Type": "application/vnd.elasticsearch+json; compatible-with=8",
  Accept: "application/vnd.elasticsearch+json; compatible-with=8",
};

/** faq_docsに存在するtenant_id一覧を取得 */
async function getTenants(): Promise<string[]> {
  const res = await pool.query(
    "SELECT DISTINCT tenant_id FROM faq_docs ORDER BY tenant_id"
  );
  return res.rows.map((r: any) => r.tenant_id as string);
}

/** ESインデックスを削除（存在しない場合は無視） */
async function deleteIndex(index: string): Promise<void> {
  const res = await fetch(`${esUrl}/${index}`, {
    method: "DELETE",
    headers: ES_HEADERS,
  });
  if (res.ok) {
    console.log(`  [DELETE] ${index} → deleted`);
  } else if (res.status === 404) {
    console.log(`  [DELETE] ${index} → not found, skip`);
  } else {
    const body = await res.text();
    console.warn(`  [DELETE] ${index} → ${res.status}: ${body}`);
  }
}

/** ESインデックスをmappings付きで作成（kuromojiが使えない場合はstandardにフォールバック） */
async function createIndex(index: string): Promise<void> {
  // まずkuromojiで試みる
  const res = await fetch(`${esUrl}/${index}`, {
    method: "PUT",
    headers: ES_HEADERS,
    body: JSON.stringify(MAPPINGS_KUROMOJI),
  });

  if (res.ok) {
    console.log(`  [CREATE] ${index} → created (analyzer: kuromoji)`);
    return;
  }

  const body = await res.text();
  // kuromojiが使えない場合のエラーを検出してフォールバック
  if (
    res.status === 400 &&
    (body.includes("analyzer") ||
      body.includes("kuromoji") ||
      body.includes("unknown"))
  ) {
    console.warn(
      `  [CREATE] ${index} → kuromoji unavailable, falling back to standard`
    );
    const res2 = await fetch(`${esUrl}/${index}`, {
      method: "PUT",
      headers: ES_HEADERS,
      body: JSON.stringify(MAPPINGS_STANDARD),
    });
    if (res2.ok) {
      console.log(`  [CREATE] ${index} → created (analyzer: standard)`);
      return;
    }
    const body2 = await res2.text();
    console.error(`  [CREATE] ${index} → ERROR ${res2.status}: ${body2}`);
    throw new Error(`Failed to create index ${index}: ${body2}`);
  }

  console.error(`  [CREATE] ${index} → ERROR ${res.status}: ${body}`);
  throw new Error(`Failed to create index ${index}: ${body}`);
}

/** バルクINSERT。成功件数を返す */
async function bulkIndex(index: string, rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;

  // バルクAPIフォーマット: action\ndoc\n 繰り返し
  const lines: string[] = [];
  for (const row of rows) {
    const action = JSON.stringify({ index: { _index: index, _id: String(row.faq_id) } });
    const doc = JSON.stringify({
      tenant_id: row.tenant_id,
      question: row.question,
      // answerはDB制約と同様に2000文字まで
      answer: (row.answer || "").slice(0, 2000),
      category: row.category || null,
      tags: Array.isArray(row.tags) ? row.tags : (row.tags ? [row.tags] : []),
      faq_id: row.faq_id,
      created_at: row.created_at
        ? new Date(row.created_at).toISOString()
        : null,
    });
    lines.push(action);
    lines.push(doc);
  }
  // バルクAPIはボディの末尾に改行が必要
  const body = lines.join("\n") + "\n";

  const res = await fetch(`${esUrl}/_bulk`, {
    method: "POST",
    headers: ES_HEADERS,
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`  [BULK] ERROR ${res.status}: ${errBody}`);
    return 0;
  }

  const result = (await res.json()) as any;
  let successCount = 0;
  let errorCount = 0;

  if (result.errors) {
    for (const item of result.items || []) {
      const op = item.index;
      if (op && op.error) {
        errorCount++;
        console.warn(
          `  [BULK] doc _id=${op._id} error: ${JSON.stringify(op.error)}`
        );
      } else {
        successCount++;
      }
    }
    console.warn(
      `  [BULK] batch done: ${successCount} ok, ${errorCount} errors`
    );
  } else {
    successCount = rows.length;
  }

  return successCount;
}

/** 1テナント分をESに同期 */
async function syncTenant(tenantId: string): Promise<void> {
  const index = `faq_${tenantId}`;
  console.log(`\n[SYNC] tenant: ${tenantId} → index: ${index}`);

  // 1. インデックス削除
  await deleteIndex(index);

  // 2. インデックス作成
  await createIndex(index);

  // 3. faq_docs を100件ずつバルクINSERT
  const BATCH_SIZE = 100;
  let offset = 0;
  let totalSuccess = 0;

  while (true) {
    const res = await pool.query(
      "SELECT * FROM faq_docs WHERE tenant_id = $1 ORDER BY id LIMIT $2 OFFSET $3",
      [tenantId, BATCH_SIZE, offset]
    );
    const rows: any[] = res.rows;
    if (rows.length === 0) break;

    const count = await bulkIndex(index, rows);
    totalSuccess += count;
    offset += rows.length;

    console.log(
      `  [PROGRESS] offset=${offset}, batch=${rows.length}, total_success=${totalSuccess}`
    );

    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[DONE] ${tenantId}: ${totalSuccess} docs indexed`);
}

/** メイン処理 */
async function main(): Promise<void> {
  try {
    let tenants: string[];

    if (allMode) {
      tenants = await getTenants();
      if (tenants.length === 0) {
        console.log("faq_docs にデータが存在しません。");
        return;
      }
      console.log(`全テナント同期: ${tenants.join(", ")}`);
    } else {
      tenants = [tenantArg as string];
      console.log(`テナント指定同期: ${tenants[0]}`);
    }

    for (const tenantId of tenants) {
      await syncTenant(tenantId);
    }

    console.log("\n===== 同期完了 =====");
    console.log(`処理テナント数: ${tenants.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: any) => {
  console.error("sync-es failed:", err);
  process.exit(1);
});
