// tests/phase55/eventRoutes.test.ts
// Phase55: POST /api/events テスト

import express from 'express';
import { request } from "../helpers/testServer";
import { registerEventRoutes } from '../../src/api/events/eventRoutes';

function makeApp(opts: {
  dbError?: Error;
  tenantId?: string;
}) {
  const { tenantId = 'tenant-a' } = opts;
  const app = express();
  app.use(express.json());

  // authMiddleware の代替
  const authMw = (req: any, _res: any, next: any) => {
    req.tenantId = tenantId;
    next();
  };

  const mockDb: any = {
    query: jest.fn().mockImplementation(() => {
      if (opts.dbError) return Promise.reject(opts.dbError);
      return Promise.resolve({ rowCount: 1 });
    }),
  };

  registerEventRoutes(app, [authMw], mockDb);
  return { app, mockDb };
}

const VALID_PAYLOAD = {
  visitor_id: 'vid-001',
  session_id: 'sid-001',
  events: [
    { event_type: 'page_view', page_url: 'https://example.com/', referrer: '' },
    { event_type: 'scroll_depth', event_data: { depth_percent: 50 } },
    { event_type: 'chat_open' },
    { event_type: 'idle_time', event_data: { seconds: 10 } },
    { event_type: 'exit_intent', event_data: { time_on_page_sec: 45 } },
  ],
};

describe('POST /api/events', () => {
  describe('正常系', () => {
    it('5件のイベントバッチ → 202 + accepted:5', async () => {
      const { app, mockDb } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(5);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('1件のみ → 202 + accepted:1', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send({
          visitor_id: 'vid-a',
          session_id: 'sid-a',
          events: [{ event_type: 'chat_conversion' }],
        });

      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(1);
    });

    // PR-B: 「Powered by R2C」バッジのクリック計測。第2の送信経路ではなく、
    // 既存の behavioral_events / POST /api/events をそのまま使う（widget.js の _tracker.track 経由）。
    it('branding_badge_click → 202 + accepted:1（既存 behavioral_events 経路をそのまま使う）', async () => {
      const { app, mockDb } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send({
          visitor_id: 'vid-a',
          session_id: 'sid-a',
          events: [{ event_type: 'branding_badge_click', event_data: { tenant_id: 'tenant-a' } }],
        });

      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(1);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('認証エラー', () => {
    it('tenantId が空 → 401', async () => {
      const { app } = makeApp({ tenantId: '' });
      const res = await request(app)
        .post('/api/events')
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(401);
    });
  });

  describe('バリデーションエラー', () => {
    it('event_type 不正値 → 400', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send({
          visitor_id: 'v',
          session_id: 's',
          events: [{ event_type: 'invalid_type' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('events 配列が空 → 400', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send({ visitor_id: 'v', session_id: 's', events: [] });

      expect(res.status).toBe(400);
    });

    it('events 配列が51件 → 400', async () => {
      const { app } = makeApp({});
      const events = Array.from({ length: 51 }, () => ({ event_type: 'page_view' as const }));
      const res = await request(app)
        .post('/api/events')
        .send({ visitor_id: 'v', session_id: 's', events });

      expect(res.status).toBe(400);
    });

    it('visitor_id 欠如 → 400', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send({ session_id: 's', events: [{ event_type: 'page_view' }] });

      expect(res.status).toBe(400);
    });

    it('session_id 欠如 → 400', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .post('/api/events')
        .send({ visitor_id: 'v', events: [{ event_type: 'page_view' }] });

      expect(res.status).toBe(400);
    });
  });

  describe('DB エラー', () => {
    it('DB接続エラー → 500', async () => {
      const { app } = makeApp({ dbError: new Error('DB error') });
      const res = await request(app)
        .post('/api/events')
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(500);
    });

    it('DB null → 503', async () => {
      const app = express();
      app.use(express.json());
      const authMw = (req: any, _: any, next: any) => { req.tenantId = 't'; next(); };
      registerEventRoutes(app, [authMw], null);

      const res = await request(app).post('/api/events').send(VALID_PAYLOAD);
      expect(res.status).toBe(503);
    });
  });
});

// E3a: お客様がAIの回答を評価する(👍👎)。学習ループの教師信号。
// Judge は 4通未満の会話を評価しないため、1往復で終わる現状ではこれが
// 唯一機能する品質シグナルになる(要件 Rj / 決定 D1)。
describe('POST /api/events — answer_feedback', () => {
  const feedback = (event_data: unknown) => ({
    visitor_id: 'vid-fb',
    session_id: 'sid-fb',
    events: [{ event_type: 'answer_feedback', event_data }],
  });

  it('rating と message_ref が揃っていれば受理し、既存テーブルへ記録する', async () => {
    const { app, mockDb } = makeApp({});
    const res = await request(app).post('/api/events').send(feedback({ rating: 'up', message_ref: 'm-1' }));

    expect(res.status).toBe(202);
    // 新テーブルを作らず behavioral_events に載せる(CLAUDE.md 禁止32)
    const sqls = mockDb.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((q: string) => /INSERT INTO behavioral_events/i.test(q))).toBe(true);
    expect(sqls.some((q: string) => /INSERT INTO answer_feedback/i.test(q))).toBe(false);
  });

  it('👎 も受理する', async () => {
    const { app } = makeApp({});
    const res = await request(app).post('/api/events').send(feedback({ rating: 'down', message_ref: 'm-2' }));
    expect(res.status).toBe(202);
  });

  it('rating が不正なら 400(集計できないデータを受け取らない)', async () => {
    const { app } = makeApp({});
    const res = await request(app).post('/api/events').send(feedback({ rating: 'maybe', message_ref: 'm-3' }));
    expect(res.status).toBe(400);
  });

  it('message_ref が無ければ 400(どの回答への評価か分からない)', async () => {
    const { app } = makeApp({});
    const res = await request(app).post('/api/events').send(feedback({ rating: 'up' }));
    expect(res.status).toBe(400);
  });

  it('event_data が空でも 400 になる', async () => {
    const { app } = makeApp({});
    const res = await request(app).post('/api/events').send(feedback({}));
    expect(res.status).toBe(400);
  });

  it('他のイベント型の event_data 自由形式は従来どおり通る(既存互換を壊さない)', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'vid-x',
        session_id: 'sid-x',
        events: [{ event_type: 'scroll_depth', event_data: { anything: 'goes' } }],
      });
    expect(res.status).toBe(202);
  });

  it('未知のイベント型は従来どおり 400', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/api/events')
      .send({ visitor_id: 'v', session_id: 's', events: [{ event_type: 'not_a_real_event' }] });
    expect(res.status).toBe(400);
  });
});
