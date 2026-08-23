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
import {
  AUTO_OUTCOME_RECORDED_BY,
  getConversionTypes,
  getSessionOutcome,
  recordOutcome,
} from '../admin/chat-history/chatHistoryRepository';

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
  // GID 1216970103691946 (PR-5): widget の conversationId(chat_sessions.session_id と
  // 同じ値)。behavioral_events.session_id(r2c_sid)とは別物。chat_conversion の
  // conversion_attributions への結合にのみ使う(任意: 会話が無いページでの
  // trackConversion呼び出しでは無いことがある)。
  chat_session_id: z.string().min(1).max(128).optional(),
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

    const { visitor_id, session_id, chat_session_id, events } = parsed.data;

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
      await bridgeConversionEvents(db, tenantId, { chatSessionId: chat_session_id, visitorId: visitor_id }, events);

      return res.status(202).json({ accepted: events.length });
    } catch (err) {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Phase65: chat_conversion → conversion_attributions ブリッジ
// behavioral_events INSERT 後に best-effort で呼び出す。失敗しても202維持。
//
// GID 1216970103691946 (PR-5訂正): 以前は widget の r2c_sid(sessionStorage、
// behavioral_events.session_id と同じ値)を「UUIDの形をしているから」という
// 理由で conversion_attributions.session_id にそのまま入れていたが、集計側は
// 全て chat_sessions.id(内部UUID PK)で結合するため本番実測で0件しか結合
// できていなかった(858/1,148件にsession_idありなのに結合0件)。
// chat_session_id(widgetのconversationId = chat_sessions.session_id)または
// visitor_id(chat_sessions.visitor_id、PR-4で永続化)から chat_sessions.id を
// 解決してから挿入する。どちらでも解決できなければ NULL のまま入れる
// (「形がUUIDだから入れる」をやめる)。
// ---------------------------------------------------------------------------

const VALID_CONVERSION_TYPES = ['purchase', 'inquiry', 'reservation', 'signup', 'other'] as const;
type ConversionType = (typeof VALID_CONVERSION_TYPES)[number];

// GID 1216970103691946 (PR-6): conversion_type(この5値、英語)と
// tenants.conversion_types(テナント定義、既定は日本語)は語彙が全く別。
// 既定のconversion_typesに対応する言葉があるものだけをマッピングする。
// signup/other はテナントの既定選択肢に対応する言葉が無いため意図的に含めない
// (誤った値で自動記録するより、記録しない方が安全)。
const CONVERSION_TYPE_TO_OUTCOME_LABEL: Partial<Record<ConversionType, string>> = {
  purchase: '購入完了',
  reservation: '予約完了',
  inquiry: '問い合わせ送信',
};

type EventInput = z.infer<typeof EventSchema>;

export interface ConversionSessionRef {
  chatSessionId?: string | undefined; // widget の conversationId
  visitorId?: string | undefined;
}

/**
 * chat_session_id(chat_sessions.session_id と一致)を優先して解決し、
 * 見つからなければ visitor_id(同一tenant内で最新のセッション)にフォールバックする。
 * どちらも解決できなければ null を返す(呼び出し元は session_id=NULL で挿入する)。
 */
export async function resolveChatSessionUuid(
  db: Pool,
  tenantId: string,
  ref: ConversionSessionRef,
): Promise<string | null> {
  if (ref.chatSessionId) {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2 LIMIT 1`,
      [tenantId, ref.chatSessionId],
    );
    if (result.rows[0]) return result.rows[0].id;
  }
  // visitor_id は (tenant_id, visitor_id) の複合でのみ使う(テナントを跨いで衝突しうるため)。
  if (ref.visitorId) {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM chat_sessions
       WHERE tenant_id = $1 AND visitor_id = $2
       ORDER BY started_at DESC LIMIT 1`,
      [tenantId, ref.visitorId],
    );
    if (result.rows[0]) return result.rows[0].id;
  }
  return null;
}

/**
 * CV(chat_conversion)発生時に chat_sessions.outcome を自動記録する(best-effort)。
 * - conversion_type がこのテナントの conversion_types に対応する言葉を持たない場合は何もしない
 * - 既にoutcomeが(人手/自動問わず)記録済みなら上書きしない(自動記録は人手の訂正を破壊しない)
 * - 記録は recordedBy=AUTO_OUTCOME_RECORDED_BY で行い、通知を出さない(recordOutcome側で抑止)
 */
export async function autoRecordOutcome(
  tenantId: string,
  sessionDbId: string,
  conversionType: ConversionType,
): Promise<void> {
  const outcomeLabel = CONVERSION_TYPE_TO_OUTCOME_LABEL[conversionType];
  if (!outcomeLabel) return;

  const conversionTypes = await getConversionTypes(tenantId);
  if (!conversionTypes.includes(outcomeLabel)) return;

  const existing = await getSessionOutcome(sessionDbId);
  if (existing?.outcome) return;

  await recordOutcome({
    sessionDbId,
    tenantId,
    outcome: outcomeLabel,
    recordedBy: AUTO_OUTCOME_RECORDED_BY,
  });
}

export async function bridgeConversionEvents(
  db: Pool,
  tenantId: string,
  sessionRef: ConversionSessionRef,
  events: EventInput[],
): Promise<void> {
  const hasConversion = events.some((e) => e.event_type === 'chat_conversion');
  const sessionIdForAttribution = hasConversion
    ? await resolveChatSessionUuid(db, tenantId, sessionRef).catch((err) => {
        logger.warn({ msg: '[events→conversion bridge] session resolve failed', error: (err as Error).message, tenantId });
        return null;
      })
    : null;

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
           (tenant_id, session_id, conversion_type, conversion_value, event_id, created_at)
         VALUES ($1, $2::uuid, $3, $4, gen_random_uuid(), now())`,
        [
          tenantId,
          sessionIdForAttribution,
          conversionType,
          typeof conversionValue === 'number' ? conversionValue : null,
        ],
      );
      logger.info({ msg: '[events→conversion bridge] attributed', tenantId, conversionType, conversionValue });

      // GID 1216970103691946 (PR-6): CV発生時にoutcomeを自動記録する(session解決済みの場合のみ)。
      if (sessionIdForAttribution) {
        await autoRecordOutcome(tenantId, sessionIdForAttribution, conversionType as ConversionType).catch((err) => {
          logger.warn({ msg: '[events→conversion bridge] auto outcome record failed', error: (err as Error).message, tenantId });
        });
      }
    } catch (err) {
      logger.error({ msg: '[events→conversion bridge] insert failed', error: (err as Error).message, tenantId, conversionType });
    }
  }
}
