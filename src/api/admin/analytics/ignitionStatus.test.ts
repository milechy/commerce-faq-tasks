// src/api/admin/analytics/ignitionStatus.test.ts
//
// 1) buildIgnitionStatus の純関数テスト(env の境界値を含む)
// 2) 機械的ガード — 既存のフラグ判定を再実装していないこと。
//    featureFlag.ts / judgeSweepRunner.ts の解釈が2箇所に割れると、
//    画面が「有効」と言っているのに本番は無効、という最悪の食い違いが起きる。

import fs from "node:fs";
import path from "node:path";
import {
  buildIgnitionStatus,
  computeSeriesGates,
  fetchIgnitionStatus,
  type IgnitionDeps,
  type TenantIgnitionInput,
  type SeriesGateDeps,
} from "./ignitionStatus";

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
    expect(res.rows[0]!.cells).toHaveLength(6);
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
      "judge_x_memory_intersection",
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

describe("buildIgnitionStatus — judge_x_memory_intersection(ナレッジ配線是正P15)", () => {
  it("交差が空のとき、両方のセルが ON でも交差セルは false になる", () => {
    // sweep には carnation は入らず、memory write は carnation にしか許可しない
    // → 個々のセルは片方ずつON/OFFに分かれるが、同一テナントの交差セルはfalseのまま。
    const res = buildIgnitionStatus(TENANTS, deps({
      sweepTenants: () => ["r2c_default"],
      learnedMemoryWrite: (id) => id === "carnation",
    }));
    expect(cell(res, "carnation", "judge_sweep").enabled).toBe(false);
    expect(cell(res, "carnation", "learned_memory_write").enabled).toBe(true);
    expect(cell(res, "carnation", "judge_x_memory_intersection").enabled).toBe(false);

    expect(cell(res, "r2c_default", "judge_sweep").enabled).toBe(true);
    expect(cell(res, "r2c_default", "learned_memory_write").enabled).toBe(false);
    expect(cell(res, "r2c_default", "judge_x_memory_intersection").enabled).toBe(false);
  });

  it("交差があるとき交差セルは true になる", () => {
    const res = buildIgnitionStatus(TENANTS, deps({
      sweepTenants: () => ["carnation"],
      learnedMemoryWrite: (id) => id === "carnation",
    }));
    expect(cell(res, "carnation", "judge_sweep").enabled).toBe(true);
    expect(cell(res, "carnation", "learned_memory_write").enabled).toBe(true);
    expect(cell(res, "carnation", "judge_x_memory_intersection").enabled).toBe(true);
  });

  it("本番の実値(sweep=r2c_default既定 / memory write=carnationのみ許可)ではどのテナントも交差セルがfalse", () => {
    // resolveSweepTenants() の既定(env未設定)は ["r2c_default"]。
    // 本番 .env は LEARNED_MEMORY_TENANTS=carnation。交差ゼロが2026-08-25監査の実測値。
    const res = buildIgnitionStatus(TENANTS, deps({
      sweepTenants: () => ["r2c_default"],
      learnedMemoryWrite: (id) => id === "carnation",
    }));
    for (const row of res.rows) {
      expect(cell(res, row.tenantId, "judge_x_memory_intersection").enabled).toBe(false);
    }
  });
});

describe("buildIgnitionStatus — hermes_raw_data_consent(H-1: 点火状態の同意表示ドリフト是正)", () => {
  it("1) 新形式 learning={learn:true,share:true} → 同意済み", () => {
    const res = buildIgnitionStatus(
      [{ id: "t", features: { learning: { learn: true, share: true } } }],
      deps(),
    );
    expect(cell(res, "t", "hermes_raw_data_consent").enabled).toBe(true);
  });

  it("2) 旧フラグのみ(learning 未設定 + hermes_raw_data_consent=true) → 同意済み（後方互換）", () => {
    const res = buildIgnitionStatus(
      [{ id: "t", features: { hermes_raw_data_consent: true } }],
      deps(),
    );
    expect(cell(res, "t", "hermes_raw_data_consent").enabled).toBe(true);
  });

  it("3) 新形式 learning={learn:true,share:false} + 旧フラグ true → 未同意（新形式が優先される）", () => {
    const res = buildIgnitionStatus(
      [
        {
          id: "t",
          features: { learning: { learn: true, share: false }, hermes_raw_data_consent: true },
        },
      ],
      deps(),
    );
    expect(cell(res, "t", "hermes_raw_data_consent").enabled).toBe(false);
  });

  it("4) learning が壊れた形（文字列/配列/不完全オブジェクト）→ fail-safeで未同意", () => {
    for (const broken of ["true", ["learn"], { learn: true }]) {
      const res = buildIgnitionStatus([{ id: "t", features: { learning: broken } }], deps());
      expect(cell(res, "t", "hermes_raw_data_consent").enabled).toBe(false);
    }
  });
});

describe("computeSeriesGates(ナレッジ配線是正P15)", () => {
  function seriesDeps(over: Partial<SeriesGateDeps> = {}): SeriesGateDeps {
    return {
      learnedMemoryThreshold: () => 80,
      hasConvertingOutcome: jest.fn().mockResolvedValue(false),
      ...over,
    };
  }

  it("交差テナントが0件ならDBに問い合わせず4ゲート全て0/0を返す", async () => {
    const query = jest.fn();
    const db = { query };
    const gates = await computeSeriesGates(db as any, [], seriesDeps());
    expect(query).not.toHaveBeenCalled();
    expect(gates).toHaveLength(4);
    expect(gates.every((g) => g.currentCount === 0 && g.ofTotal === 0)).toBe(true);
  });

  it("交差テナントがあれば各ゲートの件数をSQL結果から組み立てる", async () => {
    // userSourceExistsForTable() は conversation_evaluations 側のクエリにも
    // `FROM chat_sessions cs` を含むEXISTSサブクエリを埋め込むため、
    // 単純な `FROM <table>` 一致では3クエリが区別できない
    // (このセッションで既に踏んだ罠。measurementHealth.test.ts と同じ流儀で
    //  各クエリに固有のFILTER/SELECT句をアンカーにする)。
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/message_count >= \$2\) AS ge_msg/.test(sql)) {
        return Promise.resolve({ rows: [{ total: "10", ge_msg: "6", ge_len: "8" }] });
      }
      if (/^\s*SELECT ce\.tenant_id, ce\.session_id/.test(sql)) {
        return Promise.resolve({
          rows: [
            { tenant_id: "carnation", session_id: "s1" },
            { tenant_id: "carnation", session_id: "s2" },
          ],
        });
      }
      if (/ce\.score >= \$2\) AS ge_score/.test(sql)) {
        return Promise.resolve({ rows: [{ total: "9", ge_score: "3" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const db = { query };
    const hasConvertingOutcome = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const gates = await computeSeriesGates(db as any, ["carnation"], seriesDeps({ hasConvertingOutcome }));

    const byGate = Object.fromEntries(gates.map((g) => [g.gate, g]));
    expect(byGate["message_count"]).toMatchObject({ currentCount: 6, ofTotal: 10 });
    expect(byGate["messages_length"]).toMatchObject({ currentCount: 8, ofTotal: 10 });
    expect(byGate["judge_score"]).toMatchObject({ currentCount: 3, ofTotal: 9 });
    expect(byGate["converting_outcome"]).toMatchObject({ currentCount: 1, ofTotal: 2 });
    expect(hasConvertingOutcome).toHaveBeenCalledWith("carnation", "s1");
    expect(hasConvertingOutcome).toHaveBeenCalledWith("carnation", "s2");
  });

  it("hasConvertingOutcomeの対象がサンプル上限に達したときはラベルにその旨を出す(禁止34: 母数を隠さない)", async () => {
    const LIMIT = 100;
    const capped = Array.from({ length: LIMIT }, (_, i) => ({ tenant_id: "carnation", session_id: `s${i}` }));
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/message_count >= \$2\) AS ge_msg/.test(sql)) return Promise.resolve({ rows: [{ total: "0", ge_msg: "0", ge_len: "0" }] });
      if (/^\s*SELECT ce\.tenant_id, ce\.session_id/.test(sql)) return Promise.resolve({ rows: capped });
      if (/ce\.score >= \$2\) AS ge_score/.test(sql)) return Promise.resolve({ rows: [{ total: "0", ge_score: "0" }] });
      return Promise.resolve({ rows: [] });
    });
    const db = { query };

    const gates = await computeSeriesGates(db as any, ["carnation"], seriesDeps());
    const gate = gates.find((g) => g.gate === "converting_outcome")!;
    expect(gate.ofTotal).toBe(LIMIT);
    expect(gate.label).toContain("サンプル");
  });

  it("壊れやすいポイント: hasConvertingOutcomeが1件で例外を投げても /measurement-health 全体を落とさず、その1件だけを分母から除外する", async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/message_count >= \$2\) AS ge_msg/.test(sql)) return Promise.resolve({ rows: [{ total: "0", ge_msg: "0", ge_len: "0" }] });
      if (/^\s*SELECT ce\.tenant_id, ce\.session_id/.test(sql)) {
        return Promise.resolve({
          rows: [
            { tenant_id: "carnation", session_id: "s1" },
            { tenant_id: "carnation", session_id: "s2" },
            { tenant_id: "carnation", session_id: "s3" },
          ],
        });
      }
      if (/ce\.score >= \$2\) AS ge_score/.test(sql)) return Promise.resolve({ rows: [{ total: "0", ge_score: "0" }] });
      return Promise.resolve({ rows: [] });
    });
    const db = { query };
    const hasConvertingOutcome = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(true);

    // 例外を投げても computeSeriesGates 自体は reject せず、正常に完走すること
    const gates = await computeSeriesGates(db as any, ["carnation"], seriesDeps({ hasConvertingOutcome }));

    const gate = gates.find((g) => g.gate === "converting_outcome")!;
    // s2は例外により分子・分母どちらからも除外される(2/3ではなく2/2。母数を偽らない)
    expect(gate.currentCount).toBe(2);
    expect(gate.ofTotal).toBe(2);
    expect(hasConvertingOutcome).toHaveBeenCalledTimes(3);
  });
});

describe("fetchIgnitionStatus — 交差テナントをcomputeSeriesGatesに渡す配線(ナレッジ配線是正P15)", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("交差するテナントのIDだけをseriesGates計算に渡す(交差しないテナントを含めない)", async () => {
    process.env["JUDGE_SWEEP_TENANTS"] = "carnation,other_tenant";
    process.env["LEARNED_MEMORY_ENABLED"] = "true";
    process.env["LEARNED_MEMORY_TENANTS"] = "carnation";
    // TENANTS = [carnation, r2c_default]。carnationのみ交差する
    // (sweep={carnation,other_tenant} ∩ write={carnation})。
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/SELECT id, features FROM tenants/.test(sql)) {
        return Promise.resolve({ rows: TENANTS });
      }
      return Promise.resolve({ rows: [] });
    });
    const db = { query };

    const result = await fetchIgnitionStatus(db as any);

    const messageCountCall = query.mock.calls.find(([sql]: [string]) =>
      /message_count >= \$2\) AS ge_msg/.test(sql),
    );
    expect(messageCountCall).toBeDefined();
    const [, params] = messageCountCall as [string, unknown[]];
    expect(params[0]).toEqual(["carnation"]);
    expect(result.seriesGates).toBeDefined();
    expect(result.seriesGates).toHaveLength(4);
  });

  it("交差テナントが1件も無ければDBに問い合わせず全ゲート0/0のseriesGatesを返す", async () => {
    process.env["JUDGE_SWEEP_TENANTS"] = "other_tenant";
    process.env["LEARNED_MEMORY_ENABLED"] = "true";
    process.env["LEARNED_MEMORY_TENANTS"] = "carnation";
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/SELECT id, features FROM tenants/.test(sql)) {
        return Promise.resolve({ rows: TENANTS });
      }
      return Promise.resolve({ rows: [] });
    });
    const db = { query };

    const result = await fetchIgnitionStatus(db as any);

    const gateQueryCalls = query.mock.calls.filter(([sql]: [string]) =>
      /message_count >= \$2\) AS ge_msg|ce\.score >= \$2\) AS ge_score/.test(sql),
    );
    expect(gateQueryCalls).toHaveLength(0);
    expect(result.seriesGates!.every((g) => g.currentCount === 0 && g.ofTotal === 0)).toBe(true);
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

  it("同意判定(hermes_raw_data_consent)は hermesConsent.ts の判定をそのまま使っている(H-1)", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*resolveLearningConsentFromFeatures[^}]*\}\s*from\s*".*hermesConsent"/s,
    );
  });
});
