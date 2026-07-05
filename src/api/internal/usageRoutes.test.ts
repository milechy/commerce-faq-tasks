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

  it("requestId省略時は自動生成される", async () => {
    await request(makeApp())
      .post("/api/internal/usage")
      .set("X-Internal-Request", "1")
      .send({ tenantId: "tenant-abc" });

    const call = mockTrackUsage.mock.calls[0][0];
    expect(typeof call.requestId).toBe("string");
    expect(call.requestId.length).toBeGreaterThan(0);
  });
});
