// src/api/admin/analytics/metricsHistory.test.ts
// Phase72-D: GET /v1/admin/analytics/metrics-history テスト
// flowTransitions.test.ts の mock パターンを踏襲

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

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

// supabase auth middleware — x-role ヘッダで制御
jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    const role = (req.headers["x-role"] as string) ?? "super_admin";
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    req.supabaseUser = {
      app_metadata: {
        role,
        ...(tenantId ? { tenant_id: tenantId } : {}),
      },
    };
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

const ROUTE = "/v1/admin/analytics/metrics-history";

beforeEach(() => {
  mockQuery.mockClear();
});

// ---------------------------------------------------------------------------
// 認証ガード
// ---------------------------------------------------------------------------

describe("GET /v1/admin/analytics/metrics-history — 認証ガード", () => {
  it("viewer ロール → 403 AUTH_ROLE_INVALID", async () => {
    const app = makeApp();
    const res = await request(app).get(`${ROUTE}?metric=rajiuce_conversation_terminal_total`).set("x-role", "viewer");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "AUTH_ROLE_INVALID" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("client_admin → 403 AUTH_ROLE_INSUFFICIENT（super_admin 専用）", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total`)
      .set("x-role", "client_admin")
      .set("x-tenant-id", "tenant-a");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "AUTH_ROLE_INSUFFICIENT" });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

describe("GET /v1/admin/analytics/metrics-history — バリデーション", () => {
  it("metric 未指定 → 400", async () => {
    const app = makeApp();
    const res = await request(app).get(ROUTE).set("x-role", "super_admin");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metric/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("不正な period → 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total&period=999d`)
      .set("x-role", "super_admin");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/period/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("不正な granularity → 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total&granularity=3h`)
      .set("x-role", "super_admin");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/granularity/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe("GET /v1/admin/analytics/metrics-history — 正常系", () => {
  it("DATE_TRUNC バケット集計: series が返る", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          bucket: new Date("2026-06-14T10:00:00Z"),
          value: 5.0,
          labels: { reason: "completed", tenantId: "t1" },
        },
        {
          bucket: new Date("2026-06-14T11:00:00Z"),
          value: 3.0,
          labels: { reason: "completed", tenantId: "t1" },
        },
      ],
    });

    const app = makeApp();
    const res = await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total&period=7d&granularity=1h`)
      .set("x-role", "super_admin");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      metric: "rajiuce_conversation_terminal_total",
      period: "7d",
      granularity: "1h",
    });
    expect(Array.isArray(res.body.series)).toBe(true);
    expect(res.body.series).toHaveLength(2);
    expect(res.body.series[0]).toMatchObject({ value: 5, labels: { reason: "completed" } });
    expect(typeof res.body.series[0].timestamp).toBe("string");
  });

  it("DB が空のとき series:[] を返す（null 禁止）", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const app = makeApp();
    const res = await request(app)
      .get(`${ROUTE}?metric=rajiuce_loop_detected_total&period=1d`)
      .set("x-role", "super_admin");

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual([]);
    // series が null でないことを確認
    expect(res.body.series).not.toBeNull();
  });

  it("tenant_id クエリを渡すと DB クエリに含まれる", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const app = makeApp();
    await request(app)
      .get(`${ROUTE}?metric=rajiuce_avatar_requests_total&tenant_id=tenant-x`)
      .set("x-role", "super_admin");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(callArgs[1]).toContain("tenant-x");
  });

  it("デフォルト period=7d / granularity=1h が適用される", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const app = makeApp();
    const res = await request(app)
      .get(`${ROUTE}?metric=rajiuce_rag_duration_ms`)
      .set("x-role", "super_admin");

    expect(res.status).toBe(200);
    expect(res.body.period).toBe("7d");
    expect(res.body.granularity).toBe("1h");
  });

  // granularity 別の SQL バケット式検証（P1-1 regression guard）
  it("granularity=1h のとき DATE_TRUNC('hour', ...) が SQL に使われる", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total&granularity=1h`)
      .set("x-role", "super_admin");

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DATE_TRUNC\('hour'/i);
    expect(sql).not.toMatch(/DATE_BIN/i);
  });

  it("granularity=6h のとき DATE_BIN('6 hours', ...) が SQL に使われる（PG16対応）", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total&granularity=6h`)
      .set("x-role", "super_admin");

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DATE_BIN/i);
    expect(sql).toMatch(/6 hours/i);
    // DATE_TRUNC の不正な使い方になっていないこと
    expect(sql).not.toMatch(/DATE_TRUNC\('6 hours'/i);
  });

  it("granularity=24h のとき DATE_TRUNC('day', ...) が SQL に使われる", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .get(`${ROUTE}?metric=rajiuce_conversation_terminal_total&granularity=24h`)
      .set("x-role", "super_admin");

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DATE_TRUNC\('day'/i);
    expect(sql).not.toMatch(/DATE_BIN/i);
  });
});
