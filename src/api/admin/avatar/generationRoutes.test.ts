// src/api/admin/avatar/generationRoutes.test.ts
// GID 1217084040137242: POST /v1/admin/avatar/design-voice の振る舞いテスト。
// 認可(403/権限)の網羅は avatarGenerationAuthGuard.test.ts が別途カバーする。

import express from "express";
import request from "supertest";
import { registerAvatarGenerationRoutes } from "./generationRoutes";

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

const mockTrackUsage = jest.fn();
jest.mock("../../../lib/billing/usageTracker", () => ({
  trackUsage: (...args: any[]) => mockTrackUsage(...args),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeApp(role: "client_admin" | "super_admin" = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    req.requestId = "req-test-design-voice";
    next();
  });
  registerAvatarGenerationRoutes(app, {});
  return app;
}

function mockVoiceDesignOk() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          id: "candidate-1",
          index: 0,
          audio_base64: "ZmFrZS13YXYtYnl0ZXM=",
          sample_rate: 44100,
          duration_ms: 3000,
          text: "テストテキスト",
          language: "ja",
        },
      ],
    }),
  });
}

describe("POST /v1/admin/avatar/design-voice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FISH_AUDIO_API_KEY = "test-fish-key";
  });

  afterEach(() => {
    delete process.env.FISH_AUDIO_API_KEY;
  });

  it("正常系: instructionを送るとcandidatesを返し、voiceDesignRequestCount:1を計上する", async () => {
    mockVoiceDesignOk();

    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた30代女性の声。ゆっくり丁寧に話す。", reference_text: "ご来店ありがとうございます。" });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0]).toMatchObject({
      id: "candidate-1",
      audioBase64: "ZmFrZS13YXYtYnl0ZXM=",
      sampleRate: 44100,
      durationMs: 3000,
      language: "ja",
    });

    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        featureUsed: "avatar_config_voice",
        voiceDesignRequestCount: 1,
      }),
    );
  });

  it("GID 1217084040142043(実API確認済み): modelはJSON bodyではなくHTTPヘッダ'model: voice-design-1'で送る", async () => {
    mockVoiceDesignOk();

    await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/v1/voice-design");
    const headers = init.headers as Record<string, string>;
    expect(headers["model"]).toBe("voice-design-1");
    const body = JSON.parse(init.body as string);
    // 誤ってbodyにmodelを入れる回帰を防ぐ
    expect(body.model).toBeUndefined();
    expect(body.instruction).toBe("落ち着いた声");
  });

  it("認証エラー: 未認証(supabaseUserなし)は403", async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.supabaseUser = null;
      next();
    });
    registerAvatarGenerationRoutes(app, {});

    const res = await request(app)
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: instructionなしは400、Fish APIに到達しない", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({});

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: instructionが2001字は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "あ".repeat(2001) });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: reference_textが151字は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", reference_text: "あ".repeat(151) });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("Fish Audio APIエラー: 5xxは502、trackUsageを呼ばない（失敗リクエストを課金しない）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    expect(res.status).toBe(502);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("FISH_AUDIO_API_KEY未設定は500、trackUsageを呼ばない", async () => {
    delete process.env.FISH_AUDIO_API_KEY;

    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    expect(res.status).toBe(500);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("外部API例外(タイムアウト等)は500で確定応答を返す（無限待ちにしない）", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network timeout"));

    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    expect(res.status).toBe(500);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
