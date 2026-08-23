// src/api/admin/analytics/trafficSourceFilter.test.ts
// GID 1216970103691946: 集計クエリが chat_sessions.metadata.source='user' 以外を
// 除外していることの検証(summary / trends / evaluations / conversions)。
//
// SQLの実行結果ではなく、pool.query() に渡された「SQLテキストに絞り込み条件が
// 含まれているか」を検証する(cvAggregation.test.ts と同じモック手法)。

import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../../lib/notifications", () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    // super_admin にして plan ゲートのクエリを発生させない(assert対象を絞るため)
    req.supabaseUser = { app_metadata: { role: "super_admin" } };
    next();
  },
}));

import { registerAnalyticsRoutes } from "./routes";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

const USER_SOURCE_SQL = "metadata->>'source' = 'user'";

beforeEach(() => {
  mockQuery.mockReset();
  // どのクエリにも安全に応答できる汎用モック(件数0・平均null等)
  mockQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
});

describe("GET /v1/admin/analytics/summary — source='user'フィルタ", () => {
  it("chat_sessions・conversation_evaluations・conversion_attributions のクエリ全てにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/summary");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sessionQueries = allSql.filter((sql) => /FROM chat_sessions/.test(sql) && !/tenants t/.test(sql));
    expect(sessionQueries.length).toBeGreaterThan(0);
    for (const sql of sessionQueries) {
      expect(sql).toContain(USER_SOURCE_SQL);
    }

    const evalQuery = allSql.find((sql) => /FROM conversation_evaluations/.test(sql));
    expect(evalQuery).toBeDefined();
    expect(evalQuery).toContain(USER_SOURCE_SQL);

    const cvQuery = allSql.find((sql) => /FROM conversion_attributions/.test(sql));
    expect(cvQuery).toBeDefined();
    expect(cvQuery).toContain(USER_SOURCE_SQL);
    // session_id が無いイベントは誤って除外しない(既存の紐付けできないデータの後方互換)
    expect(cvQuery).toContain("session_id IS NULL");
  });
});

describe("GET /v1/admin/analytics/trends — source='user'フィルタ", () => {
  it("セッション数・Judgeスコア推移のサブクエリにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/trends");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const trendSql = allSql.find((sql) => /generate_series/.test(sql));
    expect(trendSql).toBeDefined();
    expect(trendSql).toContain(USER_SOURCE_SQL);
  });
});

describe("GET /v1/admin/analytics/evaluations — source='user'フィルタ", () => {
  it("スコア分布・軸平均・低スコアセッション一覧の3クエリ全てにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/evaluations");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const evalQueries = allSql.filter((sql) => /FROM conversation_evaluations/.test(sql));
    expect(evalQueries.length).toBe(3);
    for (const sql of evalQueries) {
      expect(sql).toContain(USER_SOURCE_SQL);
    }
  });
});

describe("GET /v1/admin/analytics/conversions — source='user'フィルタ", () => {
  it("chat_sessions直接参照クエリ全てにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/conversions");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sessionQueries = allSql.filter((sql) => /chat_sessions/.test(sql));
    expect(sessionQueries.length).toBeGreaterThan(0);
    for (const sql of sessionQueries) {
      expect(sql).toContain(USER_SOURCE_SQL);
    }
  });
});

describe("GET /v1/admin/analytics/cv-status — source='user'フィルタ (PR-3)", () => {
  it("conversion_attributions のCVカウントにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/cv-status");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const caQuery = allSql.find((sql) => /FROM conversion_attributions/.test(sql));
    expect(caQuery).toBeDefined();
    expect(caQuery).toContain(USER_SOURCE_SQL);
  });
});

describe("GET /v1/admin/analytics/knowledge-attribution — source='user'フィルタ (PR-3)", () => {
  it("current_period・previous_period 両方のCTEにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get(
      "/v1/admin/analytics/knowledge-attribution?tenant_id=carnation",
    );
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const kaQuery = allSql.find((sql) => /current_period AS/.test(sql));
    expect(kaQuery).toBeDefined();
    // current_period・previous_period 両方のCTEに絞り込みが入っている(2箇所)ことを確認
    expect(kaQuery!.split(USER_SOURCE_SQL).length - 1).toBe(2);
  });
});
