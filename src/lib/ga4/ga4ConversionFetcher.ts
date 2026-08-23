import type { Pool } from "pg";
import { createHash } from "crypto";
import { runGa4ConversionReport } from "./ga4Client";
import { logger } from "../logger";
import { recordAndDedupe } from "../posthog/eventIdDedupe";

// conversion_attributions.event_id は UUID 型 + UNIQUE 制約。GA4 の日次集計行は
// 文字列キー(`ga4_${propertyId}_${date}`)しか持たないため、固定の名前空間UUIDから
// 決定的に UUID を生成する(v5)。同じ入力から常に同じ UUID になることで
// ON CONFLICT (event_id) の重複排除(recordAndDedupe)が同期の再実行をまたいで機能する。
//
// npm の `uuid` パッケージ(v13)は ESM only で、jest のデフォルト transform では
// import できない(このファイルを経由する既存の tests/phase-a/ga4SyncRoutesAll.test.ts
// が SyntaxError で落ちる)。jest.config.cjs の transformIgnorePatterns は
// 全テストに影響する共有設定のため、本PRの範囲では変更せず、
// RFC 4122 v5 を Node 標準の crypto だけで実装する(依存追加なし)。
const GA4_EVENT_NAMESPACE = "3022cb2e-ebde-46c3-9de3-55221e7c9bed";

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant (RFC 4122)
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
          eventId: uuidV5(`ga4:${tenantId}:${propertyId}:${row.date}`, GA4_EVENT_NAMESPACE),
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
