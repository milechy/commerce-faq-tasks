// src/api/events/eventRoutes.ts
// Phase55: 行動イベント受信API
//
// POST /api/events
//   認証: x-api-key（apiStack経由）
//   レスポンス: 202 Accepted
//   バリデーション: event_type enum, events配列1-50件, visitor_id/session_id必須

import type { Express, Request, Response, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { logger } from '../../lib/logger';

const VALID_EVENT_TYPES = [
  'page_view', 'scroll_depth', 'idle_time', 'product_view',
  'exit_intent', 'chat_open', 'chat_message', 'chat_conversion',
] as const;

const EventSchema = z.object({
  event_type: z.enum(VALID_EVENT_TYPES),
  event_data: z.record(z.string(), z.unknown()).optional().default({}),
  page_url: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  timestamp: z.string().optional(),
});

const EventBatchSchema = z.object({
  visitor_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  events: z.array(EventSchema).min(1).max(50),
});

export function registerEventRoutes(
  app: Express,
  apiStack: RequestHandler[],
  db: Pool | null,
): void {
  app.post('/api/events', ...apiStack, async (req: Request, res: Response) => {
    const tenantId: string = (req as any).tenantId ?? '';
    if (!tenantId) {
      return res.status(401).json({ error: 'tenant_not_found' });
    }

    const parsed = EventBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    if (!db) {
      return res.status(503).json({ error: 'database_unavailable' });
    }

    const { visitor_id, session_id, events } = parsed.data;

    try {
      // バッチINSERT（パラメータ化クエリ）
      const valuePlaceholders: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const e of events) {
        valuePlaceholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );
        values.push(
          tenantId,
          session_id,
          visitor_id,
          e.event_type,
          JSON.stringify(e.event_data ?? {}),
          e.page_url ?? null,
          e.referrer ?? null,
        );
      }

      await db.query(
        `INSERT INTO behavioral_events
           (tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer)
         VALUES ${valuePlaceholders.join(', ')}`,
        values,
      );

      // Phase65: chat_conversion イベントを conversion_attributions にブリッジ (best-effort)
      await bridgeConversionEvents(db, tenantId, session_id, events);

      return res.status(202).json({ accepted: events.length });
    } catch (err) {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Phase65: chat_conversion → conversion_attributions ブリッジ
// behavioral_events INSERT 後に best-effort で呼び出す。失敗しても202維持。
// ---------------------------------------------------------------------------

const VALID_CONVERSION_TYPES = ['purchase', 'inquiry', 'reservation', 'signup', 'other'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventInput = z.infer<typeof EventSchema>;

export async function bridgeConversionEvents(
  db: Pool,
  tenantId: string,
  sessionId: string,
  events: EventInput[],
): Promise<void> {
  const sessionIdForAttribution = UUID_PATTERN.test(sessionId) ? sessionId : null;

  for (const event of events) {
    if (event.event_type !== 'chat_conversion') continue;

    const conversionType = (event.event_data as Record<string, unknown>)?.conversion_type;
    const conversionValue = (event.event_data as Record<string, unknown>)?.conversion_value;

    if (!VALID_CONVERSION_TYPES.includes(conversionType as (typeof VALID_CONVERSION_TYPES)[number])) {
      logger.warn({ msg: '[events→conversion bridge] invalid conversion_type', conversionType });
      continue;
    }

    try {
      await db.query(
        `INSERT INTO conversion_attributions
           (tenant_id, session_id, conversion_type, conversion_value, created_at)
         VALUES ($1, $2::uuid, $3, $4, now())`,
        [
          tenantId,
          sessionIdForAttribution,
          conversionType,
          typeof conversionValue === 'number' ? conversionValue : null,
        ],
      );
      logger.info({ msg: '[events→conversion bridge] attributed', tenantId, conversionType, conversionValue });
    } catch (err) {
      logger.error({ msg: '[events→conversion bridge] insert failed', error: (err as Error).message, tenantId, conversionType });
    }
  }
}
