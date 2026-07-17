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

// suggest_tuning_rule / save_tuning_rule が使う依存をモック（実DB/実Groq呼び出し回避）
const mockCallGroq8bSuggestFromText = jest.fn();
jest.mock('../tuning/routes', () => ({
  callGroq8bSuggestFromText: (...args: any[]) => mockCallGroq8bSuggestFromText(...args),
}));

const mockListRules = jest.fn();
const mockCreateRule = jest.fn();
jest.mock('../tuning/tuningRulesRepository', () => ({
  listRules: (...args: any[]) => mockListRules(...args),
  createRule: (...args: any[]) => mockCreateRule(...args),
}));

jest.mock('../../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(''),
}));

// get_weekly_briefing が使う依存をモック
const mockGetGaps = jest.fn();
jest.mock('../knowledge/knowledgeGapRepository', () => ({
  getGaps: (...args: any[]) => mockGetGaps(...args),
}));

// logger モック
jest.mock('../../../lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// usageTracker モック（GID 1215915182786983: admin_agent 課金計上のテスト用）
const mockTrackUsage = jest.fn();
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: any[]) => mockTrackUsage(...args),
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

function makeGroqResponse(
  content: string,
  tool_calls: any[] = [],
  usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 10, completion_tokens: 5 },
) {
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
      usage,
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
    mockListRules.mockResolvedValue([]);
    mockGetGaps.mockResolvedValue({ gaps: [], total: 0 });
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
  // GID 1215915182786983: admin_agent の trackUsage 配線
  // -------------------------------------------------------------------------
  describe('usage tracking (admin_agent 原価計上)', () => {
    it('tool_calls なし → featureUsed:admin_agent でtrackUsageが1回呼ばれる', async () => {
      mockFetch.mockResolvedValueOnce(
        makeGroqResponse('設定を確認しました。', [], { prompt_tokens: 100, completion_tokens: 20 }),
      );

      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4の設定を教えて', sessionId: 'sess-010' });

      expect(mockTrackUsage).toHaveBeenCalledTimes(1);
      expect(mockTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-abc',
          featureUsed: 'admin_agent',
          inputTokens: 100,
          outputTokens: 20,
        }),
      );
    });

    it('tool_calls あり → 第1回+第2回のトークンが合算されてtrackUsageに渡る', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'call-001', type: 'function', function: { name: 'get_tenant_settings', arguments: '{}' } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('GA4は未設定です。', [], { prompt_tokens: 30, completion_tokens: 15 }));

      mockQuery.mockResolvedValueOnce({
        rows: [{ ga4_measurement_id: null, posthog_host: 'https://app.posthog.com', widget_theme: {} }],
      });

      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-011' });

      expect(mockTrackUsage).toHaveBeenCalledTimes(1);
      expect(mockTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          featureUsed: 'admin_agent',
          inputTokens: 80, // 50 + 30
          outputTokens: 25, // 10 + 15
        }),
      );
    });

    it('super_admin がテナント未特定(targetTenantId省略) → trackUsageはスキップされる', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('こんにちは'));

      await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-012' });

      expect(mockTrackUsage).not.toHaveBeenCalled();
    });

    it('GROQ_API_KEY 未設定（グレースフルダウングレード）→ trackUsageは呼ばれない', async () => {
      delete process.env.GROQ_API_KEY;

      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-013' });

      expect(mockTrackUsage).not.toHaveBeenCalled();
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

  // -------------------------------------------------------------------------
  // Phase1 (G2): 会話履歴 — フロントから送られた history が Groq messages に含まれる
  // -------------------------------------------------------------------------
  describe('会話履歴(history)', () => {
    it('history を渡すと system と最新 user の間に挿入される', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('了解しました。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({
          message: '保存して',
          sessionId: 'sess-020',
          history: [
            { role: 'user', content: '保証について聞かれたら2年と答えて' },
            { role: 'assistant', content: 'トリガー: 保証 / 対応方針: 2年と案内する / 優先度: 5' },
          ],
        });

      expect(res.status).toBe(200);
      const fetchCallBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      const roles = fetchCallBody.messages.map((m: any) => m.role);
      expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
      expect(fetchCallBody.messages[1].content).toBe('保証について聞かれたら2年と答えて');
      expect(fetchCallBody.messages[3].content).toBe('保存して');
    });

    it('history 未指定でも動く（後方互換）', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('こんにちは'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-021' });

      expect(res.status).toBe(200);
      const fetchCallBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(fetchCallBody.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    });

    it('history が21件 → 400（上限20件）', async () => {
      const history = Array.from({ length: 21 }, (_, i) => ({ role: 'user' as const, content: `msg${i}` }));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-022', history });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Phase1: suggest_tuning_rule — 読み取り専用の下書き提案
  // -------------------------------------------------------------------------
  describe('suggest_tuning_rule', () => {
    it('提案を生成し actions に含める（DB書き込みは行わない）', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-tr-1',
                  type: 'function',
                  function: { name: 'suggest_tuning_rule', arguments: JSON.stringify({ free_text: '保証について聞かれたら2年と答えて' }) },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('こう提案します。保存してよいですか？'));

      mockCallGroq8bSuggestFromText.mockResolvedValueOnce({
        trigger_pattern: '保証',
        instruction: '保証期間は2年とお伝えする',
        priority: 5,
        reason: '保証に関する問い合わせが多いため',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '保証について聞かれたら2年と答えて', sessionId: 'sess-030' });

      expect(res.status).toBe(200);
      expect(mockCallGroq8bSuggestFromText).toHaveBeenCalledWith(
        '保証について聞かれたら2年と答えて',
        expect.any(String),
        expect.any(String),
      );
      expect(mockCreateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].tool).toBe('suggest_tuning_rule');
      expect(res.body.actions[0].result).toContain('保証期間は2年とお伝えする');
    });
  });

  // -------------------------------------------------------------------------
  // Phase1: save_tuning_rule — confirmed ゲート必須の書き込み
  // -------------------------------------------------------------------------
  describe('save_tuning_rule', () => {
    it('confirmed=false → 保存されず確認を促すメッセージを返す', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-sv-1',
                  type: 'function',
                  function: {
                    name: 'save_tuning_rule',
                    arguments: JSON.stringify({ trigger_pattern: '保証', expected_behavior: '2年と案内する', confirmed: false }),
                  },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('確認してから保存します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '保存して', sessionId: 'sess-031' });

      expect(res.status).toBe(200);
      expect(mockCreateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('confirmed=true → createRule が呼ばれ tenant_id は JWT 由来に固定される', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-sv-2',
                  type: 'function',
                  function: {
                    name: 'save_tuning_rule',
                    arguments: JSON.stringify({
                      trigger_pattern: '保証',
                      expected_behavior: '2年と案内する',
                      priority: 6,
                      confirmed: true,
                    }),
                  },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('保存しました。'));

      mockCreateRule.mockResolvedValueOnce({
        id: 42,
        tenant_id: 'tenant-abc',
        trigger_pattern: '保証',
        expected_behavior: '2年と案内する',
        priority: 6,
        is_active: true,
        created_by: 'admin_agent',
        source_message_id: null,
        created_at: '',
        updated_at: '',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'お願い', sessionId: 'sess-032' });

      expect(res.status).toBe(200);
      expect(mockCreateRule).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'tenant-abc', // JWT由来。body由来のtargetTenantIdでは差し替わらない
          trigger_pattern: '保証',
          expected_behavior: '2年と案内する',
          priority: 6,
        }),
      );
      expect(res.body.actions[0].result).toContain('ID: 42');
    });
  });

  // -------------------------------------------------------------------------
  // Phase2 (P7): get_weekly_briefing — 直近7日間の状況を1回で要約取得
  // -------------------------------------------------------------------------
  describe('get_weekly_briefing', () => {
    it('会話数・前週比・品質スコア・成約・未回答質問トップ3を1つの結果文字列にまとめる', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-wb-1',
                  type: 'function',
                  function: { name: 'get_weekly_briefing', arguments: '{}' },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('今週は会話が増えています。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 142 }] }) // 今週セッション数
        .mockResolvedValueOnce({ rows: [{ n: 120 }] }) // 先週セッション数
        .mockResolvedValueOnce({ rows: [{ avg: '82.4' }] }) // 平均スコア
        .mockResolvedValueOnce({ rows: [{ n: 8, total: '96000' }] }); // 成約

      mockGetGaps.mockResolvedValueOnce({
        gaps: [
          { id: 1, tenant_id: 'tenant-abc', user_question: '送料はいくらですか？', session_id: null, message_id: null, rag_hit_count: 0, rag_top_score: 0, status: 'open', resolved_faq_id: null, created_at: '' },
        ],
        total: 11,
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '今週の状況を教えて', sessionId: 'sess-040' });

      expect(res.status).toBe(200);
      expect(mockGetGaps).toHaveBeenCalledWith({ tenantId: 'tenant-abc', status: 'open', limit: 3 });
      const result = res.body.actions[0].result as string;
      expect(result).toContain('142件');
      expect(result).toContain('+18%'); // (142-120)/120 = 18.3% → 丸めて18%
      expect(result).toContain('82/100');
      expect(result).toContain('8件・¥96,000');
      expect(result).toContain('11件');
      expect(result).toContain('送料はいくらですか？');
    });

    it('super_admin がテナント未特定 → テナント特定を促すメッセージを返しDBクエリは発火しない', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-wb-2',
                  type: 'function',
                  function: { name: 'get_weekly_briefing', arguments: '{}' },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('テナントを指定してください。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '状況を教えて', sessionId: 'sess-041' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockGetGaps).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('テナントが特定できません');
    });
  });
});
