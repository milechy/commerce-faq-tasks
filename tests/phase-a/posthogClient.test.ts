// tests/phase-a/posthogClient.test.ts
import { getPostHogClient, _resetPostHogClientForTest } from "../../src/lib/posthog/posthogClient";

jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { PostHog } from "posthog-node";
const MockedPostHog = PostHog as jest.MockedClass<typeof PostHog>;

describe("getPostHogClient", () => {
  beforeEach(() => {
    _resetPostHogClientForTest();
    MockedPostHog.mockClear();
  });

  afterEach(() => {
    delete process.env.POSTHOG_PROJECT_API_KEY;
    delete process.env.POSTHOG_API_HOST;
    _resetPostHogClientForTest();
  });

  it("returns null when POSTHOG_PROJECT_API_KEY is not set", () => {
    delete process.env.POSTHOG_PROJECT_API_KEY;
    const client = getPostHogClient();
    expect(client).toBeNull();
    expect(MockedPostHog).not.toHaveBeenCalled();
  });

  it("creates PostHog instance when key is set", () => {
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test_key";
    const client = getPostHogClient();
    expect(client).not.toBeNull();
    expect(MockedPostHog).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ host: "https://eu.i.posthog.com" }),
    );
  });

  it("uses custom POSTHOG_API_HOST when set", () => {
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test_key";
    process.env.POSTHOG_API_HOST = "https://custom.posthog.com";
    getPostHogClient();
    expect(MockedPostHog).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ host: "https://custom.posthog.com" }),
    );
  });

  it("returns the same instance on multiple calls (singleton)", () => {
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test_key";
    const c1 = getPostHogClient();
    const c2 = getPostHogClient();
    expect(c1).toBe(c2);
    expect(MockedPostHog).toHaveBeenCalledTimes(1);
  });
});
