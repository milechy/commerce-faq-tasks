import type { Pool } from "pg";
import { logger } from "../logger";

export type EventSource = "r2c_db" | "ga4" | "posthog";
export type EventRank = "A" | "B" | "C" | "D";
// conversion_attributions.conversion_type の CHECK 制約
// (src/api/conversion/migration_conversion_attributions.sql) と一致させる。
export type ConversionType = "purchase" | "inquiry" | "reservation" | "signup" | "other";

export interface DedupeInput {
  // conversion_attributions.event_id は UUID 型 + UNIQUE 制約
  // (src/api/admin/tenants/migration_phase_a.sql)。UUID 形式でない値を渡すと
  // INSERT が失敗する。
  eventId: string;
  tenantId: string;
  source: EventSource;
  // conversion_type は NOT NULL CHECK 制約があり省略できない。
  // 具体的な種別が分からない呼び出し元は "other" を明示的に渡すこと。
  conversionType: ConversionType;
  eventType?: string;
  conversionValue?: number;
}

export interface DedupeResult {
  isDuplicate: boolean;
  rank: EventRank;
  sourceCount: number;
}

export async function recordAndDedupe(
  input: DedupeInput,
  db: Pool,
): Promise<DedupeResult> {
  try {
    await db.query(
      `INSERT INTO conversion_attributions
         (event_id, tenant_id, source, event_type, conversion_type, conversion_value, deduplicated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (event_id) DO UPDATE
         SET fired_count = conversion_attributions.fired_count + 1,
             deduplicated_at = NOW()`,
      [
        input.eventId,
        input.tenantId,
        input.source,
        input.eventType ?? "macro",
        input.conversionType,
        input.conversionValue ?? null,
      ],
    );

    const countRow = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT source)::text AS cnt FROM conversion_attributions WHERE event_id = $1`,
      [input.eventId],
    );
    const sourceCount = parseInt(countRow.rows[0]?.cnt ?? "1", 10);

    const isDuplicate = sourceCount > 1;
    const rank = computeRank(input, sourceCount);

    await db.query(
      `UPDATE conversion_attributions SET rank = $1 WHERE event_id = $2`,
      [rank, input.eventId],
    );

    return { isDuplicate, rank, sourceCount };
  } catch (err) {
    logger.warn({ err, eventId: input.eventId }, "[eventIdDedupe] failed (non-blocking)");
    return { isDuplicate: false, rank: "C", sourceCount: 1 };
  }
}

function computeRank(input: DedupeInput, sourceCount: number): EventRank {
  if (sourceCount >= 3) return "A";
  if (sourceCount === 2) return "B";
  if (
    input.conversionValue !== undefined &&
    input.conversionValue < 0
  ) return "D";
  return "C";
}
