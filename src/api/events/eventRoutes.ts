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
import { detectGap } from '../../agent/gap/gapDetector';
import { resolveTrafficSource, TRAFFIC_SOURCE_HEADER } from '../../lib/traffic/trafficSource';

const VALID_EVENT_TYPES = [
  'page_view', 'scroll_depth', 'idle_time', 'product_view',
  'exit_intent', 'chat_open', 'chat_message', 'chat_conversion',
  // 「Powered by R2C」バッジのクリック（widget.js）
  'branding_badge_click',
  // AIの回答に対するお客様の評価(👍👎)。学習ループの教師信号。
  // Judge は 4通未満の会話を評価しないため、1往復で終わる現状ではこれが
  // 唯一機能する品質シグナルになる(要件 Rj / 決定 D1)。
  // **新テーブルを作らない**(CLAUDE.md 禁止32)。既存 behavioral_events に載せる。
  'answer_feedback',
  // 是正0-3(GID 1218086067477270): 自動オープン後にユーザーが再度パネルを開いた
  // (=開き直した)ケース。chat_open(離脱率計算の分母)と別名にして、
  // 分母を歪めずに開き直しの回数を計測できるようにする(widget.js参照)。
  'chat_reopen',
] as const;

/** answer_feedback の event_data。どの回答への評価かを識別できる必要がある。 */
const AnswerFeedbackDataSchema = z.object({
  rating: z.enum(['up', 'down']),
  /** 評価対象のAI回答を指す識別子(widget が採番する会話内の連番など)。
   *  同じ回答への評価はこの値で名寄せする。 */
  message_ref: z.string().min(1).max(128),
});

const EventSchema = z.object({
  event_type: z.enum(VALID_EVENT_TYPES),
  event_data: z.record(z.string(), z.unknown()).optional().default({}),
  page_url: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  timestamp: z.string().optional(),
});

// answer_feedback だけは event_data の形を強制する。
// 他イベントは自由形式(既存互換)だが、評価は集計に使うため
// rating/message_ref が無いものを受け取ると後段で数えられなくなる。
const EventSchemaWithFeedback = EventSchema.superRefine((ev, ctx) => {
  if (ev.event_type !== 'answer_feedback') return;
  const parsed = AnswerFeedbackDataSchema.safeParse(ev.event_data);
  if (!parsed.success) {
    ctx.addIssue({
      code: 'custom',
      path: ['event_data'],
      message: 'answer_feedback には rating(up|down)と message_ref が必要です',
    });
  }
});

const EventBatchSchema = z.object({
  visitor_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  // GID 1216970103691946 (PR-5): widget の conversationId(chat_sessions.session_id と
  // 同じ値)。behavioral_events.session_id(r2c_sid)とは別物。chat_conversion の
  // conversion_attributions への結合にのみ使う(任意: 会話が無いページでの
  // trackConversion呼び出しでは無いことがある)。
  chat_session_id: z.string().min(1).max(128).optional(),
  events: z.array(EventSchemaWithFeedback).min(1).max(50),
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

    // LB-8: chat_sessions.metadata.source と同じ判定基準・同じallowlistを流用する
    // (2つ目の基準を作らない)。バッチ内の全イベントは同一リクエストなので同一値になる。
    const trafficSource = resolveTrafficSource({
      headerValue: req.header(TRAFFIC_SOURCE_HEADER),
      userAgent: req.header('user-agent'),
      referer: req.header('referer'),
      isChatTestToken: (req as any).isChatTestToken === true,
    });

    try {
      // バッチINSERT（パラメータ化クエリ）
      const valuePlaceholders: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const e of events) {
        valuePlaceholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );
        values.push(
          tenantId,
          session_id,
          visitor_id,
          e.event_type,
          JSON.stringify(e.event_data ?? {}),
          e.page_url ?? null,
          e.referrer ?? null,
          trafficSource,
          // 是正0-4(GID 1218086067416577): behavioral_events(r2c_sid)とchat_sessions
          // (conversationId)を結合できるキー。任意項目のため無ければNULL。
          chat_session_id ?? null,
        );
      }

      // ★migration未適用でもイベント受信を止めないこと★
      // ここが42703以外の理由で例外を投げると全イベントが記録されず、コード側だけ先に
      // デプロイされた時間帯にトラフィック計測が丸ごと止まる。stripeSync.tsの
      // _insertUsageReportRowと同じパターンで、未適用の列だけフォールバックする。
      // 列リストは source が chat_session_id より左にあるため、両方未適用でも
      // Postgresは先に source を42703として報告する(=下のelse分岐に落ちる)。
      // そのため「chat_session_idだけが無い」ケースをエラーメッセージで見分けられる。
      try {
        await db.query(
          `INSERT INTO behavioral_events
             (tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer, source, chat_session_id)
           VALUES ${valuePlaceholders.join(', ')}`,
          values,
        );
      } catch (err) {
        if ((err as { code?: string })?.code !== '42703') throw err;

        if (/chat_session_id/.test((err as Error).message ?? '')) {
          // 是正0-4: chat_session_id 列のみ未適用。source 列は使えるので保持したまま再試行する。
          logger.error(
            { tenantId },
            '[events] behavioral_events に chat_session_id 列が無い — ' +
            'migration_behavioral_events_chat_session_id.sql が未適用。source列のみで継続するが、' +
            'この期間のイベントはchat_sessionsと結合できない。至急 migration を適用すること',
          );
          const sourceOnlyPlaceholders: string[] = [];
          const sourceOnlyValues: unknown[] = [];
          let sourceOnlyIdx = 1;
          for (const e of events) {
            sourceOnlyPlaceholders.push(
              `($${sourceOnlyIdx++}, $${sourceOnlyIdx++}, $${sourceOnlyIdx++}, $${sourceOnlyIdx++}, $${sourceOnlyIdx++}, $${sourceOnlyIdx++}, $${sourceOnlyIdx++}, $${sourceOnlyIdx++})`
            );
            sourceOnlyValues.push(
              tenantId, session_id, visitor_id, e.event_type,
              JSON.stringify(e.event_data ?? {}), e.page_url ?? null, e.referrer ?? null,
              trafficSource,
            );
          }
          await db.query(
            `INSERT INTO behavioral_events
               (tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer, source)
             VALUES ${sourceOnlyPlaceholders.join(', ')}`,
            sourceOnlyValues,
          );
        } else {
          // source(と、場合によってはchat_session_idも)が未適用。旧カラム構成にフォールバックする。
          logger.error(
            { tenantId },
            '[events] behavioral_events に source 列が無い — migration_behavioral_events_source.sql が未適用。' +
            '旧カラムで継続するが、この期間のイベントはtraffic source(e2e/demo等)を除外できない。至急 migration を適用すること',
          );
          const legacyPlaceholders: string[] = [];
          const legacyValues: unknown[] = [];
          let legacyIdx = 1;
          for (const e of events) {
            legacyPlaceholders.push(
              `($${legacyIdx++}, $${legacyIdx++}, $${legacyIdx++}, $${legacyIdx++}, $${legacyIdx++}, $${legacyIdx++}, $${legacyIdx++})`
            );
            legacyValues.push(
              tenantId, session_id, visitor_id, e.event_type,
              JSON.stringify(e.event_data ?? {}), e.page_url ?? null, e.referrer ?? null,
            );
          }
          await db.query(
            `INSERT INTO behavioral_events
               (tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer)
             VALUES ${legacyPlaceholders.join(', ')}`,
            legacyValues,
          );
        }
      }

      // Phase65: chat_conversion イベントを conversion_attributions にブリッジ (best-effort)
      await bridgeConversionEvents(db, tenantId, { chatSessionId: chat_session_id, visitorId: visitor_id }, events);

      // ナレッジ配線是正P14: answer_feedback(👎)をギャップ検出に橋渡しする (best-effort)
      await bridgeAnswerFeedbackToGaps(db, tenantId, { chatSessionId: chat_session_id, visitorId: visitor_id }, events);

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

// ---------------------------------------------------------------------------
// ナレッジ配線是正P14: answer_feedback(👎) → knowledge_gaps ブリッジ
// behavioral_events INSERT 後に best-effort で呼び出す。失敗しても202維持。
//
// widget の message_ref はクライアント側で生成される乱数ID
// (generateMsgId、'msg-<timestamp>-<random>')で、サーバ側の chat_messages と
// 直接ひも付く仕組みが無い。そのため「どの回答への評価か」を厳密に特定できず、
// 近似としてそのセッションで直前にあった実ユーザーの発話を対象質問とする
// (会話を遡って過去の回答に👎を付けるケースでは不正確になりうるが、
// 唯一機能する消費者品質信号を起票に繋げることを優先する)。
// ---------------------------------------------------------------------------

export async function bridgeAnswerFeedbackToGaps(
  db: Pool,
  tenantId: string,
  sessionRef: ConversionSessionRef,
  events: EventInput[],
): Promise<void> {
  const negativeFeedbacks = events.filter(
    (e) => e.event_type === 'answer_feedback' && (e.event_data as Record<string, unknown>)?.['rating'] === 'down',
  );
  if (negativeFeedbacks.length === 0) return;

  const sessionDbId = await resolveChatSessionUuid(db, tenantId, sessionRef).catch((err) => {
    logger.warn({ msg: '[events→gap bridge] session resolve failed', error: (err as Error).message, tenantId });
    return null;
  });
  if (!sessionDbId) return;

  try {
    const lastUserMessage = await db.query<{ content: string }>(
      `SELECT content FROM chat_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionDbId],
    );
    const userMessage = lastUserMessage.rows[0]?.content?.trim();
    if (!userMessage) return;

    // 1回のイベントバッチに複数の👎が含まれても、同一セッション・同一質問の
    // 起票は detectGap 内の7日以内ILIKE一致で1件に集約される(重複起票にならない)。
    for (const _feedback of negativeFeedbacks) {
      await detectGap({
        tenantId,
        sessionId: sessionDbId,
        userMessage,
        ragResultCount: 0, // user_negative は最優先で判定されるためこの値は使われない
        userNegativeFeedback: true,
      }).catch((err) => {
        logger.warn({ msg: '[events→gap bridge] detectGap failed', error: (err as Error).message, tenantId });
      });
    }
  } catch (err) {
    logger.warn({ msg: '[events→gap bridge] message lookup failed', error: (err as Error).message, tenantId });
  }
}
