// src/api/internal/usageRoutes.test.ts
// GID 1215923339649519: avatar-agent のトークン使用量が破棄され課金$0になる不具合の回帰テスト
// + 内部API HMAC 認証(P0: body.tenantId 全信用による偽課金の遮断)の検証

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { createHmac } from "node:crypto";

jest.mock("../../lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTrackUsage = jest.fn();
jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: (...args: any[]) => mockTrackUsage(...args),
}));

import { registerInternalUsageRoutes } from "./usageRoutes";

const HMAC_SECRET = "test-internal-hmac-secret";
const PATH = "/api/internal/usage";

function hmacHeaders(body: unknown, secret: string = HMAC_SECRET, ts?: string) {
  const timestamp = ts ?? Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}:${JSON.stringify(body)}`)
    .digest("hex");
  return {
    "x-internal-request": "1",
    "x-hmac-timestamp": timestamp,
    "x-hmac-signature": signature,
  };
}

function makeApp() {
  process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
  const app = express();
  app.use(express.json());
  registerInternalUsageRoutes(app);
  return app;
}

/** 正しい HMAC 署名を付与して送る。body は署名対象と送信ボディで一致させる。 */
function signedPost(app: express.Express, body: unknown) {
  return request(app).post(PATH).set(hmacHeaders(body)).send(body as object);
}

describe("POST /api/internal/usage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
  });
  afterAll(() => {
    delete process.env.INTERNAL_API_HMAC_SECRET;
  });

  it("X-Internal-Request ヘッダなし → 403", async () => {
    const res = await request(makeApp()).post(PATH).send({ tenantId: "tenant-abc" });

    expect(res.status).toBe(403);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("tenantId 欠落 → 400", async () => {
    const res = await signedPost(makeApp(), {});

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("agent.pyが送るinputTokens/outputTokens/model/featureUsedがそのままtrackUsageに渡る（回帰: 以前は0/固定値にハードコードされていた）", async () => {
    const res = await signedPost(makeApp(), {
      tenantId: "tenant-abc",
      inputTokens: 123,
      outputTokens: 45,
      model: "llama-3.3-70b-versatile",
      featureUsed: "avatar",
    });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-abc",
        inputTokens: 123,
        outputTokens: 45,
        model: "llama-3.3-70b-versatile",
        featureUsed: "avatar",
      }),
    );
  });

  it("featureUsed:voice も許可される", async () => {
    await signedPost(makeApp(), {
      tenantId: "tenant-abc",
      inputTokens: 1,
      outputTokens: 1,
      featureUsed: "voice",
    });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ featureUsed: "voice" }),
    );
  });

  it("許可外のfeatureUsed（なりすまし試行）は'avatar'にフォールバックされる", async () => {
    await signedPost(makeApp(), {
      tenantId: "tenant-abc",
      inputTokens: 1,
      outputTokens: 1,
      featureUsed: "admin_agent",
    });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ featureUsed: "avatar" }),
    );
  });

  it("inputTokens/outputTokens/model/featureUsed省略時は後方互換のデフォルト値(0/0/GPT_OSS_120B/avatar)を使う", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc", ttsTextBytes: 100 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        model: "openai/gpt-oss-120b",
        featureUsed: "avatar",
        ttsTextBytes: 100,
      }),
    );
  });

  it("GID 1217083837550852: 既知のttsModelはtrackUsageにそのまま渡る", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc", ttsTextBytes: 100, ttsModel: "s2.1-pro-free" });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: "s2.1-pro-free" }),
    );
  });

  it("GID 1217083837550852: allowlist外のttsModel（なりすまし試行）はundefinedにフォールバックされ原価計算に到達しない", async () => {
    await signedPost(makeApp(), {
      tenantId: "tenant-abc",
      ttsTextBytes: 100,
      ttsModel: "free-model-that-does-not-exist",
    });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: undefined }),
    );
  });

  it("requestId省略時は自動生成される", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc" });

    const call = mockTrackUsage.mock.calls[0][0];
    expect(typeof call.requestId).toBe("string");
    expect(call.requestId.length).toBeGreaterThan(0);
  });

  // ── イレギュラーな入力形状（内部APIだが境界値として型を信用しない） ──────
  it("イレギュラー: ttsModelが配列(JSON \"?tenant=a&tenant=b\"型の汚染)は文字列扱いされず undefined になる", async () => {
    await signedPost(makeApp(), {
      tenantId: "tenant-abc",
      ttsTextBytes: 100,
      ttsModel: ["s2.1-pro-free", "s2.1-pro"],
    });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: undefined }),
    );
  });

  it("イレギュラー: ttsModelがオブジェクトは文字列扱いされず undefined になる", async () => {
    await signedPost(makeApp(), {
      tenantId: "tenant-abc",
      ttsTextBytes: 100,
      ttsModel: { toString: () => "s2.1-pro-free" },
    });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: undefined }),
    );
  });

  it("イレギュラー: tenantIdが配列は400(型強制せず拒否する)", async () => {
    const res = await signedPost(makeApp(), { tenantId: ["tenant-a", "tenant-b"] });

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("イレギュラー: tenantIdが数値は400", async () => {
    const res = await signedPost(makeApp(), { tenantId: 12345 });

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("イレギュラー: 負のttsTextBytesは請求額を減らす攻撃になり得るため0扱い(undefined)に落とされる", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc", ttsTextBytes: -1000000 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsTextBytes: undefined }),
    );
  });

  it("イレギュラー: 負のinputTokens/outputTokensは0にフォールバックする(負のコストで相殺する攻撃を防ぐ)", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc", inputTokens: -500, outputTokens: -500 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    );
  });

  it("イレギュラー: 負のavatarCredits/avatarSessionMsはundefinedにフォールバックする", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc", avatarCredits: -10, avatarSessionMs: -5000 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ avatarCredits: undefined, avatarSessionMs: undefined }),
    );
  });

  it("イレギュラー: NaN/InfinityのinputTokensは0にフォールバックする", async () => {
    await signedPost(makeApp(), { tenantId: "tenant-abc", inputTokens: Number.POSITIVE_INFINITY });

    // JSON経由ではInfinityはnullになるが、Number.MAX_VALUE等の巨大値経路も含め
    // 数値として素通りしないことをここで固定する(型ガードのみで上限は無いため
    // 巨大値そのものはtrackUsageに渡ってよい —素通りする値そのものの妥当性は
    // costCalculator側の責務であり、ここでは「型が壊れていない」ことだけ検証する)
    const call = mockTrackUsage.mock.calls[0][0];
    expect(typeof call.inputTokens).toBe("number");
    expect(Number.isNaN(call.inputTokens)).toBe(false);
  });

  it("イレギュラー: bodyが空文字列(Content-Typeだけ設定されパースエラー)でも500にならず400/403/401いずれかで確定する", async () => {
    const res = await request(makeApp())
      .post(PATH)
      .set("X-Internal-Request", "1")
      .set("Content-Type", "application/json")
      .send("");

    expect([400, 401, 403]).toContain(res.status);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  // ── HMAC 認証(P0) ────────────────────────────────────────────────────────
  describe("HMAC 認証", () => {
    it("正しい署名 → 200 で trackUsage に到達する", async () => {
      const res = await signedPost(makeApp(), { tenantId: "tenant-abc", inputTokens: 1, outputTokens: 1 });
      expect(res.status).toBe(200);
      expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    });

    it("X-Internal-Request はあるが HMAC ヘッダ欠落 → 401(署名無しの tenantId 偽装を拒否)", async () => {
      const res = await request(makeApp())
        .post(PATH)
        .set("X-Internal-Request", "1")
        .send({ tenantId: "victim-tenant", ttsTextBytes: 999999 });

      expect(res.status).toBe(401);
      expect(mockTrackUsage).not.toHaveBeenCalled();
    });

    it("署名が不正(別 secret で生成) → 401", async () => {
      const body = { tenantId: "victim-tenant", avatarCredits: 100000 };
      const res = await request(makeApp())
        .post(PATH)
        .set(hmacHeaders(body, "attacker-secret"))
        .send(body);

      expect(res.status).toBe(401);
      expect(mockTrackUsage).not.toHaveBeenCalled();
    });

    it("署名対象と送信ボディの不一致(ボディ改竄) → 401", async () => {
      // 署名は無害な body に対して作り、送信時に tenantId をすり替える
      const signedBody = { tenantId: "attacker-own", ttsTextBytes: 1 };
      const tamperedBody = { tenantId: "victim-tenant", ttsTextBytes: 999999 };
      const res = await request(makeApp())
        .post(PATH)
        .set(hmacHeaders(signedBody))
        .send(tamperedBody);

      expect(res.status).toBe(401);
      expect(mockTrackUsage).not.toHaveBeenCalled();
    });

    it("タイムスタンプが許容範囲外(古い) → 401", async () => {
      const body = { tenantId: "tenant-abc", ttsTextBytes: 1 };
      const staleTs = (Math.floor(Date.now() / 1000) - 3600).toString();
      const res = await request(makeApp())
        .post(PATH)
        .set(hmacHeaders(body, HMAC_SECRET, staleTs))
        .send(body);

      expect(res.status).toBe(401);
      expect(mockTrackUsage).not.toHaveBeenCalled();
    });

    it("secret 未設定 → fail-closed 500(素通ししない)", async () => {
      const app = makeApp();
      delete process.env.INTERNAL_API_HMAC_SECRET;
      const body = { tenantId: "tenant-abc", ttsTextBytes: 1 };
      const res = await request(app).post(PATH).set(hmacHeaders(body)).send(body);

      expect(res.status).toBe(500);
      expect(mockTrackUsage).not.toHaveBeenCalled();
    });
  });
});
