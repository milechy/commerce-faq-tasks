// src/api/events/eventRoutes.ts
// Phase55: 行動イベント受信API
//
// POST /api/events
//   認証: x-api-key（apiStack経由）
//   レスポンス: 202 Accepted
//   バリデーション: event_type enum, events配列1-50件, visitor_id/session_id必須

import type { Express, Request, Response } from 'express';
// @ts-ignore - pg has no bundled type declarations in this project
import type { Pool } from 'pg';
import { z } from 'zod';

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
  apiStack: any[],
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

      return res.status(202).json({ accepted: events.length });
    } catch (err) {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
