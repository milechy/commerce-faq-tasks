// src/api/admin/analytics/measurementHealth.test.ts
// GID 1216970103691946 (PR-7): 計測ヘルス5指標の集計ロジックとCLAUDE.md禁止34
// (母数不足時に0や矢印を出さない)の検証。

jest.mock("../chat-history/chatHistoryRepository", () => ({
  AUTO_OUTCOME_RECORDED_BY: "system:cv_bridge",
}));

import { fetchMeasurementHealth } from "./measurementHealth";

function makeDb(responses: Array<{ rows: any[] }>) {
  let i = 0;
  const query = jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [] }));
  return { query };
}

describe("fetchMeasurementHealth", () => {
  it("5指標すべてを正しく集計する", async () => {
    const db = makeDb([
      { rows: [{ source: "e2e", count: "407" }, { source: "(null)", count: "598" }, { source: "user", count: "13" }] },
      { rows: [{ count: "320" }] }, // empty sessions
      { rows: [{ linked: "0", total: "858" }] }, // CV link
      { rows: [{ recorded: "1", auto_recorded: "0", total: "1041" }] }, // outcome
      { rows: [{ count: "13" }] }, // valid user sessions
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.sourceBreakdown).toEqual([
      { source: "e2e", count: 407 },
      { source: "(null)", count: 598 },
      { source: "user", count: 13 },
    ]);
    expect(result.emptySessionCount).toBe(320);
    expect(result.cvSessionLinkRate).toEqual({ numerator: 0, denominator: 858, rate: 0 });
    expect(result.outcomeRecordRate).toEqual({ numerator: 1, denominator: 1041, rate: 0.1, autoRecorded: 0 });
    expect(result.validUserSessionCount).toBe(13);
  });

  it("母数0のとき rate は 0 ではなく null を返す(CLAUDE.md 禁止34)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.cvSessionLinkRate.rate).toBeNull();
    expect(result.outcomeRecordRate.rate).toBeNull();
  });

  it("tenantId指定時は全クエリにtenant_id絞り込みが入る", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    await fetchMeasurementHealth(db, "tenant-a", "30d");

    for (const call of db.query.mock.calls) {
      const [sql, params] = call as [string, unknown[]];
      expect(sql).toMatch(/tenant_id = \$2/);
      expect(params).toEqual(["30 days", "tenant-a"]);
    }
  });

  it("outcome記録率・実ユーザー有効セッション数のクエリはsource='user'絞り込みが入る(e2eを含めない)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    await fetchMeasurementHealth(db, null, "30d");

    const [outcomeSql] = db.query.mock.calls[3] as [string, unknown[]];
    const [validSql] = db.query.mock.calls[4] as [string, unknown[]];
    expect(outcomeSql).toContain("metadata->>'source' = 'user'");
    expect(validSql).toContain("metadata->>'source' = 'user'");
  });

  it("自動記録件数(auto_recorded)は outcome_recorded_by = AUTO_OUTCOME_RECORDED_BY で数える", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "5", auto_recorded: "3", total: "10" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    const [outcomeSql] = db.query.mock.calls[3] as [string, unknown[]];
    expect(outcomeSql).toContain("system:cv_bridge");
    expect(result.outcomeRecordRate.autoRecorded).toBe(3);
  });

  it("source列がnull(metadata.source未設定)のセッションは'(null)'という文字列で集計される(実データの文字列'null'と区別)", async () => {
    const db = makeDb([
      { rows: [{ source: "(null)", count: "598" }] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.sourceBreakdown[0]!.source).toBe("(null)");
  });
});
