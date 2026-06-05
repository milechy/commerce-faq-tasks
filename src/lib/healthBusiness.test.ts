// src/lib/healthBusiness.test.ts

import type { Request, Response } from "express";
import { buildWarnings } from "./healthBusiness";

// ---------------------------------------------------------------------------
// buildWarnings — 各 warning 条件のユニットテスト
// ---------------------------------------------------------------------------

describe("buildWarnings", () => {
  const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30分前
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7時間前

  it("no warnings when all metrics are healthy", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 100,
      chat_messages_7d: 700, // avg = 100
      cv_events_24h: 5,
      rag_searches_24h: 50,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings).toHaveLength(0);
  });

  it("warns when chat_messages_24h is below 50% of 7-day average", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 20,  // avg = 100, 20 < 50
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 50,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings.some((w) => w.includes("chat_messages_24h dropped") && w.includes("7-day average"))).toBe(true);
  });

  it("does NOT warn when chat_messages_24h is exactly 50% of 7-day average", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 50,  // avg = 100, 50 = 50% (not < 50%)
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 50,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings.some((w) => w.includes("chat_messages_24h dropped"))).toBe(false);
  });

  it("does NOT warn about 7-day avg when 7d total is 0", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 0,
      chat_messages_7d: 0,
      cv_events_24h: 0,
      rag_searches_24h: 10,
      tenants_active_24h: [],
    });
    expect(warnings.some((w) => w.includes("7-day average"))).toBe(false);
  });

  it("warns when last_chat_message_at is null AND chat_messages_7d > 0 (traffic existed)", () => {
    const warnings = buildWarnings({
      last_chat_message_at: null,
      chat_messages_24h: 0,
      chat_messages_7d: 700,
      cv_events_24h: 0,
      rag_searches_24h: 10,
      tenants_active_24h: [],
    });
    expect(warnings.some((w) => w.includes("last_chat_message_at is null"))).toBe(true);
  });

  it("does NOT warn when last_chat_message_at is null AND chat_messages_7d is 0 (fresh DB)", () => {
    const warnings = buildWarnings({
      last_chat_message_at: null,
      chat_messages_24h: 0,
      chat_messages_7d: 0,
      cv_events_24h: 0,
      rag_searches_24h: 0,
      tenants_active_24h: [],
    });
    expect(warnings.some((w) => w.includes("last_chat_message_at is null"))).toBe(false);
  });

  it("warns when last_chat_message_at is older than 6 hours", () => {
    const warnings = buildWarnings({
      last_chat_message_at: old,
      chat_messages_24h: 100,
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 50,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings.some((w) => w.includes("older than 6 hours"))).toBe(true);
  });

  it("does NOT warn when last_chat_message_at is within 6 hours", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 100,
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 50,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings.some((w) => w.includes("older than 6 hours"))).toBe(false);
  });

  it("emits CRITICAL warning when rag_searches_24h is 0", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 100,
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 0,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings.some((w) => w.includes("CRITICAL") && w.includes("rag_searches_24h is 0"))).toBe(true);
  });

  it("does NOT emit CRITICAL when rag_searches_24h is 0 AND chat_messages_24h is 0 (no activity)", () => {
    const warnings = buildWarnings({
      last_chat_message_at: null,
      chat_messages_24h: 0,
      chat_messages_7d: 0,
      cv_events_24h: 0,
      rag_searches_24h: 0,
      tenants_active_24h: [],
    });
    expect(warnings.some((w) => w.includes("CRITICAL"))).toBe(false);
  });

  it("does NOT emit CRITICAL warning when rag_searches_24h > 0", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 100,
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 1,
      tenants_active_24h: ["carnation"],
    });
    expect(warnings.some((w) => w.includes("CRITICAL"))).toBe(false);
  });

  it("can fire all three warnings simultaneously", () => {
    const warnings = buildWarnings({
      last_chat_message_at: old,
      chat_messages_24h: 5,   // avg = 100, 5 < 50
      chat_messages_7d: 700,
      cv_events_24h: 0,
      rag_searches_24h: 0,
      tenants_active_24h: [],
    });
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some((w) => w.includes("chat_messages_24h dropped"))).toBe(true);
    expect(warnings.some((w) => w.includes("older than 6 hours"))).toBe(true);
    expect(warnings.some((w) => w.includes("CRITICAL"))).toBe(true);
  });

  it("drop percentage is rounded correctly", () => {
    const warnings = buildWarnings({
      last_chat_message_at: recent,
      chat_messages_24h: 10,   // avg = 100, drop = 90%
      chat_messages_7d: 700,
      cv_events_24h: 5,
      rag_searches_24h: 50,
      tenants_active_24h: ["carnation"],
    });
    const dropWarn = warnings.find((w) => w.includes("chat_messages_24h dropped"));
    expect(dropWarn).toContain("90%");
  });
});

// ---------------------------------------------------------------------------
// businessHealthHandler 統合テスト — DB モックで response 構造を確認
// ---------------------------------------------------------------------------

describe("businessHealthHandler", () => {
  // pool をモック
  jest.mock("./db", () => ({
    pool: {
      query: jest.fn(),
    },
  }));

  beforeEach(() => {
    jest.resetModules();
  });

  function makeRes() {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    return res;
  }

  it("returns 200 with correct shape when DB mock returns data", async () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const { pool: mockPool } = jest.requireMock("./db") as { pool: { query: jest.Mock } };
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ cnt: "142", last_at: recent }] })  // chat_messages 24h
      .mockResolvedValueOnce({ rows: [{ cnt: "994" }] })                   // chat_messages 7d
      .mockResolvedValueOnce({ rows: [{ cnt: "8" }] })                     // conversion_attributions 24h
      .mockResolvedValueOnce({ rows: [{ cnt: "89" }] })                    // rag_searches 24h
      .mockResolvedValueOnce({ rows: [{ tenant_id: "carnation" }, { tenant_id: "r2c_default" }] }); // tenants

    const { businessHealthHandler: handler } = await import("./healthBusiness");

    const req = {} as Request;
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toMatchObject({
      chat_messages_24h: 142,
      cv_events_24h: 8,
      rag_searches_24h: 89,
      tenants_active_24h: ["carnation", "r2c_default"],
    });
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("returns 200 with warnings=[] when all metrics are healthy", async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10分前

    const { pool: mockPool } = jest.requireMock("./db") as { pool: { query: jest.Mock } };
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ cnt: "100", last_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "700" }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "5" }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "50" }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: "carnation" }] });

    const { businessHealthHandler: handler } = await import("./healthBusiness");
    const req = {} as Request;
    const res = makeRes();

    await handler(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.warnings).toHaveLength(0);
  });

  it("returns warnings when rag_searches_24h is 0", async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { pool: mockPool } = jest.requireMock("./db") as { pool: { query: jest.Mock } };
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ cnt: "100", last_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "700" }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "5" }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "0" }] })   // rag = 0 → CRITICAL
      .mockResolvedValueOnce({ rows: [{ tenant_id: "carnation" }] });

    const { businessHealthHandler: handler } = await import("./healthBusiness");
    const req = {} as Request;
    const res = makeRes();

    await handler(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.warnings.some((w: string) => w.includes("CRITICAL"))).toBe(true);
  });

  it("returns 500 when DB throws", async () => {
    const { pool: mockPool } = jest.requireMock("./db") as { pool: { query: jest.Mock } };
    mockPool.query.mockRejectedValue(new Error("DB connection refused"));

    const { businessHealthHandler: handler } = await import("./healthBusiness");
    const req = {} as Request;
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toBe("internal_error");
  });
});
