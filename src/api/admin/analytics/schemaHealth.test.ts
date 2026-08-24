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

  it("レジストリがソースの INSERT 文と完全一致する", () => {
    const scanned = scanInsertColumns();
    const registryTables = Object.keys(REQUIRED_COLUMNS).sort();
    const scannedTables = Object.keys(scanned).sort();

    // 正規表現が壊れて空振りしていないことの下限アサーション
    expect(scannedTables.length).toBeGreaterThan(20);

    expect(scannedTables).toEqual(registryTables);

    for (const t of scannedTables) {
      expect({ table: t, columns: [...(REQUIRED_COLUMNS[t] ?? [])].sort() }).toEqual({
        table: t,
        columns: scanned[t]!,
      });
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
