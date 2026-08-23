import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import { runGa4ConversionReport } from "./ga4Client";
import { logger } from "../logger";
import { recordAndDedupe } from "../posthog/eventIdDedupe";

// conversion_attributions.event_id は UUID 型 + UNIQUE 制約。GA4 の日次集計行は
// 文字列キー(`ga4_${propertyId}_${date}`)しか持たないため、固定の名前空間UUIDから
// 決定的に UUID を生成する(v5)。同じ入力から常に同じ UUID になることで
// ON CONFLICT (event_id) の重複排除(recordAndDedupe)が同期の再実行をまたいで機能する。
const GA4_EVENT_NAMESPACE = "3022cb2e-ebde-46c3-9de3-55221e7c9bed";

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

    // conversion_attributions に GA4 コンバージョンを記録（重複排除付き）
    for (const row of rows) {
      await recordAndDedupe(
        {
          eventId: uuidv5(`ga4:${tenantId}:${propertyId}:${row.date}`, GA4_EVENT_NAMESPACE),
          tenantId,
          source: "ga4",
          eventType: "macro",
          // GA4 の集計コンバージョン数には購入/問い合わせ等の内訳が無いため "other"
          conversionType: "other",
          conversionValue: row.conversions,
        },
        db,
      );
    }

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
