// src/api/admin/knowledge-gaps/knowledgeGapsAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2

jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => null,
}));
jest.mock('pino', () => () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('../tenants/superAdminMiddleware', () => ({
  superAdminMiddleware: (req: any, res: any, next: any) => {
    const role = req.supabaseUser?.app_metadata?.role;
    if (role !== 'super_admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  },
}));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0]),
}));
jest.mock('../../../agent/gap/gapRecommender', () => ({
  generateRecommendations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn().mockResolvedValue('test'),
}));

import express from 'express';
import request from 'supertest';
import { registerKnowledgeGapPhase46Routes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerKnowledgeGapPhase46Routes(app);
  return app;
}

const ROUTES = [
  { method: 'get' as const, path: '/v1/admin/knowledge-gaps' },
  { method: 'patch' as const, path: '/v1/admin/knowledge-gaps/123' },
  { method: 'post' as const, path: '/v1/admin/knowledge-gaps/123/add-knowledge' },
  { method: 'post' as const, path: '/v1/admin/knowledge-gaps/123/suggest-answer' },
];

beforeEach(() => { jest.clearAllMocks(); });

describe('knowledge-gaps Phase46 — ALLOWED_ROLES whitelist', () => {
  ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ action: 'approve', answer_text: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    });
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ action: 'approve', answer_text: 'x' });
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path).send({ action: 'approve', answer_text: 'x' });
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ action: 'approve', answer_text: 'x' });
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ action: 'approve', answer_text: 'x' });
      expect(res.status).not.toBe(403);
    });
  });
});

describe('knowledge-gaps generate-recommendations (super_admin only via middleware)', () => {
  it('viewer → 403', async () => {
    const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).post('/v1/admin/knowledge-gaps/generate-recommendations').send({ tenant_id: 't1' });
    expect(res.status).toBe(403);
  });
  it('client_admin → 403', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).post('/v1/admin/knowledge-gaps/generate-recommendations').send({ tenant_id: 't1' });
    expect(res.status).toBe(403);
  });
  it('super_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).post('/v1/admin/knowledge-gaps/generate-recommendations').send({ tenant_id: 't1' });
    expect(res.status).not.toBe(403);
  });
});
