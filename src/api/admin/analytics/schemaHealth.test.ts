// src/api/admin/analytics/schemaHealth.test.ts
//
// 2本立て:
//   1) findMissingColumns の純関数テスト(境界含む)
//   2) 機械的ガード — REQUIRED_COLUMNS が src/**/*.ts の INSERT 文と完全一致すること。
//      手書きレジストリは DEPLOY_CHECKLIST.md と同じ腐り方をするため、
//      confirmPolicy.test.ts と同じ流儀でソースを readFileSync して同期を強制する。
//
// このテストが落ちたら、レジストリを直すだけで終わらせないこと。
// 「その列を追加する migration が存在し、docs/DEPLOY_CHECKLIST.md に載っているか」を必ず確認する。

import fs from "node:fs";
import path from "node:path";
import { REQUIRED_COLUMNS, findMissingColumns } from "./schemaHealth";

describe("findMissingColumns", () => {
  const required = { t1: ["a", "b"], t2: ["x"] } as const;

  it("全て揃っていれば空を返す(欠落なしが正常)", () => {
    const actual = new Map([
      ["t1", new Set(["a", "b", "extra"])],
      ["t2", new Set(["x"])],
    ]);
    expect(findMissingColumns(actual, required)).toEqual([]);
  });

  it("1列欠けたらその列だけを返す", () => {
    const actual = new Map([
      ["t1", new Set(["a"])],
      ["t2", new Set(["x"])],
    ]);
    expect(findMissingColumns(actual, required)).toEqual([
      { table: "t1", columns: ["b"], tableMissing: false },
    ]);
  });

  it("テーブルごと無い場合は tableMissing=true で全列を返す", () => {
    const actual = new Map([["t2", new Set(["x"])]]);
    expect(findMissingColumns(actual, required)).toEqual([
      { table: "t1", columns: ["a", "b"], tableMissing: true },
    ]);
  });

  it("DBが1行も返さない(接続直後・権限不足)場合は全テーブルを欠落として報告する", () => {
    const actual = new Map<string, Set<string>>();
    const missing = findMissingColumns(actual, required);
    expect(missing).toHaveLength(2);
    expect(missing.every((m) => m.tableMissing)).toBe(true);
  });

  it("実DBに余分な列があっても欠落として扱わない", () => {
    const actual = new Map([
      ["t1", new Set(["a", "b", "legacy_col"])],
      ["t2", new Set(["x", "another"])],
    ]);
    expect(findMissingColumns(actual, required)).toEqual([]);
  });

  it("要求が空なら常に空を返す", () => {
    expect(findMissingColumns(new Map(), {})).toEqual([]);
  });
});

describe("REQUIRED_COLUMNS の機械的ガード", () => {
  // src/**/*.ts を走査して INSERT INTO <table> (cols) を集める。
  // schemaHealth.ts の生成時と同一のロジック。変更する場合は両方を同時に直すこと。
  function scanInsertColumns(): Record<string, string[]> {
    const root = path.resolve(__dirname, "../../..");
    const found: Record<string, Set<string>> = {};

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          const src = fs.readFileSync(full, "utf-8");
          const re = /INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]{0,1200})\)/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src)) !== null) {
            const table = m[1]!.toLowerCase();
            const cols = m[2]!
              .split(",")
              .map((c) => c.trim().replace(/"/g, "").toLowerCase())
              .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
            if (cols.length === 0) continue;
            found[table] = found[table] ?? new Set<string>();
            for (const c of cols) found[table]!.add(c);
          }
        }
      }
    };
    walk(root);

    const out: Record<string, string[]> = {};
    for (const t of Object.keys(found).sort()) out[t] = [...found[t]!].sort();
    return out;
  }

  // scanInsertColumns の正規表現(INSERT\s+INTO\s+([a-z_]+))はリテラルなテーブル名しか
  // 検出できない。stripeSync.ts の _chargeMonthlyFixedShare は
  // `INSERT INTO ${table} (...)` とテンプレートリテラル変数でテーブル名を切り替える
  // (lemonslice/livekit/platform_monthly_charges の3テーブルを1つの関数で共有するため)。
  // そのためこの3テーブルは静的スキャンの対象外になる。REQUIRED_COLUMNS には
  // 含める(schemaHealth の実行時チェックには効かせたい。migration未適用時の
  // INSERT全滅を検知できないと按分請求が無言で止まるため)が、この機械的ガードの
  // 完全一致チェックからは除外し、代わりに下のテストでソースの実際のカラム列と
  // 手動で突き合わせる。
  const DYNAMIC_TABLE_NAME_EXCLUSIONS = [
    "lemonslice_monthly_charges",
    "livekit_monthly_charges",
    "platform_monthly_charges",
  ];

  // ナレッジ配線是正P15: この機械的ガードは `INSERT INTO table (cols)` しか走査しない。
  // knowledge_gaps.recommended_action / suggested_answer は gapRecommender.ts:130-140 の
  // UPDATE でしか書かれない(pending時点のINSERTには無く、後から推薦生成で埋まる)ため、
  // INSERT走査には決して現れない。それでも schemaHealth の実行時チェックには含めたい
  // (migration未適用のまま推薦生成が動くと、このUPDATEが無言で失敗し続けるため)。
  // テーブルごと除外(DYNAMIC_TABLE_NAME_EXCLUSIONS)は粒度が粗すぎる
  // (knowledge_gaps の他の列の突合まで失う)ため、列単位の例外にする。
  // 下の別テストで「本当にUPDATE文に実在するか」をソースから確認し、
  // 登録しただけで放置される事故を防ぐ。
  const UPDATE_ONLY_COLUMNS: Record<string, string[]> = {
    knowledge_gaps: ["recommended_action", "suggested_answer"],
    // tenant_contact_email は tenants の INSERT(routes.ts:764)には無く、
    // super_adminの設定タブ(routes.ts:945)とGA4連携(ga4Routes.ts:64)のUPDATEで
    // 後から書き込まれる。checkout-session(billingApi.ts:747)が SELECT で読む
    // ため実行時チェックには含めたいが、機械的ガードはINSERTしか見ない。
    tenants: ["tenant_contact_email"],
  };

  it("レジストリがソースの INSERT 文と完全一致する(動的テーブル名・UPDATE専用列を除く)", () => {
    const scanned = scanInsertColumns();
    const registryTables = Object.keys(REQUIRED_COLUMNS)
      .filter((t) => !DYNAMIC_TABLE_NAME_EXCLUSIONS.includes(t))
      .sort();
    const scannedTables = Object.keys(scanned).sort();

    // 正規表現が壊れて空振りしていないことの下限アサーション
    expect(scannedTables.length).toBeGreaterThan(20);

    expect(scannedTables).toEqual(registryTables);

    for (const t of scannedTables) {
      const updateOnly = UPDATE_ONLY_COLUMNS[t] ?? [];
      const registryColumnsFromInsert = (REQUIRED_COLUMNS[t] ?? []).filter(
        (c) => !updateOnly.includes(c),
      );
      expect({ table: t, columns: [...registryColumnsFromInsert].sort() }).toEqual({
        table: t,
        columns: scanned[t]!,
      });
    }
  });

  it("UPDATE専用列として除外した列が、実際にUPDATE文で書かれていることを確認する(登録だけして放置されないように)", () => {
    for (const [table, columns] of Object.entries(UPDATE_ONLY_COLUMNS)) {
      for (const column of columns) {
        expect(REQUIRED_COLUMNS[table]).toContain(column);
      }
    }
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../agent/gap/gapRecommender.ts"),
      "utf-8",
    );
    expect(src).toMatch(/UPDATE\s+knowledge_gaps[\s\S]*?SET[\s\S]*?recommended_action\s*=/);
    expect(src).toMatch(/UPDATE\s+knowledge_gaps[\s\S]*?SET[\s\S]*?suggested_answer\s*=/);

    const routesSrc = fs.readFileSync(
      path.resolve(__dirname, "../tenants/routes.ts"),
      "utf-8",
    );
    expect(routesSrc).toMatch(/setClauses\.push\(`tenant_contact_email\s*=/);
  });

  it("動的テーブル名(lemonslice/livekit/platform_monthly_charges)のINSERT列がレジストリと一致する", () => {
    // _chargeMonthlyFixedShare は3テーブルとも同一のINSERT文テンプレートを使う
    // (stripeSync.ts:109)。テーブル名だけが変数なので、列名は固定文字列として
    // ソースから直接確認できる。
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../lib/billing/stripeSync.ts"),
      "utf-8"
    );
    const m = /INSERT INTO \$\{table\}\s*\(([^)]+)\)/.exec(src);
    expect(m).not.toBeNull();
    const cols = m![1]!
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
      .sort();

    for (const t of DYNAMIC_TABLE_NAME_EXCLUSIONS) {
      expect({ table: t, columns: [...REQUIRED_COLUMNS[t]!].sort() }).toEqual({ table: t, columns: cols });
    }
  });

  it("学習ループの主要テーブルがレジストリに含まれている", () => {
    // 2026-08-24 に実害が出た経路。取りこぼしを固定する。
    for (const t of ["chat_sessions", "chat_messages", "faq_docs", "tuning_rules"]) {
      expect(Object.keys(REQUIRED_COLUMNS)).toContain(t);
    }
    expect(REQUIRED_COLUMNS["chat_sessions"]).toContain("visitor_id");
    expect(REQUIRED_COLUMNS["faq_docs"]).toContain("product_price");
    expect(REQUIRED_COLUMNS["tuning_rules"]).toContain("dedup_key");
  });
});
