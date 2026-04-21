import { getPostHogClient } from "./posthogClient";
import { logger } from "../logger";

export interface LlmAnalyticsEvent {
  tenantId: string;
  sessionId: string;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  "groq/compound": { input: 0.0009, output: 0.0009 },
  "groq/compound-mini": { input: 0.0006, output: 0.0006 },
  "llama-3.3-70b-versatile": { input: 0.00059, output: 0.00079 },
  "llama-3.1-8b-instant": { input: 0.00005, output: 0.00008 },
};

function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = COST_PER_1K[model];
  if (!rates) return 0;
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

export function trackLlmGeneration(event: LlmAnalyticsEvent): void {
  const client = getPostHogClient();
  if (!client) return;

  try {
    const costUsd =
      event.inputTokens !== undefined && event.outputTokens !== undefined
        ? estimateCostUsd(event.model, event.inputTokens, event.outputTokens)
        : undefined;

    client.capture({
      distinctId: `tenant:${event.tenantId}`,
      event: "$ai_generation",
      properties: {
        $ai_provider: event.provider,
        $ai_model: event.model,
        $ai_latency: event.latencyMs / 1000,
        ...(event.inputTokens !== undefined && { $ai_input_tokens: event.inputTokens }),
        ...(event.outputTokens !== undefined && { $ai_output_tokens: event.outputTokens }),
        ...(costUsd !== undefined && { $ai_cost: costUsd }),
        tenant_id: event.tenantId,
        session_id: event.sessionId,
      },
    });
  } catch (err) {
    logger.warn({ err }, "[llmAnalyticsTracker] capture failed (non-blocking)");
  }
}
