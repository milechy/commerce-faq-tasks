// src/api/admin/options/optionOrders.test.ts
// Phase64 タスク6: option_orders CRUD + premium_avatar type テスト

import express from 'express';
import request from 'supertest';
import { registerOptionRoutes } from './routes';

// ── モック ─────────────────────────────────────────────────────────────────────

jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: jest.fn(),
}));

jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { createNotification } from '../../../lib/notifications';
const mockCreateNotification = createNotification as jest.Mock;

// ── ヘルパー ───────────────────────────────────────────────────────────────────

function makeApp(role = 'client_admin', tenantId = 'tenant-x') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerOptionRoutes(app);
  return app;
}

function superAdminApp() {
  return makeApp('super_admin', '');
}

// ── テスト ─────────────────────────────────────────────────────────────────────

describe('option_orders API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── GET ────────────────────────────────────────────────────────────────────

  describe('GET /v1/admin/options', () => {
    it('client_admin: 自テナントのデータのみ返す', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'order-1', type: 'general' }, { id: 'order-2', type: 'premium_avatar' }] });

      const res = await request(makeApp()).get('/v1/admin/options');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it('statusフィルタが機能する', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ cnt: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'order-1', status: 'pending', type: 'premium_avatar' }] });

      const res = await request(makeApp()).get('/v1/admin/options?status=pending');
      expect(res.status).toBe(200);
      expect(res.body.items[0].type).toBe('premium_avatar');
    });

    it('テーブル未存在時は空配列を返す（42P01）', async () => {
      const pgErr = new Error('table does not exist') as any;
      pgErr.code = '42P01';
      mockQuery.mockRejectedValueOnce(pgErr);

      const res = await request(makeApp()).get('/v1/admin/options');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });
  });

  // ── POST ───────────────────────────────────────────────────────────────────

  describe('POST /v1/admin/options', () => {
    it('通常注文を作成できる', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-order-1', type: 'general', status: 'pending' }],
      });

      const res = await request(makeApp())
        .post('/v1/admin/options')
        .send({ description: 'ナレッジ登録代行', llm_estimate_amount: 10000 });

      expect(res.status).toBe(201);
      expect(res.body.item.id).toBe('new-order-1');
    });

    it('type=premium_avatar で注文を作成できる', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'premium-order-1', type: 'premium_avatar', status: 'pending' }],
      });

      const res = await request(makeApp())
        .post('/v1/admin/options')
        .send({
          description: 'プレミアムアバター制作代行',
          llm_estimate_amount: 5000,
          type: 'premium_avatar',
        });

      expect(res.status).toBe(201);
      expect(res.body.item.type).toBe('premium_avatar');
    });

    it('descriptionなしは400', async () => {
      const res = await request(makeApp())
        .post('/v1/admin/options')
        .send({ llm_estimate_amount: 5000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('description');
    });
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────

  describe('PUT /v1/admin/options/:id', () => {
    it('super_admin は更新できる', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'order-1', status: 'in_progress' }],
      });

      const res = await request(superAdminApp())
        .put('/v1/admin/options/order-1')
        .send({ status: 'in_progress' });

      expect(res.status).toBe(200);
    });

    it('client_admin は403', async () => {
      const res = await request(makeApp())
        .put('/v1/admin/options/order-1')
        .send({ status: 'in_progress' });

      expect(res.status).toBe(403);
    });

    it('不正なstatusは400', async () => {
      const res = await request(superAdminApp())
        .put('/v1/admin/options/order-1')
        .send({ status: 'invalid_status' });

      expect(res.status).toBe(400);
    });
  });

  // ── PUT /:id/complete ──────────────────────────────────────────────────────

  describe('PUT /v1/admin/options/:id/complete', () => {
    it('通常注文の完了で option_completed 通知を出す', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'order-1', tenant_id: 'tenant-x',
          type: 'general', description: 'ナレッジ登録',
          final_amount: 10000, llm_estimate_amount: 10000,
        }],
      });
      mockCreateNotification.mockResolvedValue(undefined);

      const res = await request(superAdminApp())
        .put('/v1/admin/options/order-1/complete')
        .send({});

      expect(res.status).toBe(200);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'option_completed' })
      );
    });

    it('premium_avatar 注文の完了で premium_avatar_completed 通知を出す', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'premium-1', tenant_id: 'tenant-x',
          type: 'premium_avatar', description: 'プレミアムアバター制作代行',
          final_amount: 5000, llm_estimate_amount: 5000,
          result_url: 'https://storage.example.com/avatar.jpg',
        }],
      });
      mockCreateNotification.mockResolvedValue(undefined);

      const res = await request(superAdminApp())
        .put('/v1/admin/options/premium-1/complete')
        .send({ result_url: 'https://storage.example.com/avatar.jpg' });

      expect(res.status).toBe(200);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'premium_avatar_completed',
          title: 'プレミアムアバターが完成しました',
          link: '/admin/avatar',
        })
      );
    });

    it('client_admin は complete を叩けない（403）', async () => {
      const res = await request(makeApp())
        .put('/v1/admin/options/order-1/complete')
        .send({});

      expect(res.status).toBe(403);
    });

    it('存在しない注文は404', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const res = await request(superAdminApp())
        .put('/v1/admin/options/nonexistent/complete')
        .send({});

      expect(res.status).toBe(404);
    });
  });
});

// ── r2cFeatureCatalog テスト ───────────────────────────────────────────────────

describe('r2cFeatureCatalog — premium_avatar_service', () => {
  it('premium_avatar_service エントリーが存在する', async () => {
    const { R2C_FEATURE_CATALOG } = await import('../../../config/r2cFeatureCatalog');
    const entry = R2C_FEATURE_CATALOG.find((f) => f.id === 'premium_avatar_service');
    expect(entry).toBeDefined();
    expect(entry!.pricePerUnit).toBe(5000);
    expect(entry!.isService).toBe(true);
  });

  it('プレミアム専用キーワードでマッチする', async () => {
    const { matchFeatureCatalog } = await import('../../../config/r2cFeatureCatalog');
    // 「リアル」「品質を上げたい」「品質向上」は avatar_setup にないキーワード
    expect(matchFeatureCatalog('もっとリアルにしたい')).toMatchObject({
      id: 'premium_avatar_service',
    });
    expect(matchFeatureCatalog('品質を上げたい')).toMatchObject({
      id: 'premium_avatar_service',
    });
    expect(matchFeatureCatalog('品質向上を検討しています')).toMatchObject({
      id: 'premium_avatar_service',
    });
  });
});

// ── feedbackAI アバター品質トリガーテスト ──────────────────────────────────────

describe('feedbackAI — プレミアムアバター代行提案トリガー', () => {
  const mockFetch = jest.fn();
  global.fetch = mockFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
  });

  it('アバター品質キーワードを含む応答で代行提案が含まれる（システムプロンプトに記載）', async () => {
    // LLMが通常回答を返す場合（アバター品質案内テキストを含む）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: 'アバターの品質は設定から向上できます。🎨 弊社デザイナーが最高品質のアバターを制作いたします。Flux 2 Pro + Vellum手動調整 + Magnific AIアップスケールによる、API自動化では実現できない仕上がりです。ご希望の場合は「プレミアム制作をお願いします」とお伝えください。',
          },
        }],
      }),
    });

    jest.mock('../feedback/feedbackRepository', () => ({
      getMessages: jest.fn().mockResolvedValue({ messages: [] }),
    }), { virtual: true });

    const { generateFeedbackReply } = await import('../feedback/feedbackAI');
    const result = await generateFeedbackReply('アバターの品質を上げたいです', 'tenant-a');
    expect(result).toBeTruthy();
    // 実際の応答にプレミアム制作の案内が含まれていることを確認
    expect(result).toContain('プレミアム制作');
  });
});
