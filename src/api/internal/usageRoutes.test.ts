// src/api/internal/usageRoutes.test.ts
// GID 1215923339649519: avatar-agent のトークン使用量が破棄され課金$0になる不具合の回帰テスト

import express from "express";
import request from "supertest";

jest.mock("../../lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTrackUsage = jest.fn();
jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: (...args: any[]) => mockTrackUsage(...args),
}));

import { registerInternalUsageRoutes } from "./usageRoutes";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerInternalUsageRoutes(app);
  return app;
}

describe("POST /api/internal/usage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("X-Internal-Request ヘッダなし → 403", async () => {
    const res = await request(makeApp())
      .post("/api/internal/usage")
      .send({ tenantId: "tenant-abc" });

    expect(res.status).toBe(403);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("tenantId 欠落 → 400", async () => {
    const res = await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({});

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("agent.pyが送るinputTokens/outputTokens/model/featureUsedがそのままtrackUsageに渡る（回帰: 以前は0/固定値にハードコードされていた）", async () => {
    const res = await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({
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
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", inputTokens: 1, outputTokens: 1, featureUsed: "voice" });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ featureUsed: "voice" }),
    );
  });

  it("許可外のfeatureUsed（なりすまし試行）は'avatar'にフォールバックされる", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", inputTokens: 1, outputTokens: 1, featureUsed: "admin_agent" });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ featureUsed: "avatar" }),
    );
  });

  it("inputTokens/outputTokens/model/featureUsed省略時は後方互換のデフォルト値(0/0/GROQ_VERSATILE_70B/avatar)を使う", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", ttsTextBytes: 100 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        model: "llama-3.3-70b-versatile",
        featureUsed: "avatar",
        ttsTextBytes: 100,
      }),
    );
  });

  it("GID 1217083837550852: 既知のttsModelはtrackUsageにそのまま渡る", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", ttsTextBytes: 100, ttsModel: "s2.1-pro-free" });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: "s2.1-pro-free" }),
    );
  });

  it("GID 1217083837550852: allowlist外のttsModel（なりすまし試行）はundefinedにフォールバックされ原価計算に到達しない", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", ttsTextBytes: 100, ttsModel: "free-model-that-does-not-exist" });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: undefined }),
    );
  });

  it("requestId省略時は自動生成される", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc" });

    const call = mockTrackUsage.mock.calls[0][0];
    expect(typeof call.requestId).toBe("string");
    expect(call.requestId.length).toBeGreaterThan(0);
  });

  // ── イレギュラーな入力形状（内部APIだが境界値として型を信用しない） ──────
  it("イレギュラー: ttsModelが配列(JSON \"?tenant=a&tenant=b\"型の汚染)は文字列扱いされず undefined になる", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", ttsTextBytes: 100, ttsModel: ["s2.1-pro-free", "s2.1-pro"] });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: undefined }),
    );
  });

  it("イレギュラー: ttsModelがオブジェクトは文字列扱いされず undefined になる", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", ttsTextBytes: 100, ttsModel: { toString: () => "s2.1-pro-free" } });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsModel: undefined }),
    );
  });

  it("イレギュラー: tenantIdが配列は400(型強制せず拒否する)", async () => {
    const res = await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: ["tenant-a", "tenant-b"] });

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("イレギュラー: tenantIdが数値は400", async () => {
    const res = await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: 12345 });

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("イレギュラー: 負のttsTextBytesは請求額を減らす攻撃になり得るため0扱い(undefined)に落とされる", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", ttsTextBytes: -1000000 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ttsTextBytes: undefined }),
    );
  });

  it("イレギュラー: 負のinputTokens/outputTokensは0にフォールバックする(負のコストで相殺する攻撃を防ぐ)", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", inputTokens: -500, outputTokens: -500 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    );
  });

  it("イレギュラー: 負のavatarCredits/avatarSessionMsはundefinedにフォールバックする", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", avatarCredits: -10, avatarSessionMs: -5000 });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ avatarCredits: undefined, avatarSessionMs: undefined }),
    );
  });

  it("イレギュラー: NaN/InfinityのinputTokensは0にフォールバックする", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc", inputTokens: Number.POSITIVE_INFINITY });

    // JSON経由ではInfinityはnullになるが、Number.MAX_VALUE等の巨大値経路も含め
    // 数値として素通りしないことをここで固定する(型ガードのみで上限は無いため
    // 巨大値そのものはtrackUsageに渡ってよい —素通りする値そのものの妥当性は
    // costCalculator側の責務であり、ここでは「型が壊れていない」ことだけ検証する)
    const call = mockTrackUsage.mock.calls[0][0];
    expect(typeof call.inputTokens).toBe("number");
    expect(Number.isNaN(call.inputTokens)).toBe(false);
  });

  it("イレギュラー: bodyが空文字列(Content-Typeだけ設定されパースエラー)でも500にならず400/403いずれかで確定する", async () => {
    const res = await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .set("Content-Type", "application/json")
      .send("");

    expect([400, 403]).toContain(res.status);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
