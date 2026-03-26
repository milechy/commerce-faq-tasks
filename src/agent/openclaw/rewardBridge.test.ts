// src/agent/openclaw/rewardBridge.test.ts
// Phase47: RewardBridge テスト

import { sendRewardSignal } from "./rewardBridge";

// fetch のモック
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENCLAW_ENABLED = "true";
  process.env.OPENCLAW_TENANTS = "carnation";
  process.env.OPENCLAW_RL_URL = "http://localhost:3200";
});

afterEach(() => {
  delete process.env.OPENCLAW_ENABLED;
  delete process.env.OPENCLAW_TENANTS;
  delete process.env.OPENCLAW_RL_URL;
});

describe("sendRewardSignal", () => {
  it("Feature Flag オフのテナントは何もしない", async () => {
    await sendRewardSignal({
      tenantId: "other-tenant",
      sessionId: "sess-001",
      variantId: "v1",
      score: 80,
      outcome: "appointment",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("carnation テナントは reward を POST する", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await sendRewardSignal({
      tenantId: "carnation",
      sessionId: "sess-001",
      variantId: "v1",
      score: 80,
      outcome: "unknown",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3200/reward");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.tenant_id).toBe("carnation");
    expect(body.reward).toBeCloseTo(0.8, 1);
  });

  it("appointment は reward が +0.1 される", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await sendRewardSignal({
      tenantId: "carnation",
      sessionId: "sess-002",
      variantId: null,
      score: 70,
      outcome: "appointment",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.reward).toBeCloseTo(0.8, 1); // 0.7 + 0.1
  });

  it("lost は reward が -0.1 される", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await sendRewardSignal({
      tenantId: "carnation",
      sessionId: "sess-003",
      variantId: null,
      score: 70,
      outcome: "lost",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.reward).toBeCloseTo(0.6, 1); // 0.7 - 0.1
  });

  it("fetch エラー時はサイレントに無視する（例外をスローしない）", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    await expect(
      sendRewardSignal({
        tenantId: "carnation",
        sessionId: "sess-004",
        variantId: "v1",
        score: 85,
        outcome: "unknown",
      }),
    ).resolves.toBeUndefined();
  });

  it("reward は 0.0–1.0 にクランプされる（score=110 でも 1.0 以下）", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await sendRewardSignal({
      tenantId: "carnation",
      sessionId: "sess-005",
      variantId: null,
      score: 110, // 異常値
      outcome: "appointment",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.reward).toBeLessThanOrEqual(1.0);
    expect(body.reward).toBeGreaterThanOrEqual(0.0);
  });
});

describe("workspaceAdapter", () => {
  it("Feature Flag オフは null を返す", async () => {
    const { buildWorkspaceFiles } = await import("./workspaceAdapter");
    const result = buildWorkspaceFiles("other-tenant", "test prompt");
    expect(result).toBeNull();
  });

  it("carnation は WorkspaceFiles を返す", async () => {
    const { buildWorkspaceFiles } = await import("./workspaceAdapter");
    const result = buildWorkspaceFiles("carnation", "あなたは中古車販売のアシスタントです");
    expect(result).not.toBeNull();
    expect(result?.soul).toContain("carnation");
    expect(result?.identity).toContain("carnation");
  });

  it("system_prompt は 200 文字以内にスライスされる", async () => {
    const { buildWorkspaceFiles } = await import("./workspaceAdapter");
    const longPrompt = "あ".repeat(500);
    const result = buildWorkspaceFiles("carnation", longPrompt);
    // soul の中に 200 文字超のプロンプトが含まれないこと
    const promptInSoul = result?.soul.match(/Core directive: (.+)\n/)?.[1] ?? "";
    expect(promptInSoul.length).toBeLessThanOrEqual(200);
  });
});
