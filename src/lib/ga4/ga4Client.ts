import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { logger } from "../logger";

export type Ga4ClientStatus = "ok" | "not_configured" | "error";

export interface Ga4CheckResult {
  status: Ga4ClientStatus;
  error?: string;
}

let _client: BetaAnalyticsDataClient | null = null;

function getClient(): BetaAnalyticsDataClient | null {
  if (_client) return _client;

  const credentialsB64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsB64) return null;

  try {
    const json = Buffer.from(credentialsB64, "base64").toString("utf-8");
    const credentials = JSON.parse(json) as Record<string, unknown>;
    _client = new BetaAnalyticsDataClient({ credentials });
    return _client;
  } catch (err) {
    logger.warn({ err }, "[ga4Client] failed to initialize client");
    return null;
  }
}

export async function checkGa4Connection(
  propertyId: string,
): Promise<Ga4CheckResult> {
  const client = getClient();
  if (!client) {
    return { status: "not_configured" };
  }

  try {
    // Minimal request to verify access — last 1 day, 1 dimension, 1 metric
    await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: "1daysAgo", endDate: "today" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }],
      limit: 1,
    });
    return { status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, propertyId }, "[ga4Client] connection check failed");

    if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
      return { status: "error", error: "permission_denied" };
    }
    if (message.includes("NOT_FOUND") || message.includes("404")) {
      return { status: "error", error: "property_not_found" };
    }
    return { status: "error", error: message.slice(0, 200) };
  }
}

export async function runGa4ConversionReport(
  propertyId: string,
  startDate: string,
  endDate: string,
): Promise<{ date: string; conversions: number }[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const [response] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "conversions" }],
    });

    return (response.rows ?? []).map((row) => ({
      date: row.dimensionValues?.[0]?.value ?? "",
      conversions: Number(row.metricValues?.[0]?.value ?? 0),
    }));
  } catch (err) {
    logger.warn({ err, propertyId }, "[ga4Client] runReport failed");
    return [];
  }
}

// Allow resetting client in tests
export function _resetClientForTest(): void {
  _client = null;
}
