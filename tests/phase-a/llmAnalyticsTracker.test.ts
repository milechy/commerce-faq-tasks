// tests/phase-a/llmAnalyticsTracker.test.ts
import { trackLlmGeneration } from "../../src/lib/posthog/llmAnalyticsTracker";
import { _resetPostHogClientForTest } from "../../src/lib/posthog/posthogClient";

const mockCapture = jest.fn();
jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    flush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe("trackLlmGeneration", () => {
  beforeEach(() => {
    _resetPostHogClientForTest();
    mockCapture.mockClear();
  });

  afterEach(() => {
    delete process.env.POSTHOG_PROJECT_API_KEY;
    _resetPostHogClientForTest();
  });

  it("does nothing when POSTHOG_PROJECT_API_KEY is not set", () => {
    delete process.env.POSTHOG_PROJECT_API_KEY;
    trackLlmGeneration({
      tenantId: "t1", sessionId: "s1", model: "groq/compound", provider: "groq", latencyMs: 500,
    });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("captures $ai_generation event with required fields", () => {
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    trackLlmGeneration({
      tenantId: "t1", sessionId: "s1", model: "groq/compound", provider: "groq", latencyMs: 1200,
    });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: "tenant:t1",
      event: "$ai_generation",
      properties: expect.objectContaining({
        $ai_provider: "groq",
        $ai_model: "groq/compound",
        $ai_latency: 1.2,
        tenant_id: "t1",
        session_id: "s1",
      }),
    }));
  });

  it("includes token counts and cost when provided", () => {
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    trackLlmGeneration({
      tenantId: "t1", sessionId: "s1", model: "groq/compound", provider: "groq",
      latencyMs: 500, inputTokens: 100, outputTokens: 50,
    });
    const call = mockCapture.mock.calls[0][0] as { properties: Record<string, unknown> };
    expect(call.properties.$ai_input_tokens).toBe(100);
    expect(call.properties.$ai_output_tokens).toBe(50);
    expect(typeof call.properties.$ai_cost).toBe("number");
  });

  it("does not throw on unexpected errors", () => {
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    mockCapture.mockImplementationOnce(() => { throw new Error("network error"); });
    expect(() => trackLlmGeneration({
      tenantId: "t1", sessionId: "s1", model: "groq/compound", provider: "groq", latencyMs: 500,
    })).not.toThrow();
  });
});
