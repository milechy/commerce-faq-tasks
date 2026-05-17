// src/api/admin/knowledge/knowledgeRoutesAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2 — knowledge/routes.ts requireKnowledgeRole guard tests

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockDecode = jest.fn();
jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: {
    decode: (...args: unknown[]) => mockDecode(...args),
    verify: jest.fn(),
    sign: jest.fn(),
  },
  decode: (...args: unknown[]) => mockDecode(...args),
  verify: jest.fn(),
  sign: jest.fn(),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../../lib/db', () => ({
  pool: { query: mockQuery },
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../../../agent/llm/groqClient', () => ({
  groqClient: { call: jest.fn().mockResolvedValue('[]') },
}));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0]),
}));
jest.mock('./faqCrudRoutes', () => ({
  registerFaqCrudRoutes: jest.fn(),
}));
jest.mock('./bookPdfRoutes', () => ({
  registerBookPdfRoutes: jest.fn(),
}));
jest.mock('../../../lib/crypto/textEncrypt', () => ({
  encryptText: (s: string) => s,
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerKnowledgeAdminRoutes } from './routes';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

beforeAll(() => {
  process.env['NODE_ENV'] = 'development';
});
afterAll(() => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function makeApp(decoded: Record<string, unknown> | null) {
  mockDecode.mockReturnValue(decoded);
  const app = express();
  app.use(express.json());
  registerKnowledgeAdminRoutes(app);
  return app;
}

const PATH = '/v1/admin/knowledge?tenant=t1';

describe('knowledge — requireKnowledgeRole guard', () => {
  it('viewer → 403 AUTHZ_ROLE_DENIED', async () => {
    const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    expect(logger.warn).toHaveBeenCalled();
  });
  it('stale JWT (user_metadata.role only) → 403 (app_metadata.role missing)', async () => {
    const app = makeApp({ user_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
  });
  it('no app_metadata, top-level role → 403', async () => {
    const app = makeApp({ role: 'super_admin', email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
  });
  it('null decode → 403 anonymous', async () => {
    const app = makeApp(null);
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
  });
  it('super_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).not.toBe(403);
  });
  it('client_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).not.toBe(403);
  });
});
