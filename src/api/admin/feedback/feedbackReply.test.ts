// src/api/admin/feedback/feedbackReply.test.ts
// 相談窓口(返信)機能: POST /:id/reply, PATCH /:id/read, GET のフィールドwhitelistの回帰テスト

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  pool: {},
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const mockCreateNotification = jest.fn();
jest.mock('../../../lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  notificationExists: jest.fn(),
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { registerAdminFeedbackManagementRoutes } from './routes';

function makeApp(appMetadata: Record<string, unknown> | null, email = 'actor@test.com') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata, email } : null;
    next();
  });
  registerAdminFeedbackManagementRoutes(app);
  return app;
}

const SUPER_ADMIN = { role: 'super_admin' };
const CLIENT_ADMIN_A = { role: 'client_admin', tenant_id: 'tenant-a' };

beforeEach(() => {
  mockQuery.mockReset();
  mockCreateNotification.mockReset();
});

describe('POST /v1/admin/feedback/:id/reply', () => {
  it('super_admin が返信すると reply_body/replied_at/replied_by_email が更新され、reply_read_at は NULL に戻る', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fb-1', tenant_id: 'tenant-a', reply_body: '設定ページから変更できます', replied_at: '2026-07-28T00:00:00Z' }],
    });

    const res = await request(makeApp(SUPER_ADMIN, 'staff@r2c.example'))
      .post('/v1/admin/feedback/fb-1/reply')
      .send({ reply_body: '設定ページから変更できます' });

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('reply_read_at = NULL'),
      ['設定ページから変更できます', 'staff@r2c.example', 'fb-1']
    );
    expect(res.body.reply_body).toBe('設定ページから変更できます');
  });

  it('返信するとテナントの client_admin へ通知が作られる', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fb-1', tenant_id: 'tenant-a' }] });

    await request(makeApp(SUPER_ADMIN)).post('/v1/admin/feedback/fb-1/reply').send({ reply_body: 'ok' });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: 'client_admin',
        recipientTenantId: 'tenant-a',
        type: 'feedback_replied',
      })
    );
  });

  it('存在しないIDへの返信は404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp(SUPER_ADMIN)).post('/v1/admin/feedback/missing/reply').send({ reply_body: 'ok' });

    expect(res.status).toBe(404);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('reply_body が空文字だと400', async () => {
    const res = await request(makeApp(SUPER_ADMIN)).post('/v1/admin/feedback/fb-1/reply').send({ reply_body: '' });
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('client_admin は返信できない(403)', async () => {
    const res = await request(makeApp(CLIENT_ADMIN_A)).post('/v1/admin/feedback/fb-1/reply').send({ reply_body: 'ok' });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/admin/feedback/:id/read', () => {
  it('client_admin の既読化は自テナント条件付きでUPDATEする', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fb-1', reply_read_at: '2026-07-28T00:00:00Z' }] });

    const res = await request(makeApp(CLIENT_ADMIN_A)).patch('/v1/admin/feedback/fb-1/read');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND tenant_id = $2'),
      ['fb-1', 'tenant-a']
    );
  });

  it('他テナントの行は0件ヒットのため404になる(越境既読化を防止)', async () => {
    // tenant_id 条件がSQL側に入っているため、他テナントの行はUPDATE対象0件でrows=[]が返る
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp(CLIENT_ADMIN_A)).patch('/v1/admin/feedback/other-tenant-fb/read');

    expect(res.status).toBe(404);
  });

  it('super_admin はテナント条件なしでUPDATEできる', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fb-1', reply_read_at: '2026-07-28T00:00:00Z' }] });

    const res = await request(makeApp(SUPER_ADMIN)).patch('/v1/admin/feedback/fb-1/read');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.not.stringContaining('tenant_id'), ['fb-1']);
  });
});

describe('GET /v1/admin/feedback — client_admin フィールドwhitelist', () => {
  const FULL_ROW = {
    id: 'fb-1',
    tenant_id: 'tenant-a',
    user_email: 'user@tenant-a.example',
    message: '送料について',
    ai_response: '550円です',
    ai_answered: true,
    status: 'new',
    category: 'other',
    priority: 'high',
    admin_notes: '社内向けメモ：VIP対応',
    linked_knowledge_gap_id: null,
    reply_body: null,
    replied_at: null,
    replied_by_email: null,
    reply_read_at: null,
    parent_feedback_id: null,
    created_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-28T00:00:00Z',
  };

  it('client_admin には admin_notes/priority/status が含まれない', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [FULL_ROW] });

    const res = await request(makeApp(CLIENT_ADMIN_A)).get('/v1/admin/feedback');

    expect(res.status).toBe(200);
    expect(res.body.items[0]).not.toHaveProperty('admin_notes');
    expect(res.body.items[0]).not.toHaveProperty('priority');
    expect(res.body.items[0]).not.toHaveProperty('status');
    expect(res.body.items[0]).not.toHaveProperty('user_email');
    expect(res.body.items[0]).toMatchObject({
      id: 'fb-1',
      message: '送料について',
      ai_response: '550円です',
      reply_body: null,
    });
  });

  it('super_admin には全フィールドが返る', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [FULL_ROW] });

    const res = await request(makeApp(SUPER_ADMIN)).get('/v1/admin/feedback');

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toHaveProperty('admin_notes', '社内向けメモ：VIP対応');
    expect(res.body.items[0]).toHaveProperty('priority', 'high');
  });

  it('tenant_id を持たない client_admin は403（他テナント全件露出を防止）', async () => {
    const res = await request(makeApp({ role: 'client_admin' })).get('/v1/admin/feedback');
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('unread=true でSQLに未読条件が入る', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp(CLIENT_ADMIN_A)).get('/v1/admin/feedback?unread=true');

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('reply_body IS NOT NULL AND reply_read_at IS NULL'),
      expect.anything()
    );
  });
});
