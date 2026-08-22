import { getPostHogClient } from "./posthogClient";
import { logger } from "../logger";
import {
  GROQ_COMPOUND,
  GROQ_COMPOUND_MINI,
  GPT_OSS_120B,
  GPT_OSS_20B,
} from "../../config/groqModels";

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
  [GROQ_COMPOUND]: { input: 0.0009, output: 0.0009 },
  [GROQ_COMPOUND_MINI]: { input: 0.0006, output: 0.0006 },
  // 単価は src/lib/billing/costCalculator.ts (per 1M) を per 1K に換算した値。
  // 旧 llama-3.3-70b / llama-3.1-8b の 2 行は配信停止に伴い gpt-oss へ集約した。
  [GPT_OSS_120B]: { input: 0.00015, output: 0.0006 },
  [GPT_OSS_20B]: { input: 0.000075, output: 0.0003 },
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
