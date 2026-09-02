// src/api/events/eventRoutes.trafficSource.test.ts
// LB-8(2026-08-29): POST /api/events が behavioral_events.source を
// chat_sessions.metadata.source と同じ判定基準(resolveTrafficSource)で記録することの検証。

import express from 'express';
import { request } from "../../../tests/helpers/testServer";
import { registerEventRoutes } from './eventRoutes';

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
import { logger } from '../../lib/logger';

const mockQuery = jest.fn();
const mockDb = { query: mockQuery } as any;

function makeApp(opts: { isChatTestToken?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantId = 'carnation';
    if (opts.isChatTestToken) req.isChatTestToken = true;
    next();
  });
  registerEventRoutes(app, [], mockDb);
  return app;
}

const VALID_BODY = {
  visitor_id: 'v1',
  session_id: 's1',
  events: [{ event_type: 'chat_open', event_data: {} }],
};

beforeEach(() => {
  mockQuery.mockReset();
  (logger.error as jest.Mock).mockClear();
});

describe('POST /api/events — behavioral_events.source', () => {
  it('Playwright(HeadlessChrome UA)経由はsource=e2eでINSERTする', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .post('/api/events')
      .set('User-Agent', 'Mozilla/5.0 HeadlessChrome/120.0')
      .send(VALID_BODY);

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall!;
    expect(sql).toMatch(/\(tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer, source, chat_session_id\)/);
    // 列順: tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer, source, chat_session_id
    expect(params[7]).toBe('e2e');
  });

  it('chat-testトークンはsource=chat_testでINSERTする', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp({ isChatTestToken: true });
    await request(app).post('/api/events').send(VALID_BODY);

    const [, params] = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'))!;
    expect(params[7]).toBe('chat_test');
  });

  it('carnation-demo参照元はsource=demoでINSERTする', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .post('/api/events')
      .set('Referer', 'https://example.com/carnation-demo')
      .send(VALID_BODY);

    const [, params] = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'))!;
    expect(params[7]).toBe('demo');
  });

  it('通常ブラウザからの実訪問者はsource=userでINSERTする', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .post('/api/events')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
      .send(VALID_BODY);

    const [, params] = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'))!;
    expect(params[7]).toBe('user');
  });

  it('source列が無い(42703)ときは旧カラム構成にフォールカバックし、202を維持する', async () => {
    mockQuery
      .mockImplementationOnce(() => {
        const err: any = new Error('column "source" of relation "behavioral_events" does not exist');
        err.code = '42703';
        return Promise.reject(err);
      })
      .mockResolvedValue({ rows: [] });
    const app = makeApp();
    const res = await request(app).post('/api/events').send(VALID_BODY);

    expect(res.status).toBe(202);
    // 1回目(source付き, 失敗) + 2回目(旧カラム, 成功)の計2回INSERTが試みられる
    const insertCalls = mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO behavioral_events'));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[1][0]).not.toMatch(/source/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'carnation' }),
      expect.stringContaining('source 列が無い'),
    );
  });

  it('42703以外のDBエラーはそのまま投げ、旧カラムへは切り替えない(記録の消失を隠さない)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));
    const app = makeApp();
    const res = await request(app).post('/api/events').send(VALID_BODY);

    expect(res.status).toBe(500);
    const insertCalls = mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO behavioral_events'));
    expect(insertCalls).toHaveLength(1);
  });
});
