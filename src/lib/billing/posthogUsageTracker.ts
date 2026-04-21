import { logger } from "../logger";

export interface MonthlyLlmUsage {
  tenantId: string;
  month: string;
  totalGenerations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  source: "posthog";
}

export async function getMonthlyLLMUsageFromPostHog(
  tenantId: string,
  month: string,
): Promise<MonthlyLlmUsage | null> {
  const apiKey = process.env.POSTHOG_PROJECT_API_KEY;
  const apiHost = process.env.POSTHOG_API_HOST ?? "https://eu.i.posthog.com";

  if (!apiKey) {
    logger.warn("[posthogUsageTracker] POSTHOG_PROJECT_API_KEY not set");
    return null;
  }

  const [year, monthNum] = month.split("-").map(Number);
  const startDate = new Date(year, monthNum - 1, 1).toISOString().split("T")[0];
  const endDate = new Date(year, monthNum, 0).toISOString().split("T")[0];

  try {
    const query = {
      kind: "HogQLQuery",
      query: `
        SELECT
          count() AS total_generations,
          sum(properties.\$ai_input_tokens) AS total_input_tokens,
          sum(properties.\$ai_output_tokens) AS total_output_tokens,
          sum(properties.\$ai_cost) AS estimated_cost_usd
        FROM events
        WHERE event = '\$ai_generation'
          AND properties.tenant_id = '${tenantId.replace(/'/g, "''")}'
          AND timestamp >= '${startDate}'
          AND timestamp <= '${endDate}'
      `.trim(),
    };

    const res = await fetch(`${apiHost}/api/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "[posthogUsageTracker] query failed");
      return null;
    }

    const data = (await res.json()) as {
      results?: Array<[number, number, number, number]>;
    };
    const row = data.results?.[0];
    if (!row) return null;

    return {
      tenantId,
      month,
      totalGenerations: row[0] ?? 0,
      totalInputTokens: row[1] ?? 0,
      totalOutputTokens: row[2] ?? 0,
      estimatedCostUsd: row[3] ?? 0,
      source: "posthog",
    };
  } catch (err) {
    logger.warn({ err, tenantId, month }, "[posthogUsageTracker] fetch error");
    return null;
  }
}
