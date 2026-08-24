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

// D2 / G5: 「チャットを開いたのに会話しなかった」割合。
// visitor_id の記録開始前は結合しようがないため、期間全体で率を出すと
// 「0%が話した」という誤った数字になる。母数の開始点を切る設計を固定する。
describe("fetchMeasurementHealth — chatOpenDropoff", () => {
  const BASE = [
    { rows: [] },                                              // sourceBreakdown
    { rows: [{ count: "0" }] },                                // empty
    { rows: [{ linked: "0", total: "0" }] },                   // cv
    { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] }, // outcome
    { rows: [{ count: "0" }] },                                // valid
  ];

  it("母数が閾値未満なら率を出さず null を返す(禁止34)", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: "2026-08-24T01:13:30Z", with_vid: "25", total: "39" }] },
      { rows: [{ opened: "10", conversed: "0" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.visitorsOpened).toBe(10);
    expect(r.chatOpenDropoff.dropoffRate).toBeNull();
    expect(r.chatOpenDropoff.trackingSince).toBe("2026-08-24T01:13:30Z");
  });

  it("母数が足りていれば率を出す", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "100", total: "100" }] },
      { rows: [{ opened: "100", conversed: "25" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.dropoffRate).toBe(75);
    expect(r.chatOpenDropoff.visitorsConversed).toBe(25);
  });

  it("visitor_id を持つセッションが1件も無ければ trackingSince は null(集計不能を明示)", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: null, with_vid: "0", total: "1103" }] },
      { rows: [{ opened: "0", conversed: "0" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.trackingSince).toBeNull();
    expect(r.chatOpenDropoff.dropoffRate).toBeNull();
    // この指標がどれだけ信頼できるかを別途示す
    expect(r.chatOpenDropoff.sessionCoverage).toEqual({ numerator: 0, denominator: 1103, rate: 0 });
  });

  it("visitor_id の付与率(sessionCoverage)を返す。低いほどこの指標は当てにならない", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: "2026-08-24T01:13:30Z", with_vid: "25", total: "39" }] },
      { rows: [{ opened: "5", conversed: "1" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.sessionCoverage.numerator).toBe(25);
    expect(r.chatOpenDropoff.sessionCoverage.denominator).toBe(39);
  });

  it("行が返らない異常時でも落ちず、数値を出さない", async () => {
    const db = makeDb([...BASE, { rows: [] }, { rows: [] }]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.trackingSince).toBeNull();
    expect(r.chatOpenDropoff.visitorsOpened).toBe(0);
    expect(r.chatOpenDropoff.dropoffRate).toBeNull();
  });
});
