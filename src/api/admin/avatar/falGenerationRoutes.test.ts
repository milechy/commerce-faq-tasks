// src/api/admin/avatar/falGenerationRoutes.test.ts

import express from "express";
import request from "supertest";
import { registerFalGenerationRoutes } from "./falGenerationRoutes";

// ── モック ────────────────────────────────────────────────────────────────────

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null, // ストレージ無効（imageUrlをそのまま返す）
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function makeApp(tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId } };
    req.requestId = "req-test-001";
    next();
  });
  registerFalGenerationRoutes(app);
  return app;
}

const FAL_OK_RESPONSE = {
  images: [
    { url: "https://fal.run/storage/img1.jpg", width: 768, height: 1024 },
    { url: "https://fal.run/storage/img2.jpg", width: 768, height: 1024 },
    { url: "https://fal.run/storage/img3.jpg", width: 768, height: 1024 },
    { url: "https://fal.run/storage/img4.jpg", width: 768, height: 1024 },
  ],
  seed: 42,
};

// ── テスト ────────────────────────────────────────────────────────────────────

describe("POST /v1/admin/avatar/fal/generate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAL_KEY = "test-fal-key";
  });

  afterEach(() => {
    delete process.env.FAL_KEY;
  });

  it("正常系: 4枚の画像URLを返す", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK_RESPONSE,
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling", numImages: 4 });

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(4);
    expect(res.body.seed).toBe(42);
  });

  it("バリデーションエラー: promptが短すぎる", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "hi" }); // 10文字未満

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("認証エラー: FAL_KEY未設定", async () => {
    delete process.env.FAL_KEY;

    const res = await request(makeApp())
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a woman, bust shot, studio background" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("FAL_KEY");
  });

  it("fal.ai APIエラー時に502を返す", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese man, bust shot, business suit" });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("画像生成サービス");
  });

  it("numImagesのデフォルト値は4", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK_RESPONSE,
    });

    await request(makeApp())
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling" });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.num_images).toBe(4);
  });
});
