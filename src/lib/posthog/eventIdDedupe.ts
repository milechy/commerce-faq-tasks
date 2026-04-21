import type { Pool } from "pg";
import { logger } from "../logger";

export type EventSource = "r2c_db" | "ga4" | "posthog";
export type EventRank = "A" | "B" | "C" | "D";

export interface DedupeInput {
  eventId: string;
  tenantId: string;
  source: EventSource;
  eventType?: string;
  conversionValue?: number;
  metadataJson?: string;
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
         (event_id, tenant_id, source, event_type, conversion_value, metadata, deduplicated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (event_id) DO UPDATE
         SET fired_count = conversion_attributions.fired_count + 1,
             deduplicated_at = NOW()`,
      [
        input.eventId,
        input.tenantId,
        input.source,
        input.eventType ?? "macro",
        input.conversionValue ?? null,
        input.metadataJson ?? null,
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
