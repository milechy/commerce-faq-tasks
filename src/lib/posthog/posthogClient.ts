import { PostHog } from "posthog-node";
import { logger } from "../logger";

let _client: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  const key = process.env.POSTHOG_PROJECT_API_KEY;
  if (!key) return null;

  if (!_client) {
    const host = process.env.POSTHOG_API_HOST ?? "https://eu.i.posthog.com";
    _client = new PostHog(key, { host, flushAt: 20, flushInterval: 10_000 });
    logger.info({ host }, "[posthog] client initialized");
  }
  return _client;
}

export async function flushPostHog(): Promise<void> {
  if (_client) {
    await _client.flush();
  }
}

export function _resetPostHogClientForTest(): void {
  if (_client) {
    _client.shutdown().catch(() => undefined);
    _client = null;
  }
}
