// src/api/admin/avatar/premiumGenerationRoutes.test.ts

import express from "express";
import request from "supertest";
import { registerPremiumGenerationRoutes } from "./premiumGenerationRoutes";

// ── モック ────────────────────────────────────────────────────────────────────

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null, // Storage無効（URLをそのまま返す）
}));

jest.mock("../../../lib/billing/usageTracker", () => ({
  trackUsage: jest.fn(),
}));

jest.mock("../../../lib/magnific", () => ({
  upscaleWithMagnific: jest.fn(),
}));

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { upscaleWithMagnific } from "../../../lib/magnific";
const mockUpscale = upscaleWithMagnific as jest.Mock;

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function makeApp(tenantId = "tenant-a", role: "client_admin" | "super_admin" = "client_admin") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    req.requestId = "req-premium-001";
    next();
  });
  registerPremiumGenerationRoutes(app);
  return app;
}

const FAL_OK = {
  images: [{ url: "https://fal.run/storage/premium1.jpg" }],
  seed: 99,
};

const VALID_PROMPT = "Professional portrait of a Japanese woman in business suit, bust shot, smile, office background";

// ── テスト ────────────────────────────────────────────────────────────────────

describe("POST /v1/admin/avatar/generate-premium", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAL_KEY = "test-fal-key";
    delete process.env.FREEPIK_API_KEY;
    // デフォルトはgrowthプラン（プラン制限に無関係な既存テストを壊さないため）。
    // プラン制限そのものをテストするケースはmockResolvedValueOnceで上書きする。
    mockQuery.mockResolvedValue({ rows: [{ plan: "growth" }] });
  });

  afterEach(() => {
    delete process.env.FAL_KEY;
    delete process.env.FREEPIK_API_KEY;
  });

  it("正常系（Magnific未設定）: fal.aiのURLをそのまま返す", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK,
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeTruthy();
    expect(res.body.originalUrl).toBeTruthy();
    expect(res.body.enhancedUrl).toBeTruthy();
    // Magnificスキップ時はoriginal === enhanced
    expect(res.body.originalUrl).toBe(res.body.enhancedUrl);
    expect(mockUpscale).not.toHaveBeenCalled();
  });

  it("正常系（Magnific設定済み）: アップスケール結果を返す", async () => {
    process.env.FREEPIK_API_KEY = "test-freepik-key";

    const ENHANCED_BASE64 = "aGVsbG8=";

    // fal.ai呼び出し
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => FAL_OK,
      })
      // fal.ai画像ダウンロード（base64変換用）
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from("fake-image-data"),
      });

    mockUpscale.mockResolvedValueOnce({
      imageBase64: ENHANCED_BASE64,
      taskId: "task-xyz",
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
    expect(mockUpscale).toHaveBeenCalledTimes(1);
    expect(mockUpscale).toHaveBeenCalledWith(
      expect.objectContaining({ scaleFactor: 2, style: "portrait" })
    );
  });

  it("Magnificエラー時はoriginalUrlにフォールバック", async () => {
    process.env.FREEPIK_API_KEY = "test-freepik-key";

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => FAL_OK })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from("fake-image-data"),
      });

    mockUpscale.mockRejectedValueOnce(new Error("Magnific timeout"));

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    // Magnificがエラーでも200でoriginalを返す
    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeTruthy();
  });

  it("バリデーションエラー: prompt短すぎ", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("FAL_KEY未設定で500", async () => {
    delete process.env.FAL_KEY;

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("FAL_KEY");
  });

  it("fal.ai APIエラーで502", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("画像生成サービス");
  });

  it("fal.aiが空レスポンスで502", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ images: [] }),
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("画像が生成されませんでした");
  });

  it("レスポンスに imageUrl / originalUrl / enhancedUrl が含まれる", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK,
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("imageUrl");
    expect(res.body).toHaveProperty("originalUrl");
    expect(res.body).toHaveProperty("enhancedUrl");
  });
});

// GID 1216944249525907: LP料金表(Growth〜: プレミアムアバター生成)に基づくプラン制限の回帰テスト
describe("POST /v1/admin/avatar/generate-premium — プラン制限", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAL_KEY = "test-fal-key";
    delete process.env.FREEPIK_API_KEY;
  });

  afterEach(() => {
    delete process.env.FAL_KEY;
    delete process.env.FREEPIK_API_KEY;
  });

  it("starterプランは403(plan_upgrade_required)で拒否され、FAL APIも呼ばれない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("growthプランは生成できる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => FAL_OK });

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
  });

  it("enterpriseプランは生成できる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => FAL_OK });

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
  });

  it("plan取得失敗時はfail-safeでstarter扱いとなり403", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("super_adminはプラン(starter)に関わらずバイパスできる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => FAL_OK });

    const res = await request(makeApp("tenant-a", "super_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
    // super_adminはプラン照会をバイパスするため、queryTenantPlan自体を呼ばない
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
