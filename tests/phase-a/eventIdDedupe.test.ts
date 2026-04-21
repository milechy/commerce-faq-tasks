// tests/phase-a/eventIdDedupe.test.ts
import { recordAndDedupe } from "../../src/lib/posthog/eventIdDedupe";

function makeMockDb(insertOk: boolean, countValue: number) {
  let callCount = 0;
  return {
    query: jest.fn().mockImplementation(() => {
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
    }),
  } as any;
}

describe("recordAndDedupe", () => {
  it("returns isDuplicate=false and rank=C for first occurrence (1 source)", async () => {
    const db = makeMockDb(true, 1);
    const result = await recordAndDedupe({
      eventId: "evt-001",
      tenantId: "t1",
      source: "r2c_db",
    }, db);
    expect(result.isDuplicate).toBe(false);
    expect(result.rank).toBe("C");
    expect(result.sourceCount).toBe(1);
  });

  it("returns isDuplicate=true and rank=B for 2 sources", async () => {
    const db = makeMockDb(true, 2);
    const result = await recordAndDedupe({
      eventId: "evt-002",
      tenantId: "t1",
      source: "ga4",
    }, db);
    expect(result.isDuplicate).toBe(true);
    expect(result.rank).toBe("B");
    expect(result.sourceCount).toBe(2);
  });

  it("returns isDuplicate=true and rank=A for 3 sources", async () => {
    const db = makeMockDb(true, 3);
    const result = await recordAndDedupe({
      eventId: "evt-003",
      tenantId: "t1",
      source: "posthog",
    }, db);
    expect(result.isDuplicate).toBe(true);
    expect(result.rank).toBe("A");
    expect(result.sourceCount).toBe(3);
  });

  it("returns rank=D for negative conversion value (疑義あり)", async () => {
    const db = makeMockDb(true, 1);
    const result = await recordAndDedupe({
      eventId: "evt-004",
      tenantId: "t1",
      source: "r2c_db",
      conversionValue: -100,
    }, db);
    expect(result.rank).toBe("D");
  });

  it("returns safe fallback on DB error (non-blocking)", async () => {
    const db = makeMockDb(false, 1);
    const result = await recordAndDedupe({
      eventId: "evt-err",
      tenantId: "t1",
      source: "r2c_db",
    }, db);
    expect(result.isDuplicate).toBe(false);
    expect(result.rank).toBe("C");
  });
});
