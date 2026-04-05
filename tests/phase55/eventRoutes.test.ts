// tests/phase55/eventRoutes.test.ts
// Phase55: POST /api/events テスト

import express from 'express';
import request from 'supertest';
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
