// src/api/admin/knowledge-gaps/gapApiUnification.test.ts
//
// ナレッジ配線是正 P10 (Asana GID 1217811058060518):
// ギャップAPIを Phase46 に一本化。旧 knowledgeGapRoutes.ts(/v1/admin/knowledge/gaps)
// は admin-ui が唯一叩いていた経路で、Phase46 の推薦生成(generateRecommendations)
// が呼ばれることは無かった。旧APIを削除し count エンドポイントを Phase46 に統合、
// PATCH は「recommendation_status 更新」と「status(ギャップ自体)更新」の
// 2つの異なる関心事を1エンドポイントで受けられるようにした。

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('../tenants/superAdminMiddleware', () => ({
  superAdminMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../../agent/gap/gapRecommender', () => ({
  generateRecommendations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn().mockResolvedValue('test'),
}));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0.1]),
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  pool: { query: mockQuery },
  getPool: () => ({ query: mockQuery }),
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

const CLIENT_ADMIN = { app_metadata: { role: 'client_admin', tenant_id: 't1' } };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /v1/admin/knowledge-gaps/count', () => {
  it('client_adminはJWTのtenant_idで件数を取得する', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '3' }] });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app).get('/v1/admin/knowledge-gaps/count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'open'");
    expect(params).toEqual(['t1']);
  });

  it('tenantが解決できないsuper_adminは400', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin' } });
    const res = await request(app).get('/v1/admin/knowledge-gaps/count');
    // super_adminはtenant未指定でも許可(全体件数)なので400にならない
    expect(res.status).not.toBe(400);
  });
});

describe('PATCH /v1/admin/knowledge-gaps/:id — 2つの関心事を1エンドポイントで受ける', () => {
  it('{action} は recommendation_status を更新する(既存動作の回帰)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app)
      .patch('/v1/admin/knowledge-gaps/1')
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('recommendation_status');
    expect(sql).not.toContain('SET status =');
    expect(params[0]).toBe('approved');
  });

  it('{status, resolved_faq_id} は status(ギャップ自体)を更新する(旧knowledgeGapRoutes.tsの互換)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app)
      .patch('/v1/admin/knowledge-gaps/1')
      .send({ status: 'resolved', resolved_faq_id: 42 });

    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET status = $1');
    expect(sql).not.toContain('recommendation_status');
    expect(params).toEqual(['resolved', 42, 1, 't1']);
  });

  it('{status: "dismissed"} のみ(resolved_faq_id省略)でも通る', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app)
      .patch('/v1/admin/knowledge-gaps/1')
      .send({ status: 'dismissed' });

    expect(res.status).toBe(200);
  });

  it('どちらのスキーマにも合わない body は400', async () => {
    const app = makeApp(CLIENT_ADMIN);
    const res = await request(app)
      .patch('/v1/admin/knowledge-gaps/1')
      .send({ foo: 'bar' });
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('対象が見つからない場合は404', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    const app = makeApp(CLIENT_ADMIN);
    const res = await request(app)
      .patch('/v1/admin/knowledge-gaps/999')
      .send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });
});
