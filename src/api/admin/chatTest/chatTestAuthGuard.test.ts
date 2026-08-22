// src/api/admin/chatTest/chatTestAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// このテストはロール判定(isAllowedChatTestRole)のみを検証する対象なので、
// 共有JWT検証(src/admin/http/supabaseAuthMiddleware.ts)はスルーさせ、
// makeApp() が注入する req.supabaseUser をそのまま下流に渡す。
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerChatTestRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (user) {
      (req as any).supabaseUser = user;
    }
    next();
  });
  registerChatTestRoutes(app);
  return app;
}

const PATH = '/v1/admin/chat-test/token?tenantId=t1';

beforeEach(() => { jest.clearAllMocks(); });

describe('chat-test — ALLOWED_ROLES whitelist', () => {
  it('viewer → 403', async () => {
    const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    expect(logger.warn).toHaveBeenCalled();
  });
  it('stale JWT (user_metadata.role only) → 403', async () => {
    const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
  });
  it('top-level role only → 403 (no app_metadata)', async () => {
    const app = makeApp({ role: 'super_admin', email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
  });
  it('no user → 403', async () => {
    const app = makeApp(null);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
  });
  it('super_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).not.toBe(403);
  });
  it('client_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).not.toBe(403);
  });
});
