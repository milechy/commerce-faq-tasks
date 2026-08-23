// src/api/admin/monitoring/computeKpis.test.ts
// PR-3 (GID 1216970103691946): KPI監視ダッシュボードの3クエリ全てに
// source='user'絞り込みが入っていることの検証。

import { computeKpis } from "./routes";

function makeDb(responses: Array<{ rows: any[] }>) {
  let i = 0;
  const query = jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [] }));
  return { query };
}

describe("computeKpis — source='user'フィルタ", () => {
  it("総セッション数・完了セッション数・フォールバック検出の3クエリ全てにsource='user'絞り込みが入っている", async () => {
    const db = makeDb([
      { rows: [{ total: "10" }] },
      { rows: [{ completed: "8" }] },
      { rows: [{ fallback_count: "1" }] },
    ]);

    await computeKpis(db, null);

    expect(db.query).toHaveBeenCalledTimes(3);
    for (const call of db.query.mock.calls) {
      const [sql] = call as [string, unknown[]];
      expect(sql).toContain("metadata->>'source' = 'user'");
    }
  });

  it("total=0のときは早期returnし、完了/フォールバッククエリは発行しない", async () => {
    const db = makeDb([{ rows: [{ total: "0" }] }]);

    const result = await computeKpis(db, null);

    expect(result).toEqual({ completionRate: 100, fallbackRate: 0, totalSessions: 0 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
