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

// avatar_customize ゲートが queryTenantPlan 経由で参照する。
// 既定は growth（＝ゲートを通す）。ゲートそのものを見るテストだけが上書きする。
const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: mockQuery }),
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
    mockQuery.mockResolvedValue({ rows: [{ plan: "growth" }] });
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

  // ── 境界値: instruction ───────────────────────────────────────────────
  it("バリデーション境界: instructionがちょうど2000字は通る(2001字だけが400)", async () => {
    mockVoiceDesignOk();
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "あ".repeat(2000) });

    expect(res.status).toBe(200);
  });

  it("バリデーション境界: reference_textがちょうど150字は通る(151字だけが400)", async () => {
    mockVoiceDesignOk();
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", reference_text: "あ".repeat(150) });

    expect(res.status).toBe(200);
  });

  // ── 境界値: n(候補数) ─────────────────────────────────────────────────
  it("バリデーション境界: n=0は400(1未満)、Fish APIに到達しない", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", n: 0 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーション境界: n=5は400(4を超える)、Fish APIに到達しない", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", n: 5 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーション境界: n=1.5(非整数)は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", n: 1.5 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーション境界: n=1〜4はいずれも通る", async () => {
    for (const n of [1, 2, 3, 4]) {
      mockVoiceDesignOk();
      const res = await request(makeApp())
        .post("/v1/admin/avatar/design-voice")
        .send({ instruction: "落ち着いた声", n });
      expect(res.status).toBe(200);
    }
  });

  // ── 境界値: speed ────────────────────────────────────────────────────
  // 公式仕様は "0 < speed <= 3"。0自体は不可(除外境界)であることを固定する。
  it("バリデーション境界: speed=0は400(公式仕様は0を含まない排他的下限)", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", speed: 0 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーション境界: speed=-1は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", speed: -1 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーション境界: speed=3ちょうどは通る(3.01だけが400)", async () => {
    mockVoiceDesignOk();
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", speed: 3 });

    expect(res.status).toBe(200);
  });

  it("バリデーション境界: speed=3.01は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", speed: 3.01 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーション境界: speedの極小正数(0.0001)は通る(下限は排他的だが正であればよい)", async () => {
    mockVoiceDesignOk();
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", speed: 0.0001 });

    expect(res.status).toBe(200);
  });

  // ── 禁止ワード（二重防御。generate-imageと同じ判定を再利用） ─────────────
  it("禁止ワード: instructionにNSFW表現が含まれると400、Fish APIに到達しない", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "セクシーな声で話してください" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("不適切");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("禁止ワード: 大文字小文字を無視して判定される(NSFWの英語表記)", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "Sound like a NSFW voice" });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── イレギュラーなリクエスト形状 ─────────────────────────────────────
  it("イレギュラー: instructionが数値型(文字列でない)は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: 12345 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("イレギュラー: nが文字列(\"2\")は400(型強制しない)", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声", n: "2" });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("イレギュラー: bodyがnull(JSON \"null\"送信)は400", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .set("Content-Type", "application/json")
      .send("null");

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Fish Audioが200だが不正な形のJSONを返した場合 ─────────────────────
  it("Fish Audioが200だがcandidatesフィールド自体が無い場合は空配列として返す(クラッシュしない)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    // 空配列でも「成功」扱いなのでtrackUsageは呼ばれる(design-voice自体は成功しているため。
    // 0件フォールバックの判断はフロント側の責務 — match-voiceのような「空なら失敗扱い」に
    // していない点に注意。フロント側テストで別途カバー)
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
  });

  it("Fish Audioが200だが本文がJSONとしてパースできない場合は500で確定する(無限待ちにしない)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error("Unexpected token in JSON");
      },
    });

    const res = await request(makeApp())
      .post("/v1/admin/avatar/design-voice")
      .send({ instruction: "落ち着いた声" });

    expect(res.status).toBe(500);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// avatar_customize（Growth〜）のプランゲート
// ---------------------------------------------------------------------------
//
// これら4ルートは Avatar Customization Studio の実体（画像生成・声マッチング・
// 声デザイン・プロンプト生成）で、Standard(¥9,800)では使えない。
// Standard は R2C の既定アバターをそのまま使う段であり、ここが通ってしまうと
// 「既定のみ」という Standard の商品性が成立しない。
//
// ゲート導入前はロール認可のみで、client_admin なら全プランで素通りしていた。
// premiumGenerationRoutes.test.ts の premium_avatar ゲートと同じ構造で固定する。
describe("avatar_customize プランゲート（4ルート共通）", () => {
  const ROUTES: Array<[string, Record<string, unknown>]> = [
    ["/v1/admin/avatar/generate-image", { description: "30代女性の受付スタッフ" }],
    ["/v1/admin/avatar/match-voice", { description: "落ち着いた女性の声" }],
    ["/v1/admin/avatar/design-voice", { instruction: "落ち着いた30代女性の声。" }],
    ["/v1/admin/avatar/generate-prompt", { rules: "丁寧に接客する" }],
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FISH_AUDIO_API_KEY = "test-fish-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.LEONARDO_API_KEY = "test-leonardo-key";
  });

  afterEach(() => {
    delete process.env.FISH_AUDIO_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.LEONARDO_API_KEY;
  });

  describe.each(ROUTES)("POST %s", (path, body) => {
    it("standardプランは403(plan_upgrade_required)で拒否され、外部APIを一切呼ばない", async () => {
      mockQuery.mockResolvedValue({ rows: [{ plan: "standard" }] });

      const res = await request(makeApp()).post(path).send(body);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("plan_upgrade_required");
      // 原価の発生前に落ちていること（拒否したのに課金だけ走る状態を作らない）
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockTrackUsage).not.toHaveBeenCalled();
    });

    it("案内文は Growth への変更と、Standard でも既定アバターが使えることの両方を伝える", async () => {
      mockQuery.mockResolvedValue({ rows: [{ plan: "standard" }] });

      const res = await request(makeApp()).post(path).send(body);

      expect(res.body.message).toContain("Growth");
      expect(res.body.message).toContain("Standard");
    });

    it.each(["free_ad", "starter"])("%s プランも403で拒否される", async (plan) => {
      mockQuery.mockResolvedValue({ rows: [{ plan }] });

      const res = await request(makeApp()).post(path).send(body);

      expect(res.status).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("plan取得がDB障害で失敗した場合もfail-safeで403(プラン外機能を開かない)", async () => {
      mockQuery.mockRejectedValue(new Error("db down"));

      const res = await request(makeApp()).post(path).send(body);

      expect(res.status).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("growthプランはゲートを通過する(403にならない=過剰ブロックの対検証)", async () => {
      mockQuery.mockResolvedValue({ rows: [{ plan: "growth" }] });
      // 外部APIの成否はここでは問わない。ゲートで止まっていないことだけを見る。
      mockFetch.mockRejectedValue(new Error("network"));

      const res = await request(makeApp()).post(path).send(body);

      expect(res.status).not.toBe(403);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("enterpriseプランもゲートを通過する", async () => {
      mockQuery.mockResolvedValue({ rows: [{ plan: "enterprise" }] });
      mockFetch.mockRejectedValue(new Error("network"));

      const res = await request(makeApp()).post(path).send(body);

      expect(res.status).not.toBe(403);
    });

    it("super_adminはプラン照会自体をせずバイパスする(原価の出るサポート業務を止めない)", async () => {
      mockFetch.mockRejectedValue(new Error("network"));

      const res = await request(makeApp("super_admin", "tenant-a")).post(path).send(body);

      expect(res.status).not.toBe(403);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("bodyが不正なときはプラン判定より先に400を返す(切り分けの順序を保つ)", async () => {
      mockQuery.mockResolvedValue({ rows: [{ plan: "standard" }] });

      const res = await request(makeApp()).post(path).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
