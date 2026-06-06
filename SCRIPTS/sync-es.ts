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
//
// 【alias-swap 方式 (2026-06-06〜)】消失再発防止:
//   旧来の delete-first（DELETE faq_<tenant> → CREATE → bulk）は、bulk が途中失敗すると
//   index が「消えたまま」になり本番検索が停止した（docs/ES_PROD_DURABILITY.md）。
//   現在は「新 index faq_<tenant>_<ts> を作成 → bulk 全件成功 → alias faq_<tenant> を原子的に
//   張り替え → 旧 index 削除」とする。途中失敗時は新 index のみ掃除し、現行 index/alias は無傷で残す。
//   論理名 `faq_<tenant>` は alias になり、app の read/write は単一 index alias 経由で透過動作する。

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
// Phase69-2 PR-C2 Round 2: is_published / is_excluded_from_search を明示マッピング
//   - dynamic mapping のブレを防ぐ
//   - hybrid.ts の filter.must_not で参照される
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
      is_published: { type: "boolean" },
      is_excluded_from_search: { type: "boolean" },
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
      is_published: { type: "boolean" },
      is_excluded_from_search: { type: "boolean" },
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
    const action = JSON.stringify({ index: { _index: index, _id: String(row.id) } });
    const doc = JSON.stringify({
      tenant_id: row.tenant_id,
      question: row.question,
      // answerはDB制約と同様に2000文字まで
      answer: (row.answer || "").slice(0, 2000),
      category: row.category || null,
      tags: Array.isArray(row.tags) ? row.tags : (row.tags ? [row.tags] : []),
      faq_id: row.id,
      created_at: row.created_at
        ? new Date(row.created_at).toISOString()
        : null,
      // Phase69-2 PR-C2 Round 2: 永続フィルター用フィールドを ES に同期
      is_published: row.is_published === false ? false : true,
      is_excluded_from_search: row.is_excluded_from_search === true,
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

/** テナントの faq_docs 件数（swap 可否の判定に使う） */
async function countTenantDocs(tenantId: string): Promise<number> {
  const r = await pool.query(
    "SELECT count(*)::int AS c FROM faq_docs WHERE tenant_id = $1",
    [tenantId]
  );
  return r.rows[0].c as number;
}

type AliasState = { kind: "absent" | "concrete" | "alias"; oldIndices: string[] };

/** 論理名 `name` の現在状態を解決する: 不在 / 同名の実体index(旧来) / alias */
async function resolveAliasState(name: string): Promise<AliasState> {
  const res = await fetch(`${esUrl}/_alias/${name}`, { headers: ES_HEADERS });
  if (res.status === 404) return { kind: "absent", oldIndices: [] };
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`alias 解決失敗 ${name}: ${res.status} ${body}`);
  }
  const data = (await res.json()) as Record<string, { aliases?: Record<string, unknown> }>;
  const keys = Object.keys(data);
  // 同名の実体 index（alias を持たない）= 旧来スキーム。alias 化のため先に削除が必要。
  if (keys.length === 1 && keys[0] === name && Object.keys(data[name].aliases || {}).length === 0) {
    return { kind: "concrete", oldIndices: [name] };
  }
  return { kind: "alias", oldIndices: keys };
}

/** _aliases の原子的アクションを実行 */
async function postAliases(actions: unknown[]): Promise<void> {
  const res = await fetch(`${esUrl}/_aliases`, {
    method: "POST",
    headers: ES_HEADERS,
    body: JSON.stringify({ actions }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`_aliases 失敗: ${res.status} ${body}`);
  }
}

/** alias を newIndex に張り替え、旧 index を削除する */
async function swapAlias(alias: string, newIndex: string, state: AliasState): Promise<void> {
  if (state.kind === "concrete") {
    // alias 名と同名の実体 index があると alias を張れない。一回限りの移行として先に削除。
    // （新 index は populate 済みなので、この瞬間に落ちてもデータは失われない）
    console.log(`  [ALIAS] 旧来の実体 index ${alias} を削除して alias 化`);
    await deleteIndex(alias);
    await postAliases([{ add: { index: newIndex, alias } }]);
  } else {
    // 原子的に張り替え（読み書きは常に旧 or 新のいずれかを指し、無index状態を作らない）
    const actions: unknown[] = [{ add: { index: newIndex, alias } }];
    for (const old of state.oldIndices) actions.push({ remove: { index: old, alias } });
    await postAliases(actions);
    for (const old of state.oldIndices) await deleteIndex(old);
  }
  console.log(`  [ALIAS] ${alias} → ${newIndex}`);
}

/** 1テナント分をESに同期（alias-swap 方式） */
async function syncTenant(tenantId: string): Promise<void> {
  const alias = `faq_${tenantId}`;
  const newIndex = `${alias}_${Date.now()}`;
  console.log(`\n[SYNC] tenant: ${tenantId} → alias: ${alias} (new index: ${newIndex})`);

  const expected = await countTenantDocs(tenantId);

  // 1. 新インデックス作成（旧 index/alias には一切触れない）
  await createIndex(newIndex);

  // 2. faq_docs を100件ずつバルクINSERT（失敗時は新 index を掃除して中断）
  const BATCH_SIZE = 100;
  let offset = 0;
  let totalSuccess = 0;
  try {
    while (true) {
      const res = await pool.query(
        "SELECT * FROM faq_docs WHERE tenant_id = $1 ORDER BY id LIMIT $2 OFFSET $3",
        [tenantId, BATCH_SIZE, offset]
      );
      const rows: any[] = res.rows;
      if (rows.length === 0) break;

      const count = await bulkIndex(newIndex, rows);
      totalSuccess += count;
      offset += rows.length;

      console.log(
        `  [PROGRESS] offset=${offset}, batch=${rows.length}, total_success=${totalSuccess}`
      );

      if (rows.length < BATCH_SIZE) break;
    }
  } catch (e) {
    await deleteIndex(newIndex);
    throw e;
  }

  // 3. 全件成功したときだけ alias を張り替える。部分失敗は旧 index を温存して中断。
  if (totalSuccess !== expected) {
    console.error(
      `  [ABORT] ${tenantId}: indexed ${totalSuccess}/${expected} → alias 張り替えを中止し旧 index を温存`
    );
    await deleteIndex(newIndex);
    throw new Error(`sync incomplete for ${tenantId}: ${totalSuccess}/${expected}`);
  }

  const state = await resolveAliasState(alias);
  await swapAlias(alias, newIndex, state);

  console.log(`[DONE] ${tenantId}: ${totalSuccess} docs indexed → alias ${alias} → ${newIndex}`);
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
