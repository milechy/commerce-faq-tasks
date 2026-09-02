// src/api/events/eventRoutes.chatSessionId.test.ts
// 是正0-4(GID 1218086067416577): POST /api/events が chat_session_id
// (widgetのconversationId)を behavioral_events.chat_session_id へ記録することの検証。
// 是正0-3(GID 1218086067477270): chat_reopen が event_type として受理されることの検証。

import express from 'express';
import { request } from "../../../tests/helpers/testServer";
import { registerEventRoutes } from './eventRoutes';

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
import { logger } from '../../lib/logger';

const mockQuery = jest.fn();
const mockDb = { query: mockQuery } as any;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantId = 'carnation';
    next();
  });
  registerEventRoutes(app, [], mockDb);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  (logger.error as jest.Mock).mockClear();
});

describe('POST /api/events — behavioral_events.chat_session_id', () => {
  it('chat_session_id をINSERTの列(source列の次)に載せる', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 's1',
        chat_session_id: 'conv-abc123',
        events: [{ event_type: 'chat_open', event_data: {} }],
      });

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall!;
    expect(sql).toMatch(/\(tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer, source, chat_session_id\)/);
    // 列順: tenant_id, session_id, visitor_id, event_type, event_data, page_url, referrer, source, chat_session_id
    expect(params[8]).toBe('conv-abc123');
  });

  it('chat_session_id 省略時はNULLでINSERTする(会話が無いページのイベント)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 's1',
        events: [{ event_type: 'page_view', event_data: {} }],
      });

    const [, params] = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'))!;
    expect(params[8]).toBeNull();
  });

  it('chat_session_id 列が無い(42703)ときは source列のみで再試行し、202を維持する', async () => {
    mockQuery
      .mockImplementationOnce(() => {
        const err: any = new Error('column "chat_session_id" of relation "behavioral_events" does not exist');
        err.code = '42703';
        return Promise.reject(err);
      })
      .mockResolvedValue({ rows: [] });
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 's1',
        chat_session_id: 'conv-abc123',
        events: [{ event_type: 'chat_open', event_data: {} }],
      });

    expect(res.status).toBe(202);
    const insertCalls = mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO behavioral_events'));
    expect(insertCalls).toHaveLength(2);
    // 2回目はsource列は残るがchat_session_id列は落ちる
    expect(insertCalls[1][0]).toMatch(/source/);
    expect(insertCalls[1][0]).not.toMatch(/chat_session_id/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'carnation' }),
      expect.stringContaining('chat_session_id 列が無い'),
    );
  });

  it('source列もchat_session_id列も無い(42703)ときは旧カラム構成まで一気にフォールバックする', async () => {
    mockQuery
      .mockImplementationOnce(() => {
        const err: any = new Error('column "source" of relation "behavioral_events" does not exist');
        err.code = '42703';
        return Promise.reject(err);
      })
      .mockResolvedValue({ rows: [] });
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 's1',
        chat_session_id: 'conv-abc123',
        events: [{ event_type: 'chat_open', event_data: {} }],
      });

    expect(res.status).toBe(202);
    const insertCalls = mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO behavioral_events'));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[1][0]).not.toMatch(/source/);
    expect(insertCalls[1][0]).not.toMatch(/chat_session_id/);
  });
});

describe('POST /api/events — chat_reopen event_type', () => {
  it('chat_reopen を有効なevent_typeとして受理する', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 's1',
        events: [{ event_type: 'chat_reopen', event_data: {} }],
      });

    expect(res.status).toBe(202);
    const [, params] = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO behavioral_events'))!;
    expect(params[3]).toBe('chat_reopen');
  });
});
