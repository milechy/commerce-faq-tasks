// src/api/admin/avatar/falGenerationRoutes.test.ts

import express from "express";
import request from "supertest";
import { registerFalGenerationRoutes } from "./falGenerationRoutes";

// ── モック ────────────────────────────────────────────────────────────────────

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

// 既定は null（＝ストレージ無効。imageUrlをそのまま返す）。
// 保存先パスを検証する describe だけが mockSupabaseAdmin.current を差し替える。
// getter 経由にしているのは、ルート側が呼び出し時に supabaseAdmin を読むため、
// jest.resetModules() を使わずにテスト単位で有効/無効を切り替えられるようにするため。
const mockSupabaseAdmin: { current: unknown } = { current: null };
jest.mock("../../../auth/supabaseClient", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.current;
  },
}));

const mockTrackUsage = jest.fn();
jest.mock("../../../lib/billing/usageTracker", () => ({
  trackUsage: (...args: any[]) => mockTrackUsage(...args),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function makeApp(tenantId = "tenant-a", role: "client_admin" | "super_admin" = "client_admin") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
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

  // avatar_config_image は billable（NON_BILLABLE_FEATURES に含まれない）。
  // 計上しないと生成の原価をテナントに請求できない = 当社負担になるため、
  // 成功時に必ず1件計上されることを固定する。
  it("生成に成功したら usage_logs へ計上する（生成枚数つき）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK_RESPONSE,
    });

    const res = await request(makeApp("tenant-billing"))
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling", numImages: 4 });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-billing",
        featureUsed: "avatar_config_image",
        imageCount: 4,
      }),
    );
  });

  // previewMode(super_adminのクライアントビュー)中、app_metadata.tenant_id が空の
  // super_adminがそのまま生成すると trackUsage が空テナントで計上され、Supabase
  // Storageのパス(uploadImageFromUrlの第2引数=同じtenantId変数)もバケット直下に
  // 書き込まれていた(#P0-1)。?tenant= を effective tenantId として使うことを固定する。
  it("super_adminが?tenant=で操作対象テナントを指定すると、そのテナントでusage_logsに計上される", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK_RESPONSE,
    });

    const res = await request(makeApp("", "super_admin"))
      .post("/v1/admin/avatar/fal/generate?tenant=tenant-b")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling" });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-b" }),
    );
  });

  it("client_adminが?tenant=を付けても無視され、JWTの自テナントで計上される(越権防止)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => FAL_OK_RESPONSE,
    });

    const res = await request(makeApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/fal/generate?tenant=tenant-b")
      .send({ prompt: "Professional portrait of a Japanese man, bust shot, business suit" });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
  });

  // super_adminが previewMode に入らず ?tenant= も付けずに叩くと、テナントが
  // 解決できないまま fal.ai を呼び、バケット直下に書き込み・空テナントに課金
  // していた(#P0-1で発覚)。#P0-3: 外部APIを呼ぶ前に400で早期リターンする。
  it("super_adminが?tenant=を付けないとテナント不明で400になり、fal.aiを呼ばない", async () => {
    const res = await request(makeApp("", "super_admin"))
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling" });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("生成に失敗した場合は計上しない", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese man, bust shot, business suit" });

    expect(res.status).toBe(502);
    expect(mockTrackUsage).not.toHaveBeenCalled();
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

// ── Supabase Storage の保存先 ───────────────────────────────────────────────
// 上の describe は supabaseAdmin=null でアップロード自体をスキップしており、
// 保存先パスの組み立て(`${tenantId}/${filename}.${ext}`)が一度も検証されて
// いなかった。テナントの取り違えで最も重い実害はここ(バケット直下や別テナントの
// ディレクトリへ全テナントの画像が混在して書き込まれる)なので、supabaseAdmin を
// 有効にした状態で保存先だけを検証する。
describe("POST /v1/admin/avatar/fal/generate — Supabase Storage の保存先", () => {
  const uploadedPaths: string[] = [];

  function makeStorageApp(tenantId: string, role: "client_admin" | "super_admin" = "client_admin") {
    uploadedPaths.length = 0;
    mockSupabaseAdmin.current = {
      storage: {
        from: () => ({
          upload: (filePath: string) => {
            uploadedPaths.push(filePath);
            return Promise.resolve({ error: null });
          },
          getPublicUrl: (filePath: string) => ({
            data: { publicUrl: `https://cdn.example/${filePath}` },
          }),
        }),
      },
    };

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
      req.requestId = "req-store-001";
      next();
    });
    registerFalGenerationRoutes(app);
    return app;
  }

  // fal.ai は画像URLを返し、その後 uploadImageFromUrl が各URLを実際に取得する。
  // 1度目の fetch を fal.ai、以降を画像ダウンロードとして応答させる。
  function mockFalThenImageDownloads(imageUrls: string[]) {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("fal.run")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            images: imageUrls.map((u) => ({ url: u, width: 768, height: 1024 })),
            seed: 1,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: { get: () => "image/jpeg" },
      });
    });
  }

  // 上の describe の beforeEach/afterEach はこの describe には適用されないため、
  // FAL_KEY の用意とモックのクリアをここでも行う（クリアし忘れると前のテストの
  // fetch 呼び出しが残り、「呼ばれていないこと」の検証が通らなくなる）。
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAL_KEY = "test-fal-key";
  });

  afterEach(() => {
    delete process.env.FAL_KEY;
    // 他の describe（ストレージ無効前提）へ影響を残さない
    mockSupabaseAdmin.current = null;
  });

  it("client_admin: 自テナントのディレクトリ配下に保存される", async () => {
    mockFalThenImageDownloads(["https://img.fal.media/a.jpg"]);

    const res = await request(makeStorageApp("tenant-a"))
      .post("/v1/admin/avatar/fal/generate")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling", numImages: 1 });

    expect(res.status).toBe(200);
    expect(uploadedPaths).toHaveLength(1);
    expect(uploadedPaths[0]!.startsWith("tenant-a/")).toBe(true);
  });

  it("super_admin + ?tenant=: 操作対象テナントのディレクトリへ保存される(自分のではなく)", async () => {
    mockFalThenImageDownloads(["https://img.fal.media/a.jpg", "https://img.fal.media/b.jpg"]);

    const res = await request(makeStorageApp("", "super_admin"))
      .post("/v1/admin/avatar/fal/generate?tenant=tenant-b")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling", numImages: 2 });

    expect(res.status).toBe(200);
    expect(uploadedPaths).toHaveLength(2);
    for (const p of uploadedPaths) expect(p.startsWith("tenant-b/")).toBe(true);
    // バケット直下（先頭が "/"）に落ちていないこと＝今回の欠陥そのものの回帰ガード
    for (const p of uploadedPaths) expect(p.startsWith("/")).toBe(false);
  });

  it("[越権防止] client_adminが?tenant=で他テナントのディレクトリへ書き込めない", async () => {
    mockFalThenImageDownloads(["https://img.fal.media/a.jpg"]);

    const res = await request(makeStorageApp("tenant-a", "client_admin"))
      .post("/v1/admin/avatar/fal/generate?tenant=tenant-b")
      .send({ prompt: "Professional portrait of a Japanese man, bust shot, business suit", numImages: 1 });

    expect(res.status).toBe(200);
    expect(uploadedPaths[0]!.startsWith("tenant-a/")).toBe(true);
  });

  it("[空白のみ] ?tenant= が空白だけなら400で止まり、バケットへ一切書き込まない", async () => {
    // "   " は truthy なので、helper 側で trim していないと 400 ガードを通過して
    // "   /fal-xxx.jpg" というパスで実際に書き込まれてしまう。
    mockFalThenImageDownloads(["https://img.fal.media/a.jpg"]);

    const res = await request(makeStorageApp("", "super_admin"))
      .post("/v1/admin/avatar/fal/generate?tenant=%20%20%20")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling", numImages: 1 });

    expect(res.status).toBe(400);
    expect(uploadedPaths).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("[クエリ汚染] ?tenant= を2回指定されたら400で止まり、\"a,b\" のようなパスを作らない", async () => {
    mockFalThenImageDownloads(["https://img.fal.media/a.jpg"]);

    const res = await request(makeStorageApp("", "super_admin"))
      .post("/v1/admin/avatar/fal/generate?tenant=tenant-a&tenant=tenant-b")
      .send({ prompt: "Professional portrait of a Japanese woman, bust shot, smiling", numImages: 1 });

    expect(res.status).toBe(400);
    expect(uploadedPaths).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
