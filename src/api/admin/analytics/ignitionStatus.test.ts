// src/api/admin/analytics/ignitionStatus.test.ts
//
// 1) buildIgnitionStatus の純関数テスト(env の境界値を含む)
// 2) 機械的ガード — 既存のフラグ判定を再実装していないこと。
//    featureFlag.ts / judgeSweepRunner.ts の解釈が2箇所に割れると、
//    画面が「有効」と言っているのに本番は無効、という最悪の食い違いが起きる。

import fs from "node:fs";
import path from "node:path";
import { buildIgnitionStatus, type IgnitionDeps, type TenantIgnitionInput } from "./ignitionStatus";

const TENANTS: TenantIgnitionInput[] = [
  { id: "carnation", features: { sales_stage_continuity: true, hermes_raw_data_consent: false } },
  { id: "r2c_default", features: null },
];

function deps(over: Partial<IgnitionDeps> = {}): IgnitionDeps {
  return {
    learnedMemoryWrite: () => false,
    learnedMemoryRead: () => false,
    sweepTenants: () => ["r2c_default"],
    ...over,
  };
}

const cell = (res: ReturnType<typeof buildIgnitionStatus>, tenant: string, feature: string) =>
  res.rows.find((r) => r.tenantId === tenant)!.cells.find((c) => c.feature === feature)!;

describe("buildIgnitionStatus", () => {
  it("全テナント×全機能のセルを返す", () => {
    const res = buildIgnitionStatus(TENANTS, deps());
    expect(res.rows.map((r) => r.tenantId)).toEqual(["carnation", "r2c_default"]);
    expect(res.rows[0]!.cells).toHaveLength(5);
  });

  it("定期評価の対象テナントだけ judge_sweep が有効になる", () => {
    const res = buildIgnitionStatus(TENANTS, deps());
    expect(cell(res, "r2c_default", "judge_sweep").enabled).toBe(true);
    expect(cell(res, "carnation", "judge_sweep").enabled).toBe(false);
  });

  it("sweep対象が '*' なら全テナントが対象になる", () => {
    const res = buildIgnitionStatus(TENANTS, deps({ sweepTenants: () => ["*"] }));
    expect(res.rows.every((r) => r.cells.find((c) => c.feature === "judge_sweep")!.enabled)).toBe(true);
  });

  it("sweep対象が空配列なら誰も対象にならない", () => {
    const res = buildIgnitionStatus(TENANTS, deps({ sweepTenants: () => [] }));
    expect(res.rows.every((r) => !r.cells.find((c) => c.feature === "judge_sweep")!.enabled)).toBe(true);
  });

  it("features が null のテナントでも落ちず、全て無効として扱う", () => {
    const res = buildIgnitionStatus(TENANTS, deps());
    expect(cell(res, "r2c_default", "sales_stage_continuity").enabled).toBe(false);
    expect(cell(res, "r2c_default", "hermes_raw_data_consent").enabled).toBe(false);
  });

  it("features の boolean true と文字列 \"true\" を同じ扱いにする(dialogAgent は ->> で文字列比較する)", () => {
    const res = buildIgnitionStatus(
      [{ id: "t", features: { sales_stage_continuity: "true" } }],
      deps(),
    );
    expect(cell(res, "t", "sales_stage_continuity").enabled).toBe(true);
  });

  it('features の "yes" や 1 は有効にしない(dialogAgent の === "true" と揃える)', () => {
    for (const v of ["yes", 1, "1", "TRUE", null]) {
      const res = buildIgnitionStatus([{ id: "t", features: { sales_stage_continuity: v } }], deps());
      expect(cell(res, "t", "sales_stage_continuity").enabled).toBe(false);
    }
  });

  it("無効なセルには「なぜ無効か」が入る(数値だけを出さない)", () => {
    const res = buildIgnitionStatus(TENANTS, deps());
    const c = cell(res, "carnation", "judge_sweep");
    expect(c.enabled).toBe(false);
    expect(c.reason).toContain("対象外");
    expect(c.configKey).toBe("JUDGE_SWEEP_TENANTS");
  });

  it("env でしか開閉できない機能を envControlledFeatures に列挙する(禁止41の是正対象)", () => {
    const res = buildIgnitionStatus(TENANTS, deps());
    expect(res.envControlledFeatures).toEqual([
      "judge_sweep",
      "learned_memory_read",
      "learned_memory_write",
    ]);
  });

  it("全機能が無効なら anyEnabled=false(「有効な機能はありません」を描けるようにする)", () => {
    const res = buildIgnitionStatus([{ id: "t", features: null }], deps({ sweepTenants: () => [] }));
    expect(res.anyEnabled).toBe(false);
  });

  it("テナントが0件でも落ちない", () => {
    const res = buildIgnitionStatus([], deps());
    expect(res.rows).toEqual([]);
    expect(res.anyEnabled).toBe(false);
  });

  it("画面表示用の label に内部語(env名・列名)を出さない", () => {
    const res = buildIgnitionStatus(TENANTS, deps());
    for (const c of res.rows[0]!.cells) {
      expect(c.label).not.toMatch(/LEARNED_MEMORY|JUDGE_SWEEP|tenants\.features|_id\b/);
    }
  });
});

describe("フラグ解釈を再実装していないことの機械的ガード", () => {
  const src = fs.readFileSync(path.join(__dirname, "ignitionStatus.ts"), "utf-8");

  it("featureFlag.ts と judgeSweepRunner.ts の判定を import している", () => {
    expect(src).toMatch(/import\s*\{[^}]*isLearnedMemoryWriteEnabled[^}]*\}\s*from\s*".*featureFlag"/s);
    expect(src).toMatch(/import\s*\{[^}]*resolveSweepTenants[^}]*\}\s*from\s*".*judgeSweepRunner"/s);
  });

  it("env を直接読んで判定を再実装していない", () => {
    // process.env をこのファイルで読むと、featureFlag.ts と解釈が割れる余地が生まれる。
    expect(src).not.toMatch(/process\.env/);
  });
});
