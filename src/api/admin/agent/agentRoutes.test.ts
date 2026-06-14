// src/api/admin/agent/agentRoutes.test.ts
// Phase B-Admin: admin agent chat route テスト

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// モック（副作用 no-op — Gate1 OOM 回避）
// ---------------------------------------------------------------------------

// supabaseAuthMiddleware: JWT 検証をスキップし req.supabaseUser を注入するモックに置換
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    // テストごとにオーバーライド可能にするため req.__mockUser を参照
    req.supabaseUser = req.__mockUser ?? undefined;
    next();
  },
}));

// db（Pool）モック
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockDb = {
  query: mockQuery,
  connect: mockConnect,
} as any;

// Groq fetch モック
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// embedding / ES（fire-and-forget）をモック — 副作用 no-op
jest.mock('../knowledge/faqCrudRoutes', () => ({
  insertEmbeddingAsync: jest.fn(),
  upsertToEsAsync: jest.fn(),
}));

// logger モック
jest.mock('../../../lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// ---------------------------------------------------------------------------
// テスト対象を import
// ---------------------------------------------------------------------------

import { registerAdminAgentRoutes } from './agentRoutes';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function makeApp(mockUser?: Record<string, any> | undefined) {
  const app = express();
  app.use(express.json());

  // テスト用: req.__mockUser を注入する前段ミドルウェア
  app.use((req: any, _res: any, next: any) => {
    req.__mockUser = mockUser;
    next();
  });

  registerAdminAgentRoutes(app, mockDb);
  return app;
}

const CLIENT_ADMIN_USER = {
  app_metadata: { role: 'client_admin', tenant_id: 'tenant-abc' },
};

const SUPER_ADMIN_USER = {
  app_metadata: { role: 'super_admin', tenant_id: '' },
};

function makeGroqResponse(content: string, tool_calls: any[] = []) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content,
            tool_calls,
          },
        },
      ],
    }),
    text: async () => content,
  };
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe('POST /v1/admin/agent/chat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-groq-key';
  });

  // -------------------------------------------------------------------------
  // 正常系: client_admin → 200 {reply, actions}（Groq fetch モック）
  // -------------------------------------------------------------------------
  describe('正常系: client_admin', () => {
    it('tool_calls なし → reply と空の actions を返す', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('設定を確認しました。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4の設定を教えて', sessionId: 'sess-001' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('reply');
      expect(res.body).toHaveProperty('actions');
      expect(Array.isArray(res.body.actions)).toBe(true);
    });

    it('tool_calls あり → executeToolCall の結果を actions に含む', async () => {
      // 第1回: tool_call を返す
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-001',
                      type: 'function',
                      function: {
                        name: 'get_tenant_settings',
                        arguments: '{}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          text: async () => '',
        })
        // 第2回: final reply
        .mockResolvedValueOnce(makeGroqResponse('GA4は未設定です。'));

      // get_tenant_settings の DB クエリ結果
      mockQuery.mockResolvedValueOnce({
        rows: [{ ga4_measurement_id: null, posthog_host: 'https://app.posthog.com', widget_theme: {} }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-002' });

      expect(res.status).toBe(200);
      expect(res.body.actions.length).toBe(1);
      expect(res.body.actions[0].tool).toBe('get_tenant_settings');
      expect(typeof res.body.actions[0].result).toBe('string');
      expect(res.body).toHaveProperty('reply');
    });
  });

  // -------------------------------------------------------------------------
  // 認証エラー: supabaseUser なし → 403
  // -------------------------------------------------------------------------
  describe('認証エラー', () => {
    it('supabaseUser なし → 403', async () => {
      const res = await request(makeApp(undefined))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-003' });

      expect(res.status).toBe(403);
    });

    it('role が不正（viewer）→ 403', async () => {
      const res = await request(makeApp({ app_metadata: { role: 'viewer', tenant_id: 'tenant-abc' } }))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-004' });

      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // バリデーション: message 空 → 400
  // -------------------------------------------------------------------------
  describe('バリデーション', () => {
    it('message が空文字列 → 400', async () => {
      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '', sessionId: 'sess-005' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('message が 2001 字 → 400', async () => {
      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'a'.repeat(2001), sessionId: 'sess-006' });

      expect(res.status).toBe(400);
    });

    it('sessionId が欠落 → 400', async () => {
      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello' });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // tenantId 分離: body に別 tenantId を入れても JWT 由来が使われる
  // -------------------------------------------------------------------------
  describe('tenantId 分離', () => {
    it('client_admin: body の targetTenantId は無視され JWT 由来テナント "tenant-abc" が使われる', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('こんにちは'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({
          message: '設定を確認して',
          sessionId: 'sess-007',
          targetTenantId: 'evil-tenant-override', // body に悪意ある tenant_id
        });

      // 200 は返るが、実際に使われる tenantId は "tenant-abc"（JWT 由来）
      // Groq に渡る systemPrompt に "tenant-abc" が含まれることを fetch の呼び出し引数で確認
      expect(res.status).toBe(200);
      const fetchCallBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      const systemMessage = fetchCallBody.messages.find((m: any) => m.role === 'system');
      expect(systemMessage?.content).toContain('tenant-abc');
      expect(systemMessage?.content).not.toContain('evil-tenant-override');
    });

    it('super_admin: targetTenantId を指定すると effectiveTenantId として使われる', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('こんにちは'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({
          message: '設定を確認して',
          sessionId: 'sess-008',
          targetTenantId: 'tenant-target',
        });

      expect(res.status).toBe(200);
      const fetchCallBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      const systemMessage = fetchCallBody.messages.find((m: any) => m.role === 'system');
      expect(systemMessage?.content).toContain('tenant-target');
    });
  });

  // -------------------------------------------------------------------------
  // GROQ_API_KEY 未設定 → グレースフルダウングレード
  // -------------------------------------------------------------------------
  describe('GROQ_API_KEY 未設定', () => {
    it('GROQ_API_KEY なし → 200 AIアシスタントは現在利用できません', async () => {
      delete process.env.GROQ_API_KEY;

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-009' });

      expect(res.status).toBe(200);
      expect(res.body.reply).toBe('AIアシスタントは現在利用できません');
      expect(res.body.actions).toEqual([]);
    });
  });
});
