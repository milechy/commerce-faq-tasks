import type { Pool } from "pg";
import { runGa4ConversionReport } from "./ga4Client";
import { logger } from "../logger";

export interface Ga4ConversionSummary {
  propertyId: string;
  startDate: string;
  endDate: string;
  totalConversions: number;
  byDate: { date: string; conversions: number }[];
}

export async function fetchGa4Conversions(
  tenantId: string,
  propertyId: string,
  startDate: string,
  endDate: string,
  db: Pool,
): Promise<Ga4ConversionSummary | null> {
  try {
    const rows = await runGa4ConversionReport(propertyId, startDate, endDate);
    const totalConversions = rows.reduce((sum, r) => sum + r.conversions, 0);

    // Update last sync timestamp
    await db.query(
      `UPDATE tenants SET ga4_last_sync_at = NOW() WHERE id = $1`,
      [tenantId],
    );

    await db.query(
      `INSERT INTO ga4_connection_logs
         (tenant_id, action, status, message, metadata, triggered_by)
       VALUES ($1, 'sync_completed', 'success', $2, $3, 'cron')`,
      [
        tenantId,
        `Fetched ${totalConversions} conversions`,
        JSON.stringify({ startDate, endDate, rows: rows.length }),
      ],
    );

    return { propertyId, startDate, endDate, totalConversions, byDate: rows };
  } catch (err) {
    logger.warn({ err, tenantId, propertyId }, "[ga4ConversionFetcher] fetch failed");

    await db.query(
      `INSERT INTO ga4_connection_logs
         (tenant_id, action, status, message, triggered_by)
       VALUES ($1, 'sync_failed', 'failure', $2, 'cron')`,
      [tenantId, err instanceof Error ? err.message.slice(0, 200) : "unknown"],
    ).catch(() => undefined);

    return null;
  }
}
