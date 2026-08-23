// tests/phase-a/eventIdDedupe.test.ts
import { recordAndDedupe } from "../../src/lib/posthog/eventIdDedupe";

// conversion_attributions.event_id は UUID 型なので、実スキーマに近い形の
// テストデータにする(evt-001 のような非UUID文字列は本番のINSERTで必ず失敗する)。
const UUID_1 = "11111111-1111-1111-1111-111111111111";
const UUID_2 = "22222222-2222-2222-2222-222222222222";
const UUID_3 = "33333333-3333-3333-3333-333333333333";
const UUID_4 = "44444444-4444-4444-4444-444444444444";
const UUID_ERR = "55555555-5555-5555-5555-555555555555";

function makeMockDb(insertOk: boolean, countValue: number) {
  let callCount = 0;
  const query = jest.fn().mockImplementation(() => {
    const i = callCount++;
    if (i === 0) {
      if (!insertOk) return Promise.reject(new Error("db error"));
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (i === 1) {
      return Promise.resolve({ rows: [{ cnt: String(countValue) }], rowCount: 1 });
    }
    // UPDATE rank
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
  return { query } as any;
}

describe("recordAndDedupe", () => {
  it("returns isDuplicate=false and rank=C for first occurrence (1 source)", async () => {
    const db = makeMockDb(true, 1);
    const result = await recordAndDedupe({
      eventId: UUID_1,
      tenantId: "t1",
      source: "r2c_db",
      conversionType: "purchase",
    }, db);
    expect(result.isDuplicate).toBe(false);
    expect(result.rank).toBe("C");
    expect(result.sourceCount).toBe(1);
  });

  it("returns isDuplicate=true and rank=B for 2 sources", async () => {
    const db = makeMockDb(true, 2);
    const result = await recordAndDedupe({
      eventId: UUID_2,
      tenantId: "t1",
      source: "ga4",
      conversionType: "other",
    }, db);
    expect(result.isDuplicate).toBe(true);
    expect(result.rank).toBe("B");
    expect(result.sourceCount).toBe(2);
  });

  it("returns isDuplicate=true and rank=A for 3 sources", async () => {
    const db = makeMockDb(true, 3);
    const result = await recordAndDedupe({
      eventId: UUID_3,
      tenantId: "t1",
      source: "posthog",
      conversionType: "inquiry",
    }, db);
    expect(result.isDuplicate).toBe(true);
    expect(result.rank).toBe("A");
    expect(result.sourceCount).toBe(3);
  });

  it("returns rank=D for negative conversion value (疑義あり)", async () => {
    const db = makeMockDb(true, 1);
    const result = await recordAndDedupe({
      eventId: UUID_4,
      tenantId: "t1",
      source: "r2c_db",
      conversionType: "purchase",
      conversionValue: -100,
    }, db);
    expect(result.rank).toBe("D");
  });

  it("returns safe fallback on DB error (non-blocking)", async () => {
    const db = makeMockDb(false, 1);
    const result = await recordAndDedupe({
      eventId: UUID_ERR,
      tenantId: "t1",
      source: "r2c_db",
      conversionType: "purchase",
    }, db);
    expect(result.isDuplicate).toBe(false);
    expect(result.rank).toBe("C");
  });

  // 本番で INSERT が常に失敗していた不具合の回帰テスト:
  // (1) 存在しない metadata 列を参照しない (2) conversion_type を必ず渡す
  // (NOT NULL CHECK 制約があり省略すると INSERT が失敗する)
  it("INSERT文が実スキーマに存在する列のみを参照する(metadata列を参照しない・conversion_typeを含む)", async () => {
    const db = makeMockDb(true, 1);
    await recordAndDedupe({
      eventId: UUID_1,
      tenantId: "t1",
      source: "r2c_db",
      conversionType: "signup",
    }, db);

    const [insertSql, insertArgs] = db.query.mock.calls[0];
    expect(insertSql).toContain("conversion_type");
    expect(insertSql).not.toContain("metadata");
    expect(insertArgs).toEqual([
      UUID_1,
      "t1",
      "r2c_db",
      "macro",
      "signup",
      null,
    ]);
  });
});
