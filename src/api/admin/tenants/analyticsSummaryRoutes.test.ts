// src/api/admin/tenants/analyticsSummaryRoutes.test.ts
// テナント詳細「📉 アナリティクス」タブが常時500だった不具合の回帰テスト。
//
// chat_sessions の時刻列は started_at(chat-history/migration.sql)であり created_at は
// 存在しない。にもかかわらず created_at で絞っていたため、PostgreSQL が
// `column "created_at" does not exist` を返し、
// GET /v1/admin/tenants/:id/analytics-summary が常に500になっていた。
//
// 列名の誤りは型で防げない(SQLは文字列)ため、実際にDBへ渡るSQLそのものを検査する。

import express from "express";
import type { Express } from "express";
import request from "supertest";
import type { Pool } from "pg";
import { registerAnalyticsSummaryRoutes } from "./analyticsSummaryRoutes";

jest.mock("../../../lib/billing/posthogUsageTracker", () => ({
  getMonthlyLLMUsageFromPostHog: jest.fn().mockResolvedValue(null),
}));

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({ app_metadata: { role: "super_admin" } });

const mockQuery = jest.fn();
const db = { query: (...args: unknown[]) => mockQuery(...args) } as unknown as Pool;

/** 実行された全SQLを連結して返す（何本目かに依存せず検査する） */
function allSql(): string {
  return mockQuery.mock.calls.map((c) => String(c[0])).join("\n---\n");
}
/** chat_sessions を参照しているSQLだけを抜き出す */
function chatSessionSql(): string[] {
  return mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => /FROM\s+chat_sessions/.test(s));
}

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "development";
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  app = express();
  app.use(express.json());
  registerAnalyticsSummaryRoutes(app, db);
});

describe("GET /v1/admin/tenants/:id/analytics-summary", () => {
  it("200を返す（実在しない列を参照して500にならない）", async () => {
    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  it("chat_sessions は started_at で絞る（created_at は存在しない列）", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = chatSessionSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).toMatch(/started_at\s*>=/);
      // chat_sessions 側の絞り込みに created_at を使っていないこと。
      // (conversion_attributions の created_at は実在するので、chat_sessions のSQLだけを見る)
      expect(sql).not.toMatch(/AND\s+created_at\s*>=/);
    }
  });

  it("PR-3 (GID 1216970103691946): chat_sessions のクエリにsource='user'絞り込みが入っている", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = chatSessionSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).toContain("chat_sessions.metadata->>'source' = 'user'");
    }
  });

  it("全クエリが tenant_id で絞られる（テナント越境しない）", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(mockQuery.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).toMatch(/tenant_id\s*=\s*\$1/);
      expect(call[1]).toContain("carnation");
    }
  });

  it("DBが列不存在エラーを返しても500で止まり、生のSQLエラーを漏らさない", async () => {
    mockQuery.mockRejectedValue(new Error('column "created_at" does not exist'));

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("does not exist");
  });

  it("未知のperiodでも既定(30日)にフォールバックし、例外にならない", async () => {
    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=not_a_period")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(allSql()).toMatch(/FROM\s+chat_sessions/);
  });

  // 2引数の ROUND() は numeric 版しか存在しない。COUNT(*)/float の結果
  // (double precision)をそのまま渡すと `function round(double precision, integer)
  // does not exist` で落ちる。started_at の修正後に実際に踏んだ二段目の不具合。
  it("ROUND に渡す前に numeric へキャストする（double precision のままだと落ちる）", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = chatSessionSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      if (!/ROUND\s*\(/i.test(sql)) continue;
      // ROUND(...) の第1引数が ::numeric でキャストされていること
      expect(sql).toMatch(/ROUND\s*\([\s\S]*?::numeric\s*,\s*\d+\s*\)/i);
      // float を直接 ROUND に渡す形に戻っていないこと
      expect(sql).not.toMatch(/ROUND\s*\(\s*COUNT\(\*\)\s*\/[^,]*,\s*\d+\s*\)/i);
    }
  });
});
