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
const mockUpdateRule = jest.fn();
const mockDeleteRule = jest.fn();
jest.mock('../tuning/tuningRulesRepository', () => ({
  listRules: (...args: any[]) => mockListRules(...args),
  createRule: (...args: any[]) => mockCreateRule(...args),
  updateRule: (...args: any[]) => mockUpdateRule(...args),
  deleteRule: (...args: any[]) => mockDeleteRule(...args),
}));

// 名前付きラッパーにする(jest.mock factory内の匿名 jest.fn() は resetAllMocks() で
// 既定値ごと消えてしまい、beforeEachで再設定できないため他の依存と同じパターンに統一)
const mockSearchKnowledgeForSuggestion = jest.fn();
const mockFormatKnowledgeContext = jest.fn();
jest.mock('../../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: (...args: any[]) => mockSearchKnowledgeForSuggestion(...args),
  formatKnowledgeContext: (...args: any[]) => mockFormatKnowledgeContext(...args),
}));

// get_weekly_briefing / get_knowledge_gaps / dismiss_knowledge_gap が使う依存をモック
const mockGetGaps = jest.fn();
const mockUpdateGapStatus = jest.fn();
jest.mock('../knowledge/knowledgeGapRepository', () => ({
  getGaps: (...args: any[]) => mockGetGaps(...args),
  updateGapStatus: (...args: any[]) => mockUpdateGapStatus(...args),
}));

// suggest_faq / save_faq が使う依存をモック
const mockTextToFaqs = jest.fn();
jest.mock('../knowledge/routes', () => ({
  textToFaqs: (...args: any[]) => mockTextToFaqs(...args),
}));

// suggest_engagement_rule が使う依存をモック
const mockSuggestEngagementRuleFromText = jest.fn();
jest.mock('./engagementSuggest', () => ({
  suggestEngagementRuleFromText: (...args: any[]) => mockSuggestEngagementRuleFromText(...args),
}));

// request_sai_task / get_sai_task_status が使う依存をモック
const mockCheckSaiMonthlyCostCeiling = jest.fn();
jest.mock('../options/routes', () => ({
  checkSaiMonthlyCostCeiling: (...args: any[]) => mockCheckSaiMonthlyCostCeiling(...args),
}));

const mockSubmitSaiTask = jest.fn();
const mockGetSaiTask = jest.fn();
jest.mock('../../../lib/sai/saiClient', () => ({
  submitSaiTask: (...args: any[]) => mockSubmitSaiTask(...args),
  getSaiTask: (...args: any[]) => mockGetSaiTask(...args),
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
    // resetAllMocks: clearAllMocksだとmockResolvedValue(永続的な既定値)がテストを跨いで
    // 残り続け、後続テストのmockResolvedValueOnceキューを使い切った際にリークして
    // 結果が汚染される(実際にこの不具合でテストがフレーキーになったため修正)。
    // 実装(モック値)も含めて毎回完全にリセットする。
    jest.resetAllMocks();
    process.env.GROQ_API_KEY = 'test-groq-key';
    mockListRules.mockResolvedValue([]);
    mockGetGaps.mockResolvedValue({ gaps: [], total: 0 });
    mockSearchKnowledgeForSuggestion.mockResolvedValue({ results: [] });
    mockFormatKnowledgeContext.mockReturnValue('');
    mockCheckSaiMonthlyCostCeiling.mockResolvedValue({ ok: true });
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
  // get_tuning_rules / update_tuning_rule / delete_tuning_rule
  // -------------------------------------------------------------------------
  describe('get_tuning_rules / update_tuning_rule / delete_tuning_rule', () => {
    function toolCallResponse(id: string, name: string, args: Record<string, unknown> = {}) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
          }],
        }),
        text: async () => '',
      };
    }

    it('get_tuning_rules: 一覧を1つの結果文字列にまとめる（無効ルールは(無効)を付ける）', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-1', 'get_tuning_rules', {}))
        .mockResolvedValueOnce(makeGroqResponse('現在2件のルールがあります。'));

      mockListRules.mockResolvedValueOnce([
        { id: 1, tenant_id: 'tenant-abc', trigger_pattern: '保証', expected_behavior: '2年と案内する', priority: 5, is_active: true, created_by: null, source_message_id: null, created_at: '', updated_at: '' },
        { id: 2, tenant_id: 'global', trigger_pattern: '価格交渉', expected_behavior: '応じない', priority: 3, is_active: false, created_by: null, source_message_id: null, created_at: '', updated_at: '' },
      ]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '指示ルールを見せて', sessionId: 'sess-tr-01' });

      expect(res.status).toBe(200);
      expect(mockListRules).toHaveBeenCalledWith('tenant-abc');
      const result = res.body.actions[0].result as string;
      expect(result).toContain('2件');
      expect(result).toContain('保証');
      expect(result).toContain('価格交渉');
      expect(result).toContain('(無効)');
    });

    it('update_tuning_rule: confirmed=false → 更新されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-2', 'update_tuning_rule', { id: 1, is_active: false, confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから更新します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を無効にして', sessionId: 'sess-tr-02' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('update_tuning_rule: client_admin・confirmed=true → tenant_idスコープ(super_admin以外はundefined渡さない)で更新される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-3', 'update_tuning_rule', { id: 1, is_active: false, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('無効にしました。'));

      mockUpdateRule.mockResolvedValueOnce({
        id: 1, tenant_id: 'tenant-abc', trigger_pattern: '保証', expected_behavior: '2年と案内する', priority: 5, is_active: false, created_by: null, source_message_id: null, created_at: '', updated_at: '',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を無効にして', sessionId: 'sess-tr-03' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).toHaveBeenCalledWith(
        1,
        { trigger_pattern: undefined, expected_behavior: undefined, is_active: false },
        'tenant-abc',
      );
      expect(res.body.actions[0].result).toContain('現在無効');
    });

    it('update_tuning_rule: super_admin・confirmed=true → tenant_idスコープ無し(undefined)で更新される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-4', 'update_tuning_rule', { id: 2, is_active: true, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('有効にしました。'));

      mockUpdateRule.mockResolvedValueOnce({
        id: 2, tenant_id: 'global', trigger_pattern: '価格交渉', expected_behavior: '応じない', priority: 3, is_active: true, created_by: null, source_message_id: null, created_at: '', updated_at: '',
      });

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール2を有効にして', sessionId: 'sess-tr-04', targetTenantId: 'tenant-abc' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).toHaveBeenCalledWith(
        2,
        { trigger_pattern: undefined, expected_behavior: undefined, is_active: true },
        undefined,
      );
    });

    it('update_tuning_rule: 変更内容が空 → DB呼び出しせずその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-5', 'update_tuning_rule', { id: 1, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('変更内容を教えてください。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を更新して', sessionId: 'sess-tr-05' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('変更する内容がありません');
    });

    it('delete_tuning_rule: confirmed=false → 削除されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-6', 'delete_tuning_rule', { id: 1, confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから削除します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を削除して', sessionId: 'sess-tr-06' });

      expect(res.status).toBe(200);
      expect(mockDeleteRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('delete_tuning_rule: confirmed=true → tenant_idスコープで削除される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-7', 'delete_tuning_rule', { id: 1, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('削除しました。'));

      mockDeleteRule.mockResolvedValueOnce(true);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を削除して', sessionId: 'sess-tr-07' });

      expect(res.status).toBe(200);
      expect(mockDeleteRule).toHaveBeenCalledWith(1, 'tenant-abc');
      expect(res.body.actions[0].result).toContain('削除しました');
    });

    it('delete_tuning_rule: 対象が見つからない場合はその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tr-8', 'delete_tuning_rule', { id: 999, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      mockDeleteRule.mockResolvedValueOnce(false);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール999を削除して', sessionId: 'sess-tr-08' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('見つからないかアクセス権限がありません');
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

  // -------------------------------------------------------------------------
  // get_knowledge_gaps / dismiss_knowledge_gap
  // -------------------------------------------------------------------------
  describe('get_knowledge_gaps / dismiss_knowledge_gap', () => {
    function toolCallResponse(id: string, name: string, args: Record<string, unknown> = {}) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
          }],
        }),
        text: async () => '',
      };
    }

    it('get_knowledge_gaps: 未対応の知識ギャップ一覧を1つの結果文字列にまとめる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-kg-1', 'get_knowledge_gaps', {}))
        .mockResolvedValueOnce(makeGroqResponse('未対応の質問は2件あります。'));

      mockGetGaps.mockResolvedValueOnce({
        gaps: [
          { id: 1, tenant_id: 'tenant-abc', user_question: '送料はいくらですか？', session_id: null, message_id: null, rag_hit_count: 9, rag_top_score: 0, status: 'open', resolved_faq_id: null, created_at: '' },
          { id: 2, tenant_id: 'tenant-abc', user_question: '返品はできますか？', session_id: null, message_id: null, rag_hit_count: 2, rag_top_score: 0, status: 'open', resolved_faq_id: null, created_at: '' },
        ],
        total: 11,
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '知識ギャップを見せて', sessionId: 'sess-kg-01' });

      expect(res.status).toBe(200);
      expect(mockGetGaps).toHaveBeenCalledWith({ tenantId: 'tenant-abc', status: 'open', limit: 10 });
      const result = res.body.actions[0].result as string;
      expect(result).toContain('未対応11件中2件');
      expect(result).toContain('送料はいくらですか？');
      expect(result).toContain('返品はできますか？');
    });

    it('get_knowledge_gaps: 0件の場合は「ありません」と返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-kg-2', 'get_knowledge_gaps', {}))
        .mockResolvedValueOnce(makeGroqResponse('未対応の質問はありません。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '知識ギャップを見せて', sessionId: 'sess-kg-03' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('ありません');
    });

    it('dismiss_knowledge_gap: confirmed=false → 更新されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-kg-4', 'dismiss_knowledge_gap', { id: 1, confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから片付けます。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'この質問は片付けて', sessionId: 'sess-kg-04' });

      expect(res.status).toBe(200);
      expect(mockUpdateGapStatus).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('dismiss_knowledge_gap: confirmed=true → tenant_idスコープでdismissedに更新される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-kg-5', 'dismiss_knowledge_gap', { id: 1, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('片付けました。'));

      mockUpdateGapStatus.mockResolvedValueOnce(true);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'この質問は片付けて', sessionId: 'sess-kg-05' });

      expect(res.status).toBe(200);
      expect(mockUpdateGapStatus).toHaveBeenCalledWith(1, 'dismissed', 'tenant-abc', null);
      expect(res.body.actions[0].result).toContain('片付けました');
    });

    it('dismiss_knowledge_gap: 対象が見つからない場合はその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-kg-6', 'dismiss_knowledge_gap', { id: 999, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      mockUpdateGapStatus.mockResolvedValueOnce(false);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'この質問は片付けて', sessionId: 'sess-kg-06' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('見つかりません');
    });
  });

  // -------------------------------------------------------------------------
  // Phase3: suggest_faq / save_faq
  // -------------------------------------------------------------------------
  describe('suggest_faq / save_faq', () => {
    it('suggest_faq: 既存質問を渡してtextToFaqsを呼び、下書きをactionsに含める(DB書き込みなし)', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-sf-1',
                  type: 'function',
                  function: { name: 'suggest_faq', arguments: JSON.stringify({ free_text: '送料は550円、5000円以上で無料と答えて' }) },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('こう提案します。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ question: '返品はできますか？' }] });
      mockTextToFaqs.mockResolvedValueOnce([
        { question: '送料はいくらですか？', answer: '550円です。5000円以上で無料になります。', category: 'store_info' },
        { question: '送料無料の条件は？', answer: '5000円以上のお買い上げです。', category: 'store_info' },
      ]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料は550円、5000円以上で無料と答えて', sessionId: 'sess-050' });

      expect(res.status).toBe(200);
      expect(mockTextToFaqs).toHaveBeenCalledWith(
        '送料は550円、5000円以上で無料と答えて',
        undefined,
        ['返品はできますか？'],
      );
      expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO faq_docs'), expect.anything());
      const result = res.body.actions[0].result as string;
      expect(result).toContain('送料はいくらですか？');
      expect(result).toContain('他に1件');
    });

    it('save_faq: confirmed=false → 保存されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-sf-2',
                  type: 'function',
                  function: { name: 'save_faq', arguments: JSON.stringify({ question: 'q', answer: 'a', confirmed: false }) },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('確認してから保存します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '保存して', sessionId: 'sess-051' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('save_faq: confirmed=true → faq_docsにINSERTしtenant_idはJWT由来に固定される', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-sf-3',
                  type: 'function',
                  function: {
                    name: 'save_faq',
                    arguments: JSON.stringify({ question: '送料はいくらですか？', answer: '550円です。', category: 'store_info', confirmed: true }),
                  },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('保存しました。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 99, question: '送料はいくらですか？', answer: '550円です。', is_published: true }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'お願い', sessionId: 'sess-052' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO faq_docs'),
        ['tenant-abc', '送料はいくらですか？', '550円です。', 'store_info'],
      );
      expect(res.body.actions[0].result).toContain('ID: 99');
    });
  });

  // -------------------------------------------------------------------------
  // Phase3: suggest_engagement_rule / save_engagement_rule
  // -------------------------------------------------------------------------
  describe('suggest_engagement_rule / save_engagement_rule', () => {
    it('suggest_engagement_rule: 下書きをactionsに含める(DB書き込みなし)', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-se-1',
                  type: 'function',
                  function: { name: 'suggest_engagement_rule', arguments: JSON.stringify({ free_text: '商品ページを長く見てる人にランキングを勧めたい' }) },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('こう提案します。'));

      mockSuggestEngagementRuleFromText.mockResolvedValueOnce({
        trigger_type: 'idle_time',
        trigger_config: { seconds: 30 },
        message_template: '人気ランキングもご覧ください🎁',
        priority: 5,
        reason: '長時間滞在は離脱の兆候のため',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '商品ページを長く見てる人にランキングを勧めたい', sessionId: 'sess-060' });

      expect(res.status).toBe(200);
      expect(mockSuggestEngagementRuleFromText).toHaveBeenCalledWith('商品ページを長く見てる人にランキングを勧めたい');
      expect(mockQuery).not.toHaveBeenCalled();
      const result = res.body.actions[0].result as string;
      expect(result).toContain('idle_time');
      expect(result).toContain('人気ランキングもご覧ください🎁');
    });

    it('save_engagement_rule: confirmed=false → 保存されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-se-2',
                  type: 'function',
                  function: {
                    name: 'save_engagement_rule',
                    arguments: JSON.stringify({ trigger_type: 'idle_time', trigger_config: { seconds: 30 }, message_template: 'x', confirmed: false }),
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
        .send({ message: '保存して', sessionId: 'sess-061' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('save_engagement_rule: 不正なtrigger_type → 保存されずエラーメッセージを返す', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-se-3',
                  type: 'function',
                  function: {
                    name: 'save_engagement_rule',
                    arguments: JSON.stringify({ trigger_type: 'evil_type', trigger_config: {}, message_template: 'x', confirmed: true }),
                  },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('エラーです。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '保存して', sessionId: 'sess-062' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('trigger_type が不正');
    });

    it('save_engagement_rule: confirmed=true → trigger_rulesにINSERTしtenant_idはJWT由来に固定される', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-se-4',
                  type: 'function',
                  function: {
                    name: 'save_engagement_rule',
                    arguments: JSON.stringify({
                      trigger_type: 'idle_time',
                      trigger_config: { seconds: 30 },
                      message_template: '人気ランキングもご覧ください🎁',
                      priority: 5,
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

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 7, trigger_type: 'idle_time', message_template: '人気ランキングもご覧ください🎁' }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'お願い', sessionId: 'sess-063' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO trigger_rules'),
        ['tenant-abc', 'idle_time', JSON.stringify({ seconds: 30 }), '人気ランキングもご覧ください🎁', 5],
      );
      expect(res.body.actions[0].result).toContain('ID: 7');
    });
  });

  // -------------------------------------------------------------------------
  // G1: 多段エージェントループ
  // -------------------------------------------------------------------------
  describe('G1: 多段エージェントループ', () => {
    function toolCallResponse(id: string, name: string, args: Record<string, unknown> = {}) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
          }],
        }),
        text: async () => '',
      };
    }

    it('実測されたGroqの挙動: 無引数ツールで arguments が文字列"null"で来てもクラッシュせず空引数扱いになる', async () => {
      // 実際にGroq APIを叩いて観測した実データ形式: {"function":{"name":"get_tenant_settings","arguments":"null"}}
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_tenant_settings', arguments: 'null' } }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('確認しました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ ga4_measurement_id: null, posthog_host: null, widget_theme: {} }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-074' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].tool).toBe('get_tenant_settings');
      expect(res.body.actions[0].result).not.toContain('失敗');
    });

    it('3ホップ: ツール→ツール→最終応答 が正しく連鎖する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-1', 'get_tenant_settings'))
        .mockResolvedValueOnce(toolCallResponse('call-2', 'get_faq_list'))
        .mockResolvedValueOnce(makeGroqResponse('設定とFAQを確認しました。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ ga4_measurement_id: null, posthog_host: null, widget_theme: {} }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, question: 'q', answer: 'a' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定とFAQを両方確認して', sessionId: 'sess-070' });

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(res.body.actions.map((a: any) => a.tool)).toEqual(['get_tenant_settings', 'get_faq_list']);
      expect(res.body.reply).toBe('設定とFAQを確認しました。');
    });

    it('MAX_TOOL_HOPS(4回)に達しても収束しない場合、tools無しの強制まとめ呼び出しで終了する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-1', 'get_tenant_settings'))
        .mockResolvedValueOnce(toolCallResponse('call-2', 'get_tenant_settings'))
        .mockResolvedValueOnce(toolCallResponse('call-3', 'get_tenant_settings'))
        .mockResolvedValueOnce(toolCallResponse('call-4', 'get_tenant_settings'))
        .mockResolvedValueOnce(makeGroqResponse('（強制まとめ）これ以上の確認はできませんでした。'));

      mockQuery.mockResolvedValue({ rows: [{ ga4_measurement_id: null, posthog_host: null, widget_theme: {} }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ループしてみて', sessionId: 'sess-071' });

      expect(res.status).toBe(200);
      // 4ホップ(tools付き) + 1回の強制まとめ(tools無し) = 合計5回のGroq呼び出し
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(res.body.actions.length).toBe(4);
      expect(res.body.reply).toBe('（強制まとめ）これ以上の確認はできませんでした。');
    });

    it('同一ターン内で suggest_faq → save_faq(confirmed=true) を連鎖しようとするとブロックされ、DBには書き込まれない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-1', 'suggest_faq', { free_text: '送料は550円' }))
        .mockResolvedValueOnce(toolCallResponse('call-2', 'save_faq', { question: 'q', answer: 'a', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('確認をお願いします。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ question: '既存FAQ' }] }); // suggest_faq内の既存質問取得
      mockTextToFaqs.mockResolvedValueOnce([{ question: '送料はいくらですか？', answer: '550円です。' }]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料は550円で登録して', sessionId: 'sess-072' });

      expect(res.status).toBe(200);
      // save_faq の INSERT が発火していないこと(suggest_faq用の1回のSELECTのみ)
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO faq_docs'), expect.anything());

      const saveAction = res.body.actions.find((a: any) => a.tool === 'save_faq');
      expect(saveAction.result).toContain('同一ターン内での連続実行');
    });

    it('同一ホップ内で suggest_tuning_rule と save_tuning_rule(confirmed=true) が同時に来ても後者はブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [
                  { id: 'call-1', type: 'function', function: { name: 'suggest_tuning_rule', arguments: JSON.stringify({ free_text: '保証は2年' }) } },
                  { id: 'call-2', type: 'function', function: { name: 'save_tuning_rule', arguments: JSON.stringify({ trigger_pattern: '保証', expected_behavior: '2年', confirmed: true }) } },
                ],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('確認をお願いします。'));

      mockCallGroq8bSuggestFromText.mockResolvedValueOnce({
        trigger_pattern: '保証', instruction: '2年と伝える', priority: 5, reason: '',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '保証は2年で登録して', sessionId: 'sess-073' });

      expect(res.status).toBe(200);
      expect(mockCreateRule).not.toHaveBeenCalled();
      const saveAction = res.body.actions.find((a: any) => a.tool === 'save_tuning_rule');
      expect(saveAction.result).toContain('同一ターン内での連続実行');
    });
  });

  // -------------------------------------------------------------------------
  // SSE: 本物のトークンストリーミング (stream:true オプトイン)
  // -------------------------------------------------------------------------
  describe('SSE ストリーミング (stream:true)', () => {
    function makeStreamingGroqResponse(fullSseText: string) {
      const bytes = new TextEncoder().encode(fullSseText);
      let sent = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (!sent) {
                sent = true;
                return { done: false, value: bytes };
              }
              return { done: true, value: undefined };
            },
          }),
        },
        text: async () => '',
      };
    }

    it('content delta を逐次イベントとして送出し、event: done で最終replyを返す', async () => {
      const sse =
        'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n' +
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
        'data: [DONE]\n\n';

      mockFetch.mockResolvedValueOnce(makeStreamingGroqResponse(sse));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-080', stream: true });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('event: delta');
      expect(res.text).toContain('"text":"こん"');
      expect(res.text).toContain('"text":"にちは"');
      expect(res.text).toContain('event: done');
      expect(res.text).toContain('"reply":"こんにちは"');
      expect(mockTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 10, outputTokens: 2, featureUsed: 'admin_agent' }),
      );
    });

    it('tool_calls delta をindexごとに蓄積して実行し、event: action → event: done の順で送出する', async () => {
      const hop1Sse =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"get_tenant_settings","arguments":""}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n' +
        'data: [DONE]\n\n';
      const hop2Sse = 'data: {"choices":[{"delta":{"content":"設定を確認しました。"}}]}\n\n' + 'data: [DONE]\n\n';

      mockFetch
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop1Sse))
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop2Sse));

      mockQuery.mockResolvedValueOnce({ rows: [{ ga4_measurement_id: null, posthog_host: null, widget_theme: {} }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-081', stream: true });

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: action');
      expect(res.text).toContain('"tool":"get_tenant_settings"');
      expect(res.text.indexOf('event: action')).toBeLessThan(res.text.indexOf('event: done'));
      expect(res.text).toContain('設定を確認しました。');
    });

    it('stream:true でも suggest_faq→save_faq の同一ターン連鎖はブロックされ、DBに書き込まれない', async () => {
      const hop1Sse =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"suggest_faq","arguments":"{\\"free_text\\":\\"送料は550円\\"}"}}]}}]}\n\n' +
        'data: [DONE]\n\n';
      const hop2Sse =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","function":{"name":"save_faq","arguments":"{\\"question\\":\\"q\\",\\"answer\\":\\"a\\",\\"confirmed\\":true}"}}]}}]}\n\n' +
        'data: [DONE]\n\n';
      const hop3Sse = 'data: {"choices":[{"delta":{"content":"確認をお願いします。"}}]}\n\n' + 'data: [DONE]\n\n';

      mockFetch
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop1Sse))
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop2Sse))
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop3Sse));

      mockQuery.mockResolvedValueOnce({ rows: [{ question: '既存FAQ' }] });
      mockTextToFaqs.mockResolvedValueOnce([{ question: '送料はいくらですか？', answer: '550円です。' }]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料は550円で登録して', sessionId: 'sess-082', stream: true });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledTimes(1); // suggest_faq用のSELECTのみ、INSERTは発火しない
      expect(res.text).toContain('同一ターン内での連続実行');
    });

    it('GROQ_API_KEY未設定でstream:trueでもJSONのグレースフルダウングレードを返す(SSEにはしない)', async () => {
      delete process.env.GROQ_API_KEY;

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'hello', sessionId: 'sess-083', stream: true });

      expect(res.status).toBe(200);
      expect(res.body.reply).toBe('AIアシスタントは現在利用できません');
    });
  });

  // -------------------------------------------------------------------------
  // Sai委譲(Tier A設計の土台): super_admin限定を維持、client_adminには開放しない
  // -------------------------------------------------------------------------
  describe('request_sai_task / get_sai_task_status', () => {
    function toolCallResponse(name: string, args: Record<string, unknown>) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
          }],
        }),
        text: async () => '',
      };
    }

    it('client_admin が呼び出すと super_admin 限定メッセージが返り、Saiには依頼されない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '商品ページを更新して', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('現在は対応できません。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '商品ページを更新して', sessionId: 'sess-090' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('super_admin 限定');
    });

    it('super_admin: confirmed=false → 依頼されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '商品ページを更新して', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから依頼します。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '商品ページを更新して', sessionId: 'sess-091' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('super_admin: 月次コスト上限に達している場合は依頼されない', async () => {
      mockCheckSaiMonthlyCostCeiling.mockResolvedValueOnce({ ok: false, spentCents: 100000, ceilingCents: 100000 });
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '商品ページを更新して', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('上限に達しています。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '商品ページを更新して', sessionId: 'sess-092' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('上限');
    });

    it('super_admin: confirmed=true かつ上限内 → Saiに依頼されタスクIDが返る', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '商品ページの送料表記を更新して', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('依頼しました。'));

      mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-99', status: 'queued' });

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '商品ページの送料表記を更新して', sessionId: 'sess-093' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: '商品ページの送料表記を更新して' }),
      );
      expect(res.body.actions[0].result).toContain('sai-task-99');
    });

    it('client_admin が get_sai_task_status を呼び出すと super_admin 限定メッセージが返る', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('get_sai_task_status', { task_id: 'sai-task-99' }))
        .mockResolvedValueOnce(makeGroqResponse('現在は対応できません。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '進捗を教えて', sessionId: 'sess-094' });

      expect(res.status).toBe(200);
      expect(mockGetSaiTask).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('super_admin 限定');
    });

    it('super_admin: get_sai_task_status で状態と自己申告非信用の注記を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('get_sai_task_status', { task_id: 'sai-task-99' }))
        .mockResolvedValueOnce(makeGroqResponse('進捗を確認しました。'));

      mockGetSaiTask.mockResolvedValueOnce({
        status: 'complete', steps: 3, max_steps: 15, description: 'x',
        outcome: 'agent_reported_done', last_action: 'click save button',
      });

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '進捗を教えて', sessionId: 'sess-095' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('complete');
      expect(result).toContain('自己申告は信用しない');
    });
  });
});
