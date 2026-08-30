// src/api/admin/avatar/premiumGenerationRoutes.test.ts

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
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

import { trackUsage } from "../../../lib/billing/usageTracker";
const mockTrackUsage = trackUsage as jest.Mock;

// costCalculatorはモックしない（実際のcost_total_cents計算を検証するため）
import { calculateBillingAmountCents } from "../../../lib/billing/costCalculator";

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

    // GID 1216944003337122: Magnific未実行時はfluxImageCountのみでcost_total_centsが
    // 意図額(PREMIUM_AVATAR_PRICE_CENTS デフォルト100セント=$1.00相当)になる
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.featureUsed).toBe("premium_avatar_generation");
    expect(call.fluxImageCount).toBe(1);
    expect(call.magnificUpscaleCount).toBe(0);
    expect(calculateBillingAmountCents(call)).toBe(100);
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

    // GID 1216944003337122: Magnific実行時はflux+magnific両方のコストが積み上がっても
    // marginOverrideの逆算により、意図額(PREMIUM_AVATAR_PRICE_CENTS デフォルト100セント)
    // ちょうどが計上される
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.fluxImageCount).toBe(1);
    expect(call.magnificUpscaleCount).toBe(1);
    expect(calculateBillingAmountCents(call)).toBe(100);
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

    // GID 1216944003337122: Magnificが失敗した回はmagnificUpscaleCount=0（課金しない）
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.magnificUpscaleCount).toBe(0);
    expect(calculateBillingAmountCents(call)).toBe(100);
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

// #P1-B: previewMode(super_adminのクライアントビュー)中に ?tenant= を無視して
// super_admin自身の(空の)テナントで課金・保存していた欠陥の回帰ガード。
// generate-image/match-voice/generate-prompt/fal/generateの4ルートは#674〜#676で
// 直したが、generate-premiumは当時スコープ外だった。
describe("POST /v1/admin/avatar/generate-premium — previewMode中のテナント解決", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAL_KEY = "test-fal-key";
    delete process.env.FREEPIK_API_KEY;
  });

  afterEach(() => {
    delete process.env.FAL_KEY;
  });

  it("super_admin + ?tenant=tenant-b → trackUsageがtenant-bで呼ばれる(プラン制限もバイパスされfal.aiに到達する)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => FAL_OK });

    const res = await request(makeApp("", "super_admin"))
      .post("/v1/admin/avatar/generate-premium?tenant=tenant-b")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
    // super_adminはプラン制限をバイパスするため、この呼び出しでmockQueryは
    // 一切呼ばれない(plan問い合わせ自体が発生しない)
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-b" }),
    );
  });

  it("[越権防止] client_adminが?tenant=tenant-bを付けても無視され、JWTの自テナントで計上される", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => FAL_OK });

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/generate-premium?tenant=tenant-b")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
  });

  it("super_adminが?tenant=を付けないとテナント不明で400になり、fal.ai/Magnificを一切呼ばない(課金発生前に落ちる証明)", async () => {
    const res = await request(makeApp("", "super_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpscale).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    // プラン制限チェックにも到達しない(400が先)
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("テナントが解決できれば400にならずプラン制限チェックまで到達する(過剰ブロックの対検証)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/generate-premium")
      .send({ prompt: VALID_PROMPT });

    // starterプランなので403(plan_upgrade_required)になるが、400(テナント不明)
    // ではないこと、かつプラン問い合わせ自体には到達していることを確認する
    expect(res.status).toBe(403);
    expect(mockQuery).toHaveBeenCalled();
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
