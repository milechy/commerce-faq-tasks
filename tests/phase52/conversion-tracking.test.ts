// tests/phase52/conversion-tracking.test.ts
// Phase52f Phase B: GET /v1/admin/analytics/conversions のテスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
const mockPool = { query: (...args: any[]) => mockQuery(...args) };

jest.mock("../../src/lib/db", () => ({
  getPool: () => mockPool,
  pool: mockPool,
}));

jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { registerAnalyticsRoutes } from "../../src/api/admin/analytics/routes";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(role: Role = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerAnalyticsRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * conversions エンドポイントが実行する7クエリを順番にモックする:
 * 1. GROUP BY outcome (summaryResult - 計算後に total で上書きされる)
 * 2. COUNT(*) total
 * 3. COUNT where outcome IS NOT NULL (recorded)
 * 4. GROUP BY outcome WHERE outcome IS NOT NULL (outcomeBreakdown)
 * 5. DATE GROUP BY trend
 * 6. feedback × outcome (technique)
 * 7. state GROUP BY stage dropout
 */
function mockConversionsQueries({
  summaryRows = [] as any[],
  total = 0,
  recorded = 0,
  outcomeBreakdownRows = [] as any[],
  trendRows = [] as any[],
  techRows = [] as any[],
  stageRows = [] as any[],
} = {}) {
  // Reset the queue first so leftover mockResolvedValueOnce calls from previous tests don't bleed in.
  // jest.clearAllMocks() only clears call records, not the once-queue; mockReset() clears everything.
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: summaryRows })            // 1. summaryResult (GROUP BY outcome)
    .mockResolvedValueOnce({ rows: [{ total: String(total) }] })  // 2. totalCountResult
    .mockResolvedValueOnce({ rows: [{ recorded: String(recorded) }] }) // 3. recordedResult
    .mockResolvedValueOnce({ rows: outcomeBreakdownRows })   // 4. outcomeBreakdownResult
    .mockResolvedValueOnce({ rows: trendRows })              // 5. trendResult
    .mockResolvedValueOnce({ rows: techRows })               // 6. techResult (technique)
    .mockResolvedValueOnce({ rows: stageRows });             // 7. stageResult
}

// ---------------------------------------------------------------------------
// 1. summary が正しい集計値を返す
// ---------------------------------------------------------------------------
describe("1. summary — 正しい集計値", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversionsQueries({
      total: 100,
      recorded: 40,
      outcomeBreakdownRows: [
        { outcome: "購入完了", cnt: "20" },
        { outcome: "予約完了", cnt: "10" },
        { outcome: "離脱", cnt: "10" },
      ],
    });
  });

  it("200 + summary フィールドが正しく集計される", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(200);
    expect(res.body.summary.total_sessions).toBe(100);
    expect(res.body.summary.recorded_outcomes).toBe(40);
    expect(res.body.summary.recording_rate).toBe(40.0);
  });

  it("outcome breakdown が正しくマッピングされる", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(200);
    expect(res.body.summary.outcomes["購入完了"]).toBe(20);
    expect(res.body.summary.outcomes["予約完了"]).toBe(10);
    expect(res.body.summary.outcomes["離脱"]).toBe(10);
  });

  it("recording_rate が 0% でも crash しない (total=0)", async () => {
    mockConversionsQueries({ total: 0, recorded: 0 });
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(200);
    expect(res.body.summary.recording_rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. technique_effectiveness — feedback キーワード抽出 + outcome 紐付け
// ---------------------------------------------------------------------------
describe("2. technique_effectiveness — フィードバックからテクニック抽出", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversionsQueries({
      total: 10,
      recorded: 5,
      techRows: [
        { feedback: "アンカリングを活用した提案", outcome: "購入完了" },
        { feedback: "アンカリングが有効", outcome: "購入完了" },
        { feedback: "損失回避フレームを使用", outcome: "離脱" },
        { feedback: "アンカリングと社会的証明を組み合わせ", outcome: null },
      ],
    });
  });

  it("テクニックが正しく抽出されてソートされる", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(200);
    const te = res.body.technique_effectiveness as Array<any>;
    expect(te.length).toBeGreaterThan(0);

    const anchoring = te.find((t: any) => t.technique === "アンカリング");
    expect(anchoring).toBeDefined();
    expect(anchoring.sessions_used).toBe(3); // 3行でアンカリング含む
    expect(anchoring.converted).toBe(2);     // 購入完了 × 2 (離脱/nullは除外)
    expect(anchoring.conversion_rate).toBe(66.7); // 2/3 * 100 ≈ 66.7
  });

  it("離脱・不明は converted にカウントされない", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    const te = res.body.technique_effectiveness as Array<any>;
    const lossAversion = te.find((t: any) => t.technique === "損失回避");
    expect(lossAversion).toBeDefined();
    expect(lossAversion.sessions_used).toBe(1);
    expect(lossAversion.converted).toBe(0); // 離脱は除外
    expect(lossAversion.conversion_rate).toBe(0);
  });

  it("conversion_rate DESC でソートされる", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    const te = res.body.technique_effectiveness as Array<any>;
    for (let i = 1; i < te.length; i++) {
      expect(te[i - 1].conversion_rate).toBeGreaterThanOrEqual(te[i].conversion_rate);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. period=7d フィルタ — クエリパラメータが渡される
// ---------------------------------------------------------------------------
describe("3. period=7d — 7日以内のみ", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversionsQueries({ total: 5, recorded: 3 });
  });

  it("period=7d でも 200 を返す", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions?period=7d");

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
  });

  it("period=7d のとき SQL に '7 days' interval が渡される", async () => {
    await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions?period=7d");

    // 最初の query 呼び出し (summaryResult) のパラメータを検証
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[1]).toContain("7 days");
  });

  it("period=90d のとき SQL に '90 days' interval が渡される", async () => {
    mockConversionsQueries({ total: 50, recorded: 20 });

    await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions?period=90d");

    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[1]).toContain("90 days");
  });
});

// ---------------------------------------------------------------------------
// 4. conversion_rate_trend が正しくマッピングされる
// ---------------------------------------------------------------------------
describe("4. conversion_rate_trend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversionsQueries({
      total: 10,
      recorded: 5,
      trendRows: [
        { date: "2026-03-25", total: "10", converted: "4" },
        { date: "2026-03-26", total: "20", converted: "0" },
        { date: "2026-03-27", total: "0", converted: "0" },
      ],
    });
  });

  it("trend 配列の各要素に date / total / converted / rate が含まれる", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(200);
    const trend = res.body.conversion_rate_trend as Array<any>;
    expect(trend).toHaveLength(3);
    expect(trend[0]).toMatchObject({ date: "2026-03-25", total: 10, converted: 4, rate: 40.0 });
    expect(trend[1]).toMatchObject({ total: 20, converted: 0, rate: 0 });
    expect(trend[2]).toMatchObject({ total: 0, rate: 0 }); // ゼロ除算しない
  });
});

// ---------------------------------------------------------------------------
// 5. client_admin は自テナントのみ参照 (tenant_id が SQL に渡される)
// ---------------------------------------------------------------------------
describe("5. client_admin — テナント絞り込み", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversionsQueries({ total: 3, recorded: 1 });
  });

  it("client_admin のとき query params に tenantId が含まれる", async () => {
    await request(makeApp("client_admin", "tenant-x"))
      .get("/v1/admin/analytics/conversions");

    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[1]).toContain("tenant-x");
  });
});

// ---------------------------------------------------------------------------
// 6. stage_dropout が正しくマッピングされる
// ---------------------------------------------------------------------------
describe("6. stage_dropout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversionsQueries({
      total: 20,
      recorded: 8,
      stageRows: [
        { state: "clarify", cnt: "5" },
        { state: "answer", cnt: "3" },
      ],
    });
  });

  it("stage_dropout にステージ別離脱数が入る", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(200);
    expect(res.body.stage_dropout.clarify).toBe(5);
    expect(res.body.stage_dropout.answer).toBe(3);
    expect(res.body.stage_dropout.confirm).toBe(0); // デフォルト 0
    expect(res.body.stage_dropout.terminal).toBe(0);
  });
});
