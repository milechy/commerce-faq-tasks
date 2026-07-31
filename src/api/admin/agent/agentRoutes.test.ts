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

// generate_tuning_rule_test_responses が使う依存をモック
const mockGenerateTestResponses = jest.fn();
jest.mock('../tuning/testResponseRoutes', () => ({
  generateTestResponses: (...args: any[]) => mockGenerateTestResponses(...args),
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

// suggest_faq_import_from_text/urls / commit_faq_import が使う依存をモック
// (actionExecutor.ts はこれらを '../knowledge/routes' 経由ではなく直接
// '../../../lib/knowledge/faqImport' から import しているため別モックが必要)
const mockGenerateTextFaqPreview = jest.fn();
const mockGenerateScrapeFaqPreview = jest.fn();
const mockCommitTextFaqs = jest.fn();
const mockCommitScrapeFaqs = jest.fn();
jest.mock('../../../lib/knowledge/faqImport', () => ({
  generateTextFaqPreview: (...args: any[]) => mockGenerateTextFaqPreview(...args),
  generateScrapeFaqPreview: (...args: any[]) => mockGenerateScrapeFaqPreview(...args),
  commitTextFaqs: (...args: any[]) => mockCommitTextFaqs(...args),
  commitScrapeFaqs: (...args: any[]) => mockCommitScrapeFaqs(...args),
}));

// suggest_engagement_rule が使う依存をモック
const mockSuggestEngagementRuleFromText = jest.fn();
jest.mock('./engagementSuggest', () => ({
  suggestEngagementRuleFromText: (...args: any[]) => mockSuggestEngagementRuleFromText(...args),
}));

// request_sai_task が使う依存をモック
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

// get_chat_sessions / get_escalations / get_chat_session_messages /
// reply_to_escalation / resolve_escalation が使う依存をモック
const mockGetSessions = jest.fn();
const mockGetActiveEscalations = jest.fn();
const mockGetMessages = jest.fn();
const mockSaveMessage = jest.fn();
const mockResolveEscalation = jest.fn();
jest.mock('../chat-history/chatHistoryRepository', () => ({
  getSessions: (...args: any[]) => mockGetSessions(...args),
  getActiveEscalations: (...args: any[]) => mockGetActiveEscalations(...args),
  getMessages: (...args: any[]) => mockGetMessages(...args),
  saveMessage: (...args: any[]) => mockSaveMessage(...args),
  resolveEscalation: (...args: any[]) => mockResolveEscalation(...args),
}));

// get_monitoring_summary が使う依存をモック
const mockComputeKpis = jest.fn();
jest.mock('../monitoring/routes', () => ({
  computeKpis: (...args: any[]) => mockComputeKpis(...args),
}));

// get_analytics_summary / get_conversion_summary が使う依存をモック
const mockFetchAnalyticsSummary = jest.fn();
const mockFetchConversionSummary = jest.fn();
jest.mock('../analytics/summaryQueries', () => ({
  fetchAnalyticsSummary: (...args: any[]) => mockFetchAnalyticsSummary(...args),
  fetchConversionSummary: (...args: any[]) => mockFetchConversionSummary(...args),
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

// agentMetrics モック（挙動メトリクス。実DBへのINSERTを避けつつ発火内容を検証する）
const mockRecordAgentMetric = jest.fn();
jest.mock('../../../lib/metrics/agentMetrics', () => ({
  recordAgentMetric: (...args: any[]) => mockRecordAgentMetric(...args),
}));

/** mockRecordAgentMetric に記録された指定 metric_name の入力だけを取り出す */
function recordedMetrics(metricName: string): Array<Record<string, any>> {
  return mockRecordAgentMetric.mock.calls
    .map(([, input]) => input as Record<string, any>)
    .filter((input) => input?.metricName === metricName);
}

// agentAuditLog モック（設定変更の監査ログ。実DBへのINSERTを避けつつ記録内容を検証する）
const mockRecordAgentSettingsChange = jest.fn();
jest.mock('./agentAuditLog', () => ({
  recordAgentSettingsChange: (...args: any[]) => mockRecordAgentSettingsChange(...args),
}));

/** mockRecordAgentSettingsChange に記録された監査入力を取り出す */
function recordedSettingsChanges(): Array<Record<string, any>> {
  return mockRecordAgentSettingsChange.mock.calls.map(([, input]) => input as Record<string, any>);
}

// ---------------------------------------------------------------------------
// テスト対象を import
// ---------------------------------------------------------------------------

import { registerAdminAgentRoutes } from './agentRoutes';
import { ADMIN_AGENT_TOOLS, LEGACY_UI_FEATURES } from './toolDefinitions';
// ステージング(knowledgeImportStaging.ts)はモックせず実物を使う。
// suggest_faq_import_from_text/urls → commit_faq_import の2ターン検証、
// TTL/上限とは独立にテスト間の状態リークを防ぐためのリセット関数として使う。
import {
  getStagedFaqImport,
  __resetKnowledgeImportStagingForTest,
  __resetPlanLimitNoticesForTest,
} from './knowledgeImportStaging';

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
    // knowledgeImportStaging はモックしない実物のモジュールなので、
    // jest.resetAllMocks() では消えないプロセス内Mapをテストごとに明示的にリセットする。
    __resetKnowledgeImportStagingForTest();
    // プラン制限の「案内済み」フラグも同じプロセス内Mapのため、テストごとにリセットする
    // (残っていると次のテストが2回目扱いになり短い文が返る)。
    __resetPlanLimitNoticesForTest();
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

      // 挙動メトリクス: 成功したツール呼び出しは outcome=ok、ターン完了で hops/completed も記録される
      expect(recordedMetrics('agent_tool_invoked')).toEqual([
        {
          metricName: 'agent_tool_invoked',
          tenantId: 'tenant-abc',
          labels: { tool: 'get_tenant_settings', outcome: 'ok', surface: 'unknown' },
          value: 1,
        },
      ]);
      expect(recordedMetrics('agent_write_blocked')).toEqual([]);
      expect(recordedMetrics('agent_turn_hops')).toEqual([
        {
          metricName: 'agent_turn_hops',
          tenantId: 'tenant-abc',
          labels: { hit_limit: false, surface: 'unknown' },
          value: 1,
        },
      ]);
      expect(recordedMetrics('agent_turn_completed')).toEqual([
        {
          metricName: 'agent_turn_completed',
          tenantId: 'tenant-abc',
          labels: { answered_from: 'tool_action', surface: 'unknown' },
          value: 1,
        },
      ]);
    });

    it('ツール未使用のターンでも agent_turn_hops(0) と agent_turn_completed が記録される', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('設定を確認しました。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4の設定を教えて', sessionId: 'sess-metrics-01' });

      expect(res.status).toBe(200);
      expect(recordedMetrics('agent_tool_invoked')).toEqual([]);
      expect(recordedMetrics('agent_turn_hops')).toEqual([
        { metricName: 'agent_turn_hops', tenantId: 'tenant-abc', labels: { hit_limit: false, surface: 'unknown' }, value: 0 },
      ]);
      expect(recordedMetrics('agent_turn_completed')).toEqual([
        { metricName: 'agent_turn_completed', tenantId: 'tenant-abc', labels: { answered_from: 'general', surface: 'unknown' }, value: 1 },
      ]);
    });

    it('recordAgentMetric が throw / reject しても 200 と reply を返す（計測失敗は応答を壊さない）', async () => {
      mockRecordAgentMetric
        .mockImplementationOnce(() => {
          throw new Error('metrics sync boom');
        })
        .mockImplementation(() => Promise.reject(new Error('metrics async boom')));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-metrics-err',
                  type: 'function',
                  function: { name: 'get_tenant_settings', arguments: '{}' },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('GA4は未設定です。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ ga4_measurement_id: null, posthog_host: null, widget_theme: {} }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-metrics-02' });

      expect(res.status).toBe(200);
      expect(res.body.reply).toBe('GA4は未設定です。');
      expect(res.body.actions[0].tool).toBe('get_tenant_settings');
      expect(res.body.answered_from).toBe('tool_action');
    });
  });

  // -------------------------------------------------------------------------
  // GID 1217008695995707: どちらのチャットUI(パネル/全画面)から来たターンかを
  // 全メトリクスの surface ラベルに載せる。docs/CHAT_SURFACE_DECISION.md の
  // 「全画面UIが実際に主たる面になりつつあるのか」は面ごとの数字がないと答えられないため、
  // 1つでもラベルが欠けたメトリクスがあるとその指標だけ面別に切れなくなる。
  // -------------------------------------------------------------------------
  describe('surface ラベル', () => {
    /**
     * get_legacy_ui_link を1回呼ぶターン。この1リクエストで
     * agent_tool_invoked / agent_legacy_handoff / agent_turn_hops / agent_turn_completed
     * の4種が発火するので、「そのターンの全メトリクス」をまとめて検証できる。
     */
    function mockLegacyHandoffTurn() {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-surface',
                  type: 'function',
                  function: { name: 'get_legacy_ui_link', arguments: JSON.stringify({ feature: 'billing' }) },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('旧管理画面をご確認ください。'));
    }

    /** 記録された全メトリクスを [metric_name, labels.surface] の組で取り出す */
    function recordedSurfaces(): Array<[string, unknown]> {
      return mockRecordAgentMetric.mock.calls.map(([, input]) => [
        (input as Record<string, any>).metricName,
        (input as Record<string, any>).labels?.surface,
      ]);
    }

    it.each(['panel', 'fullscreen'])(
      'surface=%s → そのターンに記録された全メトリクスが同じ値のラベルを持つ',
      async (surface) => {
        mockLegacyHandoffTurn();

        const res = await request(makeApp(CLIENT_ADMIN_USER))
          .post('/v1/admin/agent/chat')
          .send({ message: '請求書を再送したい', sessionId: 'sess-surface-01', surface });

        expect(res.status).toBe(200);
        // 4種すべてが発火していることを固定する(取りこぼすと、その指標だけ面別に切れなくなる)
        expect(recordedSurfaces().map(([name]) => name).sort()).toEqual([
          'agent_legacy_handoff',
          'agent_tool_invoked',
          'agent_turn_completed',
          'agent_turn_hops',
        ]);
        expect(recordedSurfaces()).toEqual(recordedSurfaces().map(([name]) => [name, surface]));
      },
    );

    it('surface=panel: 確認ゲートでブロックされた書き込み(agent_write_blocked)にも載る', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call-surface-blocked',
                  type: 'function',
                  function: { name: 'update_tuning_rule', arguments: JSON.stringify({ id: 1, is_active: false }) },
                }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('確認をお願いします。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を無効にして', sessionId: 'sess-surface-02', surface: 'panel' });

      expect(res.status).toBe(200);
      expect(recordedMetrics('agent_write_blocked')).toEqual([
        {
          metricName: 'agent_write_blocked',
          tenantId: 'tenant-abc',
          labels: { tool: 'update_tuning_rule', reason: 'unconfirmed', surface: 'panel' },
          value: 1,
        },
      ]);
    });

    it('surface を送らない既存クライアントは 200 のまま、unknown として記録される(後方互換)', async () => {
      mockLegacyHandoffTurn();

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '請求書を再送したい', sessionId: 'sess-surface-03' });

      // 必須項目にしていないので、送ってこないクライアントを拒否してはならない
      expect(res.status).toBe(200);
      expect(recordedSurfaces()).toEqual(recordedSurfaces().map(([name]) => [name, 'unknown']));
    });

    it('surface が enum 外のリテラルなら 400 で弾く(unknown へ黙って丸めない)', async () => {
      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '請求書を再送したい', sessionId: 'sess-surface-04', surface: 'mobile' });

      // 語彙はサーバ側で閉じる。黙って unknown に丸めると、面を名乗らないクライアントと
      // 未知の面を名乗るクライアントが同じバケツに入って区別できなくなる。
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      // バリデーションで落ちたターンは計測もしない
      expect(mockRecordAgentMetric).not.toHaveBeenCalled();
    });
  });

  describe('answered_from / 未回答質問の自動記録', () => {
    it('ツール未使用の通常回答 → answered_from は general、admin_feedback は記録されない', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('設定を確認しました。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4の設定を教えて', sessionId: 'sess-af-01' });

      expect(res.status).toBe(200);
      expect(res.body.answered_from).toBe('general');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('ツール未使用かつ回答が未回答フレーズを含む → answered_from は general、admin_feedback に knowledge_gap で記録される', async () => {
      mockFetch.mockResolvedValueOnce(makeGroqResponse('申し訳ございません、その情報は登録されていません。'));
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '割引クーポンはありますか', sessionId: 'sess-af-02' });

      expect(res.status).toBe(200);
      expect(res.body.answered_from).toBe('general');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO admin_feedback');
      expect(sql).toContain('knowledge_gap');
      expect(params).toEqual([
        'tenant-abc',
        null,
        '割引クーポンはありますか',
        '申し訳ございません、その情報は登録されていません。',
      ]);
    });

    it('get_faq_list を使って回答 → answered_from は faq_list', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_faq_list', arguments: '{}' } }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('送料についてのFAQが見つかりました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, question: 'q', answer: 'a' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料について教えて', sessionId: 'sess-af-03' });

      expect(res.status).toBe(200);
      expect(res.body.answered_from).toBe('faq_list');
    });

    it('get_faq_list 以外のツールを使用 → answered_from は tool_action、回答が未回答フレーズでも記録されない', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_tenant_settings', arguments: '{}' } }],
              },
            }],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(makeGroqResponse('申し訳ございません、確認できませんでした。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ ga4_measurement_id: null, posthog_host: null, widget_theme: {} }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '設定を確認して', sessionId: 'sess-af-04' });

      expect(res.status).toBe(200);
      expect(res.body.answered_from).toBe('tool_action');
      // get_tenant_settings の SELECT 1回のみ。admin_feedback への INSERT は発火しない
      expect(mockQuery).toHaveBeenCalledTimes(1);
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

      // 挙動メトリクス: 確認ゲートでのブロックは outcome=blocked + reason=unconfirmed
      expect(recordedMetrics('agent_tool_invoked')).toEqual([
        {
          metricName: 'agent_tool_invoked',
          tenantId: 'tenant-abc',
          labels: { tool: 'update_tuning_rule', outcome: 'blocked', surface: 'unknown' },
          value: 1,
        },
      ]);
      expect(recordedMetrics('agent_write_blocked')).toEqual([
        {
          metricName: 'agent_write_blocked',
          tenantId: 'tenant-abc',
          labels: { tool: 'update_tuning_rule', reason: 'unconfirmed', surface: 'unknown' },
          value: 1,
        },
      ]);
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
  // generate_tuning_rule_test_responses / approve_tuning_rule_response / remove_approved_response
  // -------------------------------------------------------------------------
  describe('generate_tuning_rule_test_responses / approve_tuning_rule_response / remove_approved_response', () => {
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

    it('generate_tuning_rule_test_responses: 3案を1つの結果文字列にまとめる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-1', 'generate_tuning_rule_test_responses', { id: 1 }))
        .mockResolvedValueOnce(makeGroqResponse('3案作りました。'));

      mockGenerateTestResponses.mockResolvedValueOnce({
        ok: true,
        responses: [
          { style: '丁寧版', text: '2年間の保証がございます。' },
          { style: '簡潔版', text: '保証は2年です。' },
        ],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1のテスト返答を見せて', sessionId: 'sess-tt-01' });

      expect(res.status).toBe(200);
      expect(mockGenerateTestResponses).toHaveBeenCalledWith(1, 'tenant-abc', false);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('丁寧版');
      expect(result).toContain('2年間の保証がございます。');
    });

    it('generate_tuning_rule_test_responses: not_found → その旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-2', 'generate_tuning_rule_test_responses', { id: 999 }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      mockGenerateTestResponses.mockResolvedValueOnce({ ok: false, reason: 'not_found' });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール999のテスト返答を見せて', sessionId: 'sess-tt-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('見つかりません');
    });

    it('approve_tuning_rule_response: confirmed=false → 保存されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-3', 'approve_tuning_rule_response', { id: 1, text: 'x', style: '丁寧版', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから採用します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'これを採用して', sessionId: 'sess-tt-03' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockUpdateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('approve_tuning_rule_response: confirmed=true・自テナント → 既存配列に追加してupdateRuleが呼ばれる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-4', 'approve_tuning_rule_response', { id: 1, text: '2年です', style: '簡潔版', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('採用しました。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ tenant_id: 'tenant-abc', approved_responses: [{ text: '既存', style: '丁寧版', approved_at: '2026-01-01T00:00:00Z' }] }],
      });
      mockUpdateRule.mockResolvedValueOnce({ id: 1 });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'これを採用して', sessionId: 'sess-tt-04' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).toHaveBeenCalledWith(
        1,
        { approved_responses: expect.arrayContaining([
          expect.objectContaining({ text: '既存' }),
          expect.objectContaining({ text: '2年です', style: '簡潔版' }),
        ]) },
        'tenant-abc',
      );
      expect(res.body.actions[0].result).toContain('現在2件採用済み');
    });

    it('approve_tuning_rule_response: 他テナントのルール → アクセス権限がありませんと返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-5', 'approve_tuning_rule_response', { id: 1, text: 'x', style: '丁寧版', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('権限がありません。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 'other-tenant', approved_responses: [] }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'これを採用して', sessionId: 'sess-tt-05' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('アクセス権限がありません');
    });

    it('remove_approved_response: confirmed=false → 取り消されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-6', 'remove_approved_response', { id: 1, index: 0, confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから取り消します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '1番目の採用を取り消して', sessionId: 'sess-tt-07' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('remove_approved_response: confirmed=true・自テナント → 該当indexを除いた配列でupdateRuleが呼ばれる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-8', 'remove_approved_response', { id: 1, index: 0, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('取り消しました。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ tenant_id: 'tenant-abc', approved_responses: [
          { text: 'A', style: '丁寧版', approved_at: '2026-01-01T00:00:00Z' },
          { text: 'B', style: '簡潔版', approved_at: '2026-01-02T00:00:00Z' },
        ] }],
      });
      mockUpdateRule.mockResolvedValueOnce({ id: 1 });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '1番目の採用を取り消して', sessionId: 'sess-tt-09' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).toHaveBeenCalledWith(
        1,
        { approved_responses: [expect.objectContaining({ text: 'B' })] },
        'tenant-abc',
      );
      expect(res.body.actions[0].result).toContain('残り1件');
    });

    it('remove_approved_response: 範囲外のindex → その旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-tt-10', 'remove_approved_response', { id: 1, index: 5, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('存在しません。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ tenant_id: 'tenant-abc', approved_responses: [{ text: 'A', style: '丁寧版', approved_at: '2026-01-01T00:00:00Z' }] }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '6番目の採用を取り消して', sessionId: 'sess-tt-11' });

      expect(res.status).toBe(200);
      expect(mockUpdateRule).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('存在しません');
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
        .mockResolvedValueOnce({ rows: [{ n: 8, total: '96000' }] }) // 成約
        .mockResolvedValueOnce({ rows: [{ n: 37 }] }) // FAQ総数
        .mockResolvedValueOnce({ rows: [{ n: 30 }] }) // 公開FAQ数
        .mockResolvedValueOnce({ rows: [{ max: '2026-07-20T03:00:00.000Z' }] }); // FAQ最終更新日

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
      expect(result).toContain('FAQ 37件（公開 30件・最終更新 2026-07-20）');
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
  // get_faq_list: 表示件数(上限20)と総数(COUNT)は別物
  // -------------------------------------------------------------------------
  describe('get_faq_list', () => {
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

    it('総数が表示上限(20件)を超える場合、頭打ちにせず正しい総数を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-1', 'get_faq_list'))
        .mockResolvedValueOnce(makeGroqResponse('FAQは合計25件です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 25 }] }) // COUNT(*)
        .mockResolvedValueOnce({
          rows: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, question: `q${i}`, answer: `a${i}` })),
        }); // 表示用(デフォルトlimit=10)

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQは何件ある?', sessionId: 'sess-fl-01' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('全25件中10件を表示');
    });

    it('総数が表示件数と同じ場合は「全N件中」を出さない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-2', 'get_faq_list'))
        .mockResolvedValueOnce(makeGroqResponse('FAQは3件です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 3 }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 1, question: 'q1', answer: 'a1' },
            { id: 2, question: 'q2', answer: 'a2' },
            { id: 3, question: 'q3', answer: 'a3' },
          ],
        });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQ一覧を見せて', sessionId: 'sess-fl-02' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('FAQ 一覧（3件）:');
      expect(result).not.toContain('全');
    });

    it('FAQが0件のとき「登録されていません」を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-3', 'get_faq_list'))
        .mockResolvedValueOnce(makeGroqResponse('まだ登録がありません。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQ一覧を見せて', sessionId: 'sess-fl-03' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('FAQ が登録されていません');
    });

    it('21件登録・limit=20指定 → 「全21件中20件を表示」となり20で頭打ちにならない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-4', 'get_faq_list', { limit: 20 }))
        .mockResolvedValueOnce(makeGroqResponse('FAQは合計21件です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 21 }] }) // COUNT(*)
        .mockResolvedValueOnce({
          rows: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, question: `q${i}`, answer: `a${i}` })),
        });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQは何件ある?', sessionId: 'sess-fl-04' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('全21件中20件を表示');
    });

    it.each([
      { input: 0, expected: 1 },
      { input: -1, expected: 1 },
      { input: 999, expected: 20 },
    ])('limit=$input は例外にならず$expectedにクランプされてSQLに渡る', async ({ input, expected }) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse(`call-fl-clamp-${input}`, 'get_faq_list', { limit: input }))
        .mockResolvedValueOnce(makeGroqResponse('FAQ一覧です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, question: 'q1', answer: 'a1' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQ一覧を見せて', sessionId: `sess-fl-clamp-${input}` });

      expect(res.status).toBe(200);
      // 1件目=COUNT(*)（tenant_idのみ）、2件目=一覧取得（tenant_id + limit）
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['tenant-abc', expected]);
    });

    it('limit="abc"（数値でない）は例外にならず既定件数(10)にフォールバックしてFAQ一覧が正しく返る', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-clamp-abc', 'get_faq_list', { limit: 'abc' }))
        .mockResolvedValueOnce(makeGroqResponse('FAQ一覧です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, question: 'q1', answer: 'a1' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQ一覧を見せて', sessionId: 'sess-fl-clamp-abc' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).not.toContain('取得に失敗しました');
      expect(result).toContain('FAQ 一覧（1件）:');
      // NaN のまま LIMIT の SQL パラメータに渡らず、既定値10にフォールバックしていることを確認する
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['tenant-abc', 10]);
    });

    it('他テナントで呼び出すと0件になり、かつSQLに自テナントのtenant_idが渡る（テナント越境なし）', async () => {
      const OTHER_TENANT_USER = { app_metadata: { role: 'client_admin', tenant_id: 'tenant-other' } };

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-5', 'get_faq_list'))
        .mockResolvedValueOnce(makeGroqResponse('FAQは登録されていません。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(OTHER_TENANT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQ一覧を見せて', sessionId: 'sess-fl-06' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('FAQ が登録されていません');
      // COUNT(*)クエリにも一覧クエリにも自テナント("tenant-other")のIDが渡っており、
      // 他テナント("tenant-abc")のデータが混ざっていないことを確認する
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(['tenant-other']);
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['tenant-other', 10]);
    });

    it('search指定時、総数(COUNT)も検索条件で絞り込まれた件数になる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-7', 'get_faq_list', { search: '送料' }))
        .mockResolvedValueOnce(makeGroqResponse('「送料」に関するFAQは4件です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 4 }] }) // 「送料」でILIKE絞り込んだ後のCOUNT
        .mockResolvedValueOnce({
          rows: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, question: `送料q${i}`, answer: `a${i}` })),
        });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料についてのFAQは何件ある?', sessionId: 'sess-fl-08' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('FAQ 一覧（4件）:');

      // COUNT(*)クエリ自体にもILIKE(検索条件)が含まれ、かつ検索語が渡っていることを確認する
      // (総数がsearch適用前の全件になっていないことの担保)
      const countCallSql = mockQuery.mock.calls[0]?.[0] as string;
      const countCallParams = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(countCallSql).toContain('ILIKE');
      expect(countCallParams).toEqual(['tenant-abc', '%送料%']);
    });

    it('FAQは存在するが search がヒットしない場合は「登録されていません」ではなく検索条件に言及した文言を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-11', 'get_faq_list', { search: '存在しないキーワード' }))
        .mockResolvedValueOnce(makeGroqResponse('一致するFAQは見つかりませんでした。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // 「存在しないキーワード」に一致するFAQは0件
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '存在しないキーワードのFAQはある?', sessionId: 'sess-fl-12' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      // FAQ自体は登録されている可能性があるテナントに「登録されていません」と誤答してはいけない
      expect(result).not.toContain('FAQ が登録されていません');
      expect(result).toContain('存在しないキーワード');
      expect(result).toContain('見つかりませんでした');
    });

    it('DB失敗時は例外を投げず日本語1行のエラーメッセージを返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fl-9', 'get_faq_list'))
        .mockResolvedValueOnce(makeGroqResponse('取得に失敗しました。'));

      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQ一覧を見せて', sessionId: 'sess-fl-10' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toBe('FAQ 一覧の取得に失敗しました');
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
  // チャット版 FAQ一括取り込み: suggest_faq_import_from_text / suggest_faq_import_from_urls
  // / commit_faq_import / discard_faq_import（プロセス内ステージング経由）
  // -------------------------------------------------------------------------
  describe('suggest_faq_import_from_text/urls / commit_faq_import / discard_faq_import', () => {
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

    const faq1 = { question: '送料はいくらですか？', answer: '550円です。', category: 'store_info', duplicate: null };
    const faq2 = { question: '送料無料の条件は？', answer: '5000円以上です。', category: 'store_info', duplicate: null };

    it('suggest_faq_import_from_text: プレビューを生成しステージングする(DB書き込みなし)', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-1', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));

      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1, faq2]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'このテキストからFAQを作って', sessionId: 'sess-fi-01' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      const result = res.body.actions[0].result as string;
      expect(result).toContain('2件のFAQ案を作成しました');
      expect(result).toContain('送料はいくらですか');

      const staged = getStagedFaqImport('tenant-abc', 'sess-fi-01');
      expect(staged).not.toBeNull();
      expect(staged?.kind).toBe('text');
    });

    it('suggest_faq_import_from_text: text が短すぎる場合は生成せずエラーを返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-2', 'suggest_faq_import_from_text', { text: '短い' }))
        .mockResolvedValueOnce(makeGroqResponse('もう少し詳しく教えてください。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '短いテキストから作って', sessionId: 'sess-fi-03' });

      expect(res.status).toBe(200);
      expect(mockGenerateTextFaqPreview).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('50文字以上');
    });

    it('suggest_faq_import_from_urls: 複数URLのプレビューを合算してステージングする', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-4', 'suggest_faq_import_from_urls', { urls: ['https://example.com/p/1', 'https://example.com/p/2'] }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));

      mockGenerateScrapeFaqPreview.mockResolvedValueOnce([
        { url: 'https://example.com/p/1', faqs: [faq1] },
        { url: 'https://example.com/p/2', faqs: [faq2] },
      ]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'このURLたちからFAQを作って', sessionId: 'sess-fi-05' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('2件のURLから合計2件のFAQ案を作成しました');

      const staged = getStagedFaqImport('tenant-abc', 'sess-fi-05');
      expect(staged?.kind).toBe('scrape');
    });

    it('suggest_faq_import_from_urls: urlsが6件以上ならエラーを返しgenerateScrapeFaqPreviewは呼ばない', async () => {
      const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/p/${i}`);
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-6', 'suggest_faq_import_from_urls', { urls }))
        .mockResolvedValueOnce(makeGroqResponse('URLは5件までです。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'たくさんのURLから作って', sessionId: 'sess-fi-07' });

      expect(res.status).toBe(200);
      expect(mockGenerateScrapeFaqPreview).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('1〜5件');
    });

    it('commit_faq_import: プレビュー無しで呼ぶと弾かれる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-8', 'commit_faq_import', { confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('先にプレビューが必要です。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-fi-09' });

      expect(res.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      expect(mockCommitScrapeFaqs).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('プレビューがありません');
    });

    it('commit_faq_import: confirmed=false → 登録されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-10', 'commit_faq_import', { confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから登録します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-fi-11' });

      expect(res.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('suggest → commit の2ターンでテキスト由来のFAQが登録され、ステージングはクリアされる', async () => {
      // ターン1: プレビュー生成
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-12a', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1, faq2]);

      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'このテキストからFAQを作って', sessionId: 'sess-fi-12' });

      // ターン2: コミット（新しいHTTPリクエスト = 別ターン。同一 sessionId で継続）
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-12b', 'commit_faq_import', { confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('登録しました。'));
      mockCommitTextFaqs.mockResolvedValueOnce({ inserted: 2, skipped: 0, insertedIds: [10, 11] });

      const res2 = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-fi-12' });

      expect(res2.status).toBe(200);
      expect(mockCommitTextFaqs).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-abc',
        [faq1, faq2],
        undefined,
        'admin_agent_text_import',
      );
      expect(res2.body.actions[0].result).toContain('FAQを2件登録しました');
      expect(getStagedFaqImport('tenant-abc', 'sess-fi-12')).toBeNull();
    });

    it('commit_faq_import: target=global はSuper Admin以外だと拒否される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-13a', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);
      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-13' });

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-13b', 'commit_faq_import', { confirmed: true, target: 'global' }))
        .mockResolvedValueOnce(makeGroqResponse('拒否されました。'));

      const res2 = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '全店舗共通に登録して', sessionId: 'sess-fi-13' });

      expect(res2.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      expect(res2.body.actions[0].result).toContain('Super Adminのみ登録可能');
    });

    it('commit_faq_import: target=他テナントID はSuper Admin以外だと拒否される（越境書き込み防止）', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-13c', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);
      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-13c' });

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-13d', 'commit_faq_import', { confirmed: true, target: 'tenant-other' }))
        .mockResolvedValueOnce(makeGroqResponse('拒否されました。'));

      const res2 = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'tenant-otherに登録して', sessionId: 'sess-fi-13c' });

      expect(res2.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      expect(res2.body.actions[0].result).toContain('他のテナントには登録できません');
    });

    it('commit_faq_import: super_admin は target=他テナントID を指定して登録できる（越境ガードはclient_admin限定）', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-13e', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);
      await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-13e', targetTenantId: 'tenant-other' });

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-13f', 'commit_faq_import', { confirmed: true, target: 'tenant-other' }))
        .mockResolvedValueOnce(makeGroqResponse('登録しました。'));
      mockCommitTextFaqs.mockResolvedValueOnce({ inserted: 1, skipped: 0, insertedIds: [20] });

      const res2 = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-fi-13e', targetTenantId: 'tenant-other' });

      expect(res2.status).toBe(200);
      expect(mockCommitTextFaqs).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-other',
        [faq1],
        undefined,
        'admin_agent_text_import',
      );
      expect(res2.body.actions[0].result).toContain('FAQを1件登録しました');
    });

    it('別 sessionId のステージングは混ざらない（テナントは同じでもプレビュー無し扱いになる）', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-14a', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);
      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-15-a' });

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-14b', 'commit_faq_import', { confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューが見つかりません。'));

      const res2 = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-fi-15-b' });

      expect(res2.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      expect(res2.body.actions[0].result).toContain('プレビューがありません');
    });

    it('別テナントのステージングは混ざらない（テナント越境しない）', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-16a', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);
      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-17' });

      // 同じ sessionId・別テナント(super_adminがtargetTenantIdで別テナントを指定)でcommitを試みる
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-16b', 'commit_faq_import', { confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューが見つかりません。'));

      const res2 = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-fi-17', targetTenantId: 'tenant-other' });

      expect(res2.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      expect(res2.body.actions[0].result).toContain('プレビューがありません');
    });

    it('discard_faq_import: ステージング済みプレビューを破棄し、以後のcommitはプレビュー無し扱いになる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-18a', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('プレビューを作成しました。'));
      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);
      await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-19' });

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-18b', 'discard_faq_import', {}))
        .mockResolvedValueOnce(makeGroqResponse('破棄しました。'));

      const res2 = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'やめておいて', sessionId: 'sess-fi-19' });

      expect(res2.status).toBe(200);
      expect(res2.body.actions[0].result).toContain('破棄しました');
      expect(getStagedFaqImport('tenant-abc', 'sess-fi-19')).toBeNull();
    });

    it('同一ターン内で suggest_faq_import_from_text → commit_faq_import(confirmed=true) を連鎖しようとするとブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-20a', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(toolCallResponse('call-fi-20b', 'commit_faq_import', { confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('確認をお願いします。'));

      mockGenerateTextFaqPreview.mockResolvedValueOnce([faq1]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って登録して', sessionId: 'sess-fi-21' });

      expect(res.status).toBe(200);
      expect(mockCommitTextFaqs).not.toHaveBeenCalled();
      const commitAction = res.body.actions.find((a: any) => a.tool === 'commit_faq_import');
      expect(commitAction.result).toContain('同一ターン内での連続実行');
    });

    it('テナント未特定: super_adminがtarget未指定でsuggest_faq_import_from_textを呼ぶと弾かれる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-fi-22', 'suggest_faq_import_from_text', { text: '十分な長さの商品説明文です。'.repeat(5) }))
        .mockResolvedValueOnce(makeGroqResponse('テナントを指定してください。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを作って', sessionId: 'sess-fi-23' });

      expect(res.status).toBe(200);
      expect(mockGenerateTextFaqPreview).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('テナントが特定できません');
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
      // GID 1216944003337186: trackUsage計測のためtenantIdも渡すようになった
      expect(mockSuggestEngagementRuleFromText).toHaveBeenCalledWith('商品ページを長く見てる人にランキングを勧めたい', 'tenant-abc');
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
  // get_engagement_rules / update_engagement_rule / delete_engagement_rule
  // -------------------------------------------------------------------------
  describe('get_engagement_rules / update_engagement_rule / delete_engagement_rule', () => {
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

    it('get_engagement_rules: 一覧を1つの結果文字列にまとめる（無効ルールは(無効)を付ける）', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-1', 'get_engagement_rules', {}))
        .mockResolvedValueOnce(makeGroqResponse('現在2件のルールがあります。'));

      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, trigger_type: 'idle_time', message_template: '人気ランキングもご覧ください🎁', is_active: true, priority: 5 },
          { id: 2, trigger_type: 'exit_intent', message_template: 'お待ちください', is_active: false, priority: 0 },
        ],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '声がけルールを見せて', sessionId: 'sess-er-01' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM trigger_rules WHERE tenant_id = $1'), ['tenant-abc']);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('2件');
      expect(result).toContain('idle_time');
      expect(result).toContain('exit_intent');
      expect(result).toContain('(無効)');
    });

    it('get_engagement_rules: 0件の場合は「登録されていません」と返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-2', 'get_engagement_rules', {}))
        .mockResolvedValueOnce(makeGroqResponse('声がけルールはまだありません。'));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '声がけルールを見せて', sessionId: 'sess-er-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('登録されていません');
    });

    it('update_engagement_rule: confirmed=false → 更新されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-3', 'update_engagement_rule', { id: 1, is_active: false, confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから更新します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を無効にして', sessionId: 'sess-er-03' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('update_engagement_rule: 変更内容が空 → DB呼び出しせずその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-4', 'update_engagement_rule', { id: 1, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('変更内容を教えてください。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を更新して', sessionId: 'sess-er-04' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('変更する内容がありません');
    });

    it('update_engagement_rule: client_admin・他テナントのルール → アクセス権限がありませんと返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-5', 'update_engagement_rule', { id: 1, is_active: false, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('権限がありません。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'other-tenant' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を無効にして', sessionId: 'sess-er-05' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledTimes(1); // SELECT のみ、UPDATE は発火しない
      expect(res.body.actions[0].result).toContain('アクセス権限がありません');
    });

    it('update_engagement_rule: confirmed=true・自テナント → is_activeのみCOALESCE更新される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-6', 'update_engagement_rule', { id: 1, is_active: false, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('無効にしました。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] }) // SELECT ownership
        .mockResolvedValueOnce({ rows: [{ id: 1, trigger_type: 'idle_time', message_template: 'x', is_active: false }] }); // UPDATE

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を無効にして', sessionId: 'sess-er-06' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('UPDATE trigger_rules'),
        [null, null, null, null, false, 1],
      );
      expect(res.body.actions[0].result).toContain('現在無効');
    });

    it('delete_engagement_rule: confirmed=false → 削除されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-7', 'delete_engagement_rule', { id: 1, confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから削除します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を削除して', sessionId: 'sess-er-07' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('delete_engagement_rule: confirmed=true・自テナント → 削除される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-8', 'delete_engagement_rule', { id: 1, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('削除しました。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] }) // SELECT ownership
        .mockResolvedValueOnce({ rows: [] }); // DELETE

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール1を削除して', sessionId: 'sess-er-08' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenLastCalledWith('DELETE FROM trigger_rules WHERE id = $1', [1]);
      expect(res.body.actions[0].result).toContain('削除しました');
    });

    it('delete_engagement_rule: 対象が見つからない場合はその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-9', 'delete_engagement_rule', { id: 999, confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT: 見つからない

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ルール999を削除して', sessionId: 'sess-er-09' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('見つかりません');
    });
  });

  // -------------------------------------------------------------------------
  // get_chat_sessions / get_escalations / get_monitoring_summary
  // -------------------------------------------------------------------------
  describe('get_chat_sessions / get_escalations / get_monitoring_summary', () => {
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

    it('get_chat_sessions: 一覧を1つの結果文字列にまとめる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-rd-1', 'get_chat_sessions', {}))
        .mockResolvedValueOnce(makeGroqResponse('直近の会話は2件です。'));

      mockGetSessions.mockResolvedValueOnce({
        sessions: [
          { id: 'db-1', tenant_id: 'tenant-abc', session_id: 'sess-aaaaaaaa-1111', started_at: '2026-07-17T10:00:00Z', last_message_at: '2026-07-17T10:05:00Z', message_count: 4, first_message_preview: '送料はいくらですか', outcome: null, outcome_recorded_at: null },
        ],
        total: 42,
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '最近の会話を見せて', sessionId: 'sess-rd-01' });

      expect(res.status).toBe(200);
      expect(mockGetSessions).toHaveBeenCalledWith({ tenantId: 'tenant-abc', limit: 10 });
      const result = res.body.actions[0].result as string;
      expect(result).toContain('全42件中1件');
      expect(result).toContain('送料はいくらですか');
    });

    it('get_chat_sessions: 0件の場合は「ありません」と返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-rd-2', 'get_chat_sessions', {}))
        .mockResolvedValueOnce(makeGroqResponse('まだ会話はありません。'));

      mockGetSessions.mockResolvedValueOnce({ sessions: [], total: 0 });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '最近の会話を見せて', sessionId: 'sess-rd-03' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('ありません');
    });

    it('get_chat_sessions: limit="abc"（数値でない）は例外にならず既定件数(10)にフォールバックする', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-rd-abc', 'get_chat_sessions', { limit: 'abc' }))
        .mockResolvedValueOnce(makeGroqResponse('直近の会話です。'));

      mockGetSessions.mockResolvedValueOnce({
        sessions: [
          { id: 'db-1', tenant_id: 'tenant-abc', session_id: 'sess-aaaaaaaa-1111', started_at: '2026-07-17T10:00:00Z', last_message_at: '2026-07-17T10:05:00Z', message_count: 4, first_message_preview: '送料はいくらですか', outcome: null, outcome_recorded_at: null },
        ],
        total: 1,
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '最近の会話を見せて', sessionId: 'sess-rd-abc' });

      expect(res.status).toBe(200);
      // NaN のまま渡らず、既定値10にフォールバックしていることを確認する
      expect(mockGetSessions).toHaveBeenCalledWith({ tenantId: 'tenant-abc', limit: 10 });
      expect(res.body.actions[0].result).toContain('送料はいくらですか');
    });

    it('get_escalations: 対応中の一覧を1つの結果文字列にまとめる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-rd-4', 'get_escalations', {}))
        .mockResolvedValueOnce(makeGroqResponse('1件対応中です。'));

      mockGetActiveEscalations.mockResolvedValueOnce([
        { id: 'db-2', tenant_id: 'tenant-abc', session_id: 'sess-bbbbbbbb-2222', escalated_at: '2026-07-17T12:00:00Z', last_message_at: '2026-07-17T12:05:00Z', message_count: 6, first_message_preview: '返品したいです' },
      ]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'エスカレーションを見せて', sessionId: 'sess-rd-05' });

      expect(res.status).toBe(200);
      expect(mockGetActiveEscalations).toHaveBeenCalledWith('tenant-abc');
      const result = res.body.actions[0].result as string;
      expect(result).toContain('1件');
      expect(result).toContain('返品したいです');
    });

    it('get_escalations: 0件の場合は「ありません」と返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-rd-6', 'get_escalations', {}))
        .mockResolvedValueOnce(makeGroqResponse('対応中のものはありません。'));

      mockGetActiveEscalations.mockResolvedValueOnce([]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'エスカレーションを見せて', sessionId: 'sess-rd-07' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('ありません');
    });

    it('get_monitoring_summary: 完了率・フォールバック率を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-rd-8', 'get_monitoring_summary', {}))
        .mockResolvedValueOnce(makeGroqResponse('完了率は良好です。'));

      mockComputeKpis.mockResolvedValueOnce({ completionRate: 92.5, fallbackRate: 3.2, totalSessions: 142 });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '状況を見せて', sessionId: 'sess-rd-09' });

      expect(res.status).toBe(200);
      expect(mockComputeKpis).toHaveBeenCalledWith(mockDb, 'tenant-abc');
      const result = res.body.actions[0].result as string;
      expect(result).toContain('142件');
      expect(result).toContain('92.5%');
      expect(result).toContain('3.2%');
    });
  });

  // -------------------------------------------------------------------------
  // get_chat_session_messages（短縮IDでの会話本文取得 / テナント境界）
  // -------------------------------------------------------------------------
  describe('get_chat_session_messages', () => {
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

    type SessionRow = { id: string; tenant_id: string; session_id: string };

    const OWN_SESSION: SessionRow = {
      id: 'db-sess-own', tenant_id: 'tenant-abc', session_id: 'a1b2c3d4-1111-4aaa-8000-000000000001',
    };
    const OTHER_TENANT_SESSION: SessionRow = {
      id: 'db-sess-other', tenant_id: 'tenant-zzz', session_id: 'ffeeddcc-9999-4bbb-8000-000000000002',
    };
    const DUP_A: SessionRow = {
      id: 'db-sess-dup-a', tenant_id: 'tenant-abc', session_id: 'dupdup00-1111-4ccc-8000-000000000003',
    };
    const DUP_B: SessionRow = {
      id: 'db-sess-dup-b', tenant_id: 'tenant-abc', session_id: 'dupdup00-2222-4ddd-8000-000000000004',
    };

    // resolveSessionByShortId の SQL（tenant_id = $1 AND session_id LIKE $2 || '%'）を
    // 忠実に再現する。テナント越境が「SQLの条件で」防がれていることを検証するため、
    // 固定の rows を返すのではなく tenant_id + 前方一致でフィルタする。
    function seedSessions(rows: SessionRow[]) {
      mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
        if (!Array.isArray(params)) return { rows: [] };
        const [tenantId, prefix] = params as [string, string];
        return {
          rows: rows
            .filter((r) => r.tenant_id === tenantId && r.session_id.startsWith(prefix))
            .map((r) => ({ id: r.id, session_id: r.session_id })),
        };
      });
    }

    it('自テナントのセッションは短縮IDで本文を取得できる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cm-1', 'get_chat_session_messages', { session_id: 'a1b2c3d4' }))
        .mockResolvedValueOnce(makeGroqResponse('会話内容はこちらです。'));

      seedSessions([OWN_SESSION, OTHER_TENANT_SESSION]);
      mockGetMessages.mockResolvedValueOnce([
        { id: 1, role: 'user', content: '送料はいくらですか', metadata: {}, created_at: '2026-07-17T10:00:00Z' },
        { id: 2, role: 'assistant', content: '全国一律500円です', metadata: {}, created_at: '2026-07-17T10:00:10Z' },
        { id: 3, role: 'operator', content: '担当より補足します', metadata: {}, created_at: '2026-07-17T10:01:00Z' },
      ]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'a1b2c3d4の会話を見せて', sessionId: 'sess-cm-01' });

      expect(res.status).toBe(200);
      expect(mockGetMessages).toHaveBeenCalledWith({ sessionDbId: 'db-sess-own', tenantId: 'tenant-abc' });
      const result = res.body.actions[0].result as string;
      expect(result).toContain('お客様: 送料はいくらですか');
      expect(result).toContain('AI: 全国一律500円です');
      expect(result).toContain('担当者: 担当より補足します');
      expect(result).toContain('全3件中3件');
    });

    it('limit で新しい方から件数を絞る', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cm-2', 'get_chat_session_messages', { session_id: 'a1b2c3d4', limit: 2 }))
        .mockResolvedValueOnce(makeGroqResponse('直近2件です。'));

      seedSessions([OWN_SESSION]);
      mockGetMessages.mockResolvedValueOnce([
        { id: 1, role: 'user', content: '古い質問', metadata: {}, created_at: '2026-07-17T10:00:00Z' },
        { id: 2, role: 'user', content: '新しい質問', metadata: {}, created_at: '2026-07-17T10:01:00Z' },
        { id: 3, role: 'assistant', content: '新しい回答', metadata: {}, created_at: '2026-07-17T10:01:10Z' },
      ]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '直近だけ見せて', sessionId: 'sess-cm-02' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('全3件中2件');
      expect(result).toContain('新しい質問');
      expect(result).not.toContain('古い質問');
    });

    it('他テナントのセッションIDは「見つかりません」となり本文を漏らさない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cm-3', 'get_chat_session_messages', { session_id: 'ffeeddcc' }))
        .mockResolvedValueOnce(makeGroqResponse('そのセッションは見つかりませんでした。'));

      seedSessions([OWN_SESSION, OTHER_TENANT_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ffeeddccの会話を見せて', sessionId: 'sess-cm-03' });

      expect(res.status).toBe(200);
      // 解決クエリは必ず tenant_id で絞られている
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('tenant_id = $1');
      expect(params[0]).toBe('tenant-abc');
      // 他テナントのメッセージは一切取得しない
      expect(mockGetMessages).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('見つかりません');
    });

    it('短縮IDが複数セッションに一致する場合は候補を提示し本文を返さない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cm-4', 'get_chat_session_messages', { session_id: 'dupdup00' }))
        .mockResolvedValueOnce(makeGroqResponse('どちらの会話でしょうか。'));

      seedSessions([OWN_SESSION, DUP_A, DUP_B]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'dupdup00の会話を見せて', sessionId: 'sess-cm-04' });

      expect(res.status).toBe(200);
      expect(mockGetMessages).not.toHaveBeenCalled();
      const result = res.body.actions[0].result as string;
      expect(result).toContain('2件あります');
      expect(result).toContain('[dupdup00-1111-4c]');
      expect(result).toContain('[dupdup00-2222-4d]');
    });

    it('存在しない短縮IDは例外を投げずに「見つかりません」を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cm-5', 'get_chat_session_messages', { session_id: '00000000' }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '00000000の会話を見せて', sessionId: 'sess-cm-05' });

      expect(res.status).toBe(200);
      expect(mockGetMessages).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('見つかりません');
    });

    it('session_id が空なら解決クエリを投げずに指定を促す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cm-6', 'get_chat_session_messages', { session_id: '  ' }))
        .mockResolvedValueOnce(makeGroqResponse('セッションIDを教えてください。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '会話を見せて', sessionId: 'sess-cm-06' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockGetMessages).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('セッションIDを指定してください');
    });
  });

  // -------------------------------------------------------------------------
  // reply_to_escalation / resolve_escalation（confirmedゲート / テナント境界）
  // -------------------------------------------------------------------------
  describe('reply_to_escalation / resolve_escalation', () => {
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

    type SessionRow = { id: string; tenant_id: string; session_id: string };

    const OWN_SESSION: SessionRow = {
      id: 'db-esc-own', tenant_id: 'tenant-abc', session_id: 'e5c0abcd-1111-4aaa-8000-000000000011',
    };
    const OTHER_TENANT_SESSION: SessionRow = {
      id: 'db-esc-other', tenant_id: 'tenant-zzz', session_id: 'ffee0000-9999-4bbb-8000-000000000012',
    };

    // resolveSessionByShortId の SQL（tenant_id = $1 AND session_id LIKE $2 || '%'）を
    // 忠実に再現し、テナント越境が「SQLの条件で」防がれていることを検証する。
    function seedSessions(rows: SessionRow[]) {
      mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
        if (!Array.isArray(params)) return { rows: [] };
        const [tenantId, prefix] = params as [string, string];
        return {
          rows: rows
            .filter((r) => r.tenant_id === tenantId && r.session_id.startsWith(prefix))
            .map((r) => ({ id: r.id, session_id: r.session_id })),
        };
      });
    }

    it('reply: confirmed 未指定なら「確認が必要」を返し、返信を保存しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-1', 'reply_to_escalation', { session_id: 'e5c0abcd', content: '担当より折り返します' }))
        .mockResolvedValueOnce(makeGroqResponse('この内容でよろしいですか。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'e5c0abcdに返信して', sessionId: 'sess-er-01' });

      expect(res.status).toBe(200);
      expect(mockSaveMessage).not.toHaveBeenCalled();
      const result = res.body.actions[0].result as string;
      expect(result).toContain('確認が必要');
      expect(result).toContain('担当より折り返します');
    });

    it('reply: confirmed=false でも保存しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-2', 'reply_to_escalation', { session_id: 'e5c0abcd', content: '確認中です', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから送ります。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'e5c0abcdに返信して', sessionId: 'sess-er-02' });

      expect(res.status).toBe(200);
      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('reply: confirmed=true なら operator ロールで返信が保存される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-3', 'reply_to_escalation', { session_id: 'e5c0abcd', content: '在庫を確認しました。明日発送します', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('返信しました。'));

      seedSessions([OWN_SESSION]);
      mockSaveMessage.mockResolvedValueOnce(undefined);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'e5c0abcdに返信して', sessionId: 'sess-er-03' });

      expect(res.status).toBe(200);
      // 短縮IDではなく解決後の完全な session_id で保存されること
      expect(mockSaveMessage).toHaveBeenCalledWith({
        tenantId: 'tenant-abc',
        sessionId: OWN_SESSION.session_id,
        role: 'operator',
        content: '在庫を確認しました。明日発送します',
      });
      expect(res.body.actions[0].result).toContain('返信を保存しました');
    });

    it('reply: 他テナントのセッションIDには返信できない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-4', 'reply_to_escalation', { session_id: 'ffee0000', content: '越境返信', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      seedSessions([OWN_SESSION, OTHER_TENANT_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ffee0000に返信して', sessionId: 'sess-er-04' });

      expect(res.status).toBe(200);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('tenant_id = $1');
      expect(params[0]).toBe('tenant-abc');
      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('見つかりません');
    });

    it('reply: 2000文字を超える返信は拒否され、解決クエリも保存も走らない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-5', 'reply_to_escalation', { session_id: 'e5c0abcd', content: 'あ'.repeat(2001), confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('長すぎました。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'e5c0abcdに長文で返信して', sessionId: 'sess-er-05' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockSaveMessage).not.toHaveBeenCalled();
      const result = res.body.actions[0].result as string;
      expect(result).toContain('2000文字以内');
      expect(result).toContain('2001文字');
    });

    it('resolve: confirmed 未指定なら「確認が必要」を返し、対応完了にしない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-6', 'resolve_escalation', { session_id: 'e5c0abcd' }))
        .mockResolvedValueOnce(makeGroqResponse('対応完了にしてよいですか。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'e5c0abcdを対応完了にして', sessionId: 'sess-er-06' });

      expect(res.status).toBe(200);
      expect(mockResolveEscalation).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('resolve: 他テナントのセッションIDは対応完了にできない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-7', 'resolve_escalation', { session_id: 'ffee0000', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      seedSessions([OWN_SESSION, OTHER_TENANT_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ffee0000を対応完了にして', sessionId: 'sess-er-07' });

      expect(res.status).toBe(200);
      expect(mockResolveEscalation).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('見つかりません');
    });

    it('resolve: confirmed=true で対応完了になり、以降 get_escalations に出てこない', async () => {
      seedSessions([OWN_SESSION]);

      // chat_sessions.escalation_resolved_at の更新を模した最小のストア。
      // 「対応完了にすると一覧から消える」ことを2ターンにまたがって検証する。
      let resolvedAt: string | null = null;
      mockResolveEscalation.mockImplementation(async (params: { sessionDbId: string; tenantId?: string }) => {
        if (params.sessionDbId !== OWN_SESSION.id || params.tenantId !== OWN_SESSION.tenant_id) return false;
        resolvedAt = '2026-07-18T09:00:00Z';
        return true;
      });
      mockGetActiveEscalations.mockImplementation(async (tenantId: string) =>
        resolvedAt || tenantId !== OWN_SESSION.tenant_id
          ? []
          : [{
              id: OWN_SESSION.id,
              tenant_id: OWN_SESSION.tenant_id,
              session_id: OWN_SESSION.session_id,
              escalated_at: '2026-07-18T08:00:00Z',
              last_message_at: '2026-07-18T08:30:00Z',
              message_count: 4,
              first_message_preview: '返品したいです',
            }],
      );

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-8', 'resolve_escalation', { session_id: 'e5c0abcd', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('対応完了にしました。'));

      const resolveRes = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'e5c0abcdを対応完了にして', sessionId: 'sess-er-08' });

      expect(resolveRes.status).toBe(200);
      expect(mockResolveEscalation).toHaveBeenCalledWith({ sessionDbId: OWN_SESSION.id, tenantId: 'tenant-abc' });
      expect(resolvedAt).not.toBeNull();
      expect(resolveRes.body.actions[0].result).toContain('対応完了に更新しました');

      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-er-9', 'get_escalations', {}))
        .mockResolvedValueOnce(makeGroqResponse('対応中のものはありません。'));

      const listRes = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'エスカレーションを見せて', sessionId: 'sess-er-09' });

      expect(listRes.status).toBe(200);
      expect(listRes.body.actions[0].result).toContain('対応中のエスカレーションはありません');
    });
  });

  // -------------------------------------------------------------------------
  // get_legacy_ui_link
  // -------------------------------------------------------------------------
  describe('get_legacy_ui_link', () => {
    // 計測ラベルの語彙(agentRoutes の LEGACY_HANDOFF_FEATURES)は toolDefinitions の
    // feature enum から導出している。ここに写しが復活すると、旧UIページ閉鎖でenumから
    // 値を消しても閉鎖済みページ宛の handoff が 'unknown' に落ちず自分の名前で記録され続け、
    // docs/LEGACY_UI_SUNSET.md のトリップワイヤーが無言で作動しなくなる。
    // 同一参照であることを検証して、リテラル配列への差し戻しを失敗させる。
    it('feature enum は LEGACY_UI_FEATURES から導出されている（写しを作らない）', () => {
      const tool = ADMIN_AGENT_TOOLS.find((t) => t.function.name === 'get_legacy_ui_link');
      expect(tool).toBeDefined();
      const featureProp = tool!.function.parameters.properties['feature'] as { enum: unknown };
      expect(featureProp.enum).toBe(LEGACY_UI_FEATURES);
    });

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

    it.each([
      ['billing', '請求管理', '/admin/billing'],
      ['avatar_studio', 'アバタースタジオ', '/admin/avatar/studio'],
      ['escalation_reply', 'エスカレーション対応', '/admin/escalations'],
      ['session_deletion', '会話履歴', '/admin/chat-history'],
      ['chat_test', 'テストチャット', '/admin/chat-test'],
      ['avatar_wizard', 'アバター新規作成', '/admin/avatar/wizard'],
      ['knowledge_pdf', 'PDFアップロード', '/admin/knowledge/tenant-abc?tab=pdf'],
    ])('feature=%s: 旧UIの案内(画面名・URL)を返す', async (feature, label, path) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-1', 'get_legacy_ui_link', { feature }))
        .mockResolvedValueOnce(makeGroqResponse('こちらの画面でご対応ください。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '請求書を再送したい', sessionId: 'sess-lu-01' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain(label);
      // toContain(path) だけだと `/admin/chat-test` に対する `/admin/chat-tests` のような
      // 末尾追加型のtypoを検出できないため、行末(\n)まで含めて厳密に検証する
      expect(result).toContain(`URL: ${path}\n`);

      // 挙動メトリクス: 旧UIへの受け渡しは agent_legacy_handoff として feature 付きで記録される
      expect(recordedMetrics('agent_legacy_handoff')).toEqual([
        {
          metricName: 'agent_legacy_handoff',
          tenantId: 'tenant-abc',
          labels: { feature, surface: 'unknown' },
          value: 1,
        },
      ]);
    });

    it('不明なfeatureの場合はその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-5', 'get_legacy_ui_link', { feature: 'unknown_thing' }))
        .mockResolvedValueOnce(makeGroqResponse('確認できませんでした。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '謎の機能について', sessionId: 'sess-lu-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('不明な案内先');

      // ラベルの語彙を有界に保つため、未定義の feature は 'unknown' に丸めて記録する
      expect(recordedMetrics('agent_legacy_handoff')).toEqual([
        {
          metricName: 'agent_legacy_handoff',
          tenantId: 'tenant-abc',
          labels: { feature: 'unknown', surface: 'unknown' },
          value: 1,
        },
      ]);
    });

    // analytics / conversion はLP料金表上Growth〜の機能（AppSidebar.tsxのrequiresPlanと同じ基準）。
    // activate_avatarと同様、旧UIへの案内リンク自体もプラン未満のテナントには返さない。
    it.each([
      ['analytics', '会話分析', '/admin/analytics'],
      ['conversion', '成約・効果分析', '/admin/conversion'],
    ])('feature=%s: growthプランなら旧UIの案内(画面名・URL)を返す', async (feature, label, path) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-6', 'get_legacy_ui_link', { feature }))
        .mockResolvedValueOnce(makeGroqResponse('こちらの画面でご対応ください。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '会話の分析を見たい', sessionId: 'sess-lu-03' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain(label);
      expect(result).toContain(`URL: ${path}\n`);
    });

    it.each([
      ['analytics'],
      ['conversion'],
    ])('feature=%s: starterプランはリンクを返さずプラン制限メッセージを返す', async (feature) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-7', 'get_legacy_ui_link', { feature }))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '会話の分析を見たい', sessionId: 'sess-lu-04' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('Growthプラン以上');
      // 押せないリンクカードが出ないよう、成功時の3行フォーマット(画面:/URL:/説明:)に一致しないこと
      expect(result).not.toMatch(/画面:/);
      expect(result).not.toMatch(/URL:/);
    });

    // super_admin が targetTenantId 未指定で呼ぶと effectiveTenantId が特定できないため、
    // queryTenantPlan が fail-safe で starter 扱いになり「Growthプラン以上」という無関係な
    // メッセージを返してしまう回帰を防ぐ（analytics/conversionの分岐内でのみガードする設計）
    it('super_admin がテナント未特定でanalyticsを要求 → プラン制限メッセージではなく「テナントが特定できません」を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-8', 'get_legacy_ui_link', { feature: 'analytics' }))
        .mockResolvedValueOnce(makeGroqResponse('テナントを指定してください。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '会話の分析を見たい', sessionId: 'sess-lu-05' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('テナントが特定できません');
      expect(result).not.toContain('Growthプラン以上');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    // knowledge_pdf は他のキーと違い path に tenantId を埋め込む必要があるため専用ガードがある
    // (/admin/knowledge?tab=pdf だと KnowledgeIndexPage のリダイレクトで ?tab=pdf が失われるため)
    it('feature=knowledge_pdf: super_admin がテナント未特定 → 「テナントが特定できません」を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-9', 'get_legacy_ui_link', { feature: 'knowledge_pdf' }))
        .mockResolvedValueOnce(makeGroqResponse('テナントを指定してください。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'PDFをアップロードしたい', sessionId: 'sess-lu-06' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('テナントが特定できません');
    });

    // 冒頭が「できません」で始まると、旧UIへの案内が行き止まりの謝罪に見えてしまう。
    // 3行フォーマット(画面:/URL:/説明:)は parseLegacyUiLink の契約なので維持したまま、
    // 導入文だけを「どこでできるか」に差し替えている。
    it('冒頭文は謝罪ではなく案内先の画面から始まる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-10', 'get_legacy_ui_link', { feature: 'billing' }))
        .mockResolvedValueOnce(makeGroqResponse('請求管理画面をご案内しました。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '請求書を再送したい', sessionId: 'sess-lu-07' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).not.toContain('チャットでは対応していません');
      expect(result.split('\n')[0]).toBe('この操作は請求管理画面から行えます。');
      // 導入文の差し替えで3行フォーマットが壊れていないこと(先頭に紛れ込む偽の行も含む)
      expect(result).toContain('画面: 請求管理\n');
      expect(result).toContain('URL: /admin/billing\n');
      expect(result.match(/画面:/g)).toHaveLength(1);
      expect(result.match(/URL:/g)).toHaveLength(1);
    });

    // session_deletion の deep-link（resolveSessionByShortId で短縮IDを解決する）
    type SessionRow = { id: string; tenant_id: string; session_id: string };

    function seedSessions(rows: SessionRow[]) {
      mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
        if (!Array.isArray(params)) return { rows: [] };
        const [tenantId, prefix] = params as [string, string];
        return {
          rows: rows
            .filter((r) => r.tenant_id === tenantId && r.session_id.startsWith(prefix))
            .map((r) => ({ id: r.id, session_id: r.session_id })),
        };
      });
    }

    const OWN_SESSION: SessionRow = {
      id: '8f14e45f-ceea-467a-9d0f-2b3c4d5e6f70', tenant_id: 'tenant-abc', session_id: 'a1b2c3d4-1111-4aaa-8000-000000000001',
    };
    const OTHER_TENANT_SESSION: SessionRow = {
      id: 'deadbeef-0000-4000-8000-000000000099', tenant_id: 'tenant-zzz', session_id: 'ffeeddcc-9999-4bbb-8000-000000000002',
    };

    it('feature=session_deletion + session_id: 一覧ではなくその会話を直接開くURLを返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-11', 'get_legacy_ui_link', { feature: 'session_deletion', session_id: 'a1b2c3d4' }))
        .mockResolvedValueOnce(makeGroqResponse('該当の会話をご案内しました。'));

      seedSessions([OWN_SESSION, OTHER_TENANT_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'a1b2c3d4の会話を削除したい', sessionId: 'sess-lu-08' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain(`URL: /admin/chat-history/${OWN_SESSION.id}\n`);
    });

    it('feature=session_deletion + 存在しないsession_id: エラーにせず一覧URLへフォールバックする', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-12', 'get_legacy_ui_link', { feature: 'session_deletion', session_id: 'nosuchid' }))
        .mockResolvedValueOnce(makeGroqResponse('会話履歴画面をご案内しました。'));

      seedSessions([OWN_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'nosuchidの会話を削除したい', sessionId: 'sess-lu-09' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('URL: /admin/chat-history\n');
      expect(result).toContain('画面: 会話履歴\n');
    });

    it('feature=session_deletion + 他テナントのsession_id: 他テナントのIDをリンクに漏らさず一覧URLへフォールバックする', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-lu-13', 'get_legacy_ui_link', { feature: 'session_deletion', session_id: 'ffeeddcc' }))
        .mockResolvedValueOnce(makeGroqResponse('会話履歴画面をご案内しました。'));

      seedSessions([OWN_SESSION, OTHER_TENANT_SESSION]);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'ffeeddccの会話を削除したい', sessionId: 'sess-lu-10' });

      expect(res.status).toBe(200);
      // 解決クエリは必ず tenant_id で絞られている
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('tenant_id = $1');
      expect(params[0]).toBe('tenant-abc');
      const result = res.body.actions[0].result as string;
      expect(result).toContain('URL: /admin/chat-history\n');
      expect(result).not.toContain(OTHER_TENANT_SESSION.id);
    });
  });

  // -------------------------------------------------------------------------
  // 構造化カード(card)チャネル
  //
  // ツールが自然文に加えて構造化データを返せる経路。フロントが自然文を正規表現で
  // 読み直さずにカードを描画できるようにするためのもので、現時点で card を返すのは
  // get_legacy_ui_link だけ。残りのツールは素の文字列を返し続け、result のみが載る
  // 従来のレスポンス形と完全に同じであること（=union型化が全ツールへ波及していないこと）
  // をここで固定する。
  // -------------------------------------------------------------------------
  describe('構造化カード(card)チャネル', () => {
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

    const BILLING_DESCRIPTION = '請求書の再送・金額調整・無料期間設定・一時停止/再開はこちらの画面で行えます';

    it('JSON経路: get_legacy_ui_link は自然文(result)に加えて card を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-card-1', 'get_legacy_ui_link', { feature: 'billing' }))
        .mockResolvedValueOnce(makeGroqResponse('請求管理画面をご案内しました。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '請求書を再送したい', sessionId: 'sess-card-01' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].card).toEqual({
        kind: 'legacy_link',
        label: '請求管理',
        url: '/admin/billing',
        description: BILLING_DESCRIPTION,
      });

      // card は自然文の置き換えではなく追加。3行フォーマット(parseLegacyUiLink の契約)は
      // 正規表現フォールバックのために残り続ける。
      const result = res.body.actions[0].result as string;
      expect(typeof result).toBe('string');
      expect(result).toContain('画面: 請求管理\n');
      expect(result).toContain('URL: /admin/billing\n');
      expect(result).toContain(`説明: ${BILLING_DESCRIPTION}`);
    });

    it('SSE経路: event: done の actions にも同じ card が載る', async () => {
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

      const hop1Sse =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-card-2","function":{"name":"get_legacy_ui_link","arguments":""}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"feature\\":\\"billing\\"}"}}]}}]}\n\n' +
        'data: [DONE]\n\n';
      const hop2Sse = 'data: {"choices":[{"delta":{"content":"請求管理画面をご案内しました。"}}]}\n\n' + 'data: [DONE]\n\n';

      mockFetch
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop1Sse))
        .mockResolvedValueOnce(makeStreamingGroqResponse(hop2Sse));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '請求書を再送したい', sessionId: 'sess-card-02', stream: true });

      expect(res.status).toBe(200);

      const marker = 'event: done\ndata: ';
      const start = res.text.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const done = JSON.parse(res.text.slice(start + marker.length, res.text.indexOf('\n\n', start))) as {
        actions: Array<{ tool: string; result: string; card?: Record<string, unknown> }>;
      };

      expect(done.actions[0].tool).toBe('get_legacy_ui_link');
      expect(done.actions[0].card).toEqual({
        kind: 'legacy_link',
        label: '請求管理',
        url: '/admin/billing',
        description: BILLING_DESCRIPTION,
      });
      expect(done.actions[0].result).toContain('URL: /admin/billing\n');
    });

    it('素の文字列を返すツール(save_faq)は result のみで card キー自体を持たない', async () => {
      mockFetch
        .mockResolvedValueOnce(
          toolCallResponse('call-card-3', 'save_faq', {
            question: '送料はいくらですか？',
            answer: '550円です。',
            category: 'store_info',
            confirmed: true,
          }),
        )
        .mockResolvedValueOnce(makeGroqResponse('保存しました。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 99, question: '送料はいくらですか？', answer: '550円です。', is_published: true }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'お願い', sessionId: 'sess-card-03' });

      expect(res.status).toBe(200);
      const action = res.body.actions[0];
      expect(typeof action.result).toBe('string');
      expect(action.result).toContain('ID: 99');
      // キーの不在まで見る: 未移行ツールのレスポンス形が1バイトも変わっていないこと
      expect(action.card).toBeUndefined();
      expect(Object.keys(action)).toEqual(['tool', 'result']);
    });

    it('get_legacy_ui_link の失敗パス(プラン制限)では card を返さない(押せないカードを作らない)', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-card-4', 'get_legacy_ui_link', { feature: 'analytics' }))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '会話の分析を見たい', sessionId: 'sess-card-04' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('Growthプラン以上');
      expect(res.body.actions[0].card).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // get_analytics_summary / get_conversion_summary
  // -------------------------------------------------------------------------
  describe('get_analytics_summary / get_conversion_summary', () => {
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

    const ANALYTICS_SUMMARY = {
      period: '30d',
      tenant_id: 'tenant-abc',
      total_sessions: 142,
      avg_judge_score: 78.4,
      total_knowledge_gaps: 5,
      avg_messages_per_session: 6.25,
      avatar_session_count: 20,
      avatar_rate: 0.14,
      prev_total_sessions: 100,
      sessions_change_pct: 42,
      sentiment_distribution: { positive: 60, negative: 12, neutral: 30, total: 102 },
      cv_count_30d: 8,
      cv_total_value_30d: 120000,
      cv_types_breakdown: { purchase: 8, inquiry: 0, reservation: 0, signup: 0, other: 0 },
      cv_fired_status: 'fired' as const,
      cv_days_since_first_session: 90,
    };

    const CONVERSION_SUMMARY = {
      summary: {
        total_sessions: 142,
        recorded_outcomes: 96,
        recording_rate: 67.6,
        outcomes: { 成約: 40, 検討中: 56 },
      },
      conversion_rate_trend: [{ date: '2026-07-01', total: 10, converted: 4, rate: 40 }],
      technique_effectiveness: [
        { technique: '社会的証明', sessions_used: 12, converted: 9, conversion_rate: 75 },
        { technique: '希少性', sessions_used: 8, converted: 4, conversion_rate: 50 },
      ],
      stage_dropout: { clarify: 3, answer: 11, confirm: 2, terminal: 0 },
    };

    it('get_analytics_summary: growthプランなら実際の数値サマリーを返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-as-1', 'get_analytics_summary', { period: '30d' }))
        .mockResolvedValueOnce(makeGroqResponse('会話は増えています。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
      mockFetchAnalyticsSummary.mockResolvedValueOnce(ANALYTICS_SUMMARY);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '会話は増えている?', sessionId: 'sess-as-01' });

      expect(res.status).toBe(200);
      expect(mockFetchAnalyticsSummary).toHaveBeenCalledWith({
        db: mockDb,
        tenantId: 'tenant-abc',
        period: '30d',
      });
      const result = res.body.actions[0].result as string;
      expect(result).toContain('142件');
      expect(result).toContain('+42.0%');
      expect(result).toContain('78.4');
      expect(result).toContain('6.3件');
      expect(result).toContain('ポジティブ60');
    });

    it('get_analytics_summary: period=7d を指定すると集計期間として渡される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-as-2', 'get_analytics_summary', { period: '7d' }))
        .mockResolvedValueOnce(makeGroqResponse('直近1週間の状況です。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'enterprise' }] });
      mockFetchAnalyticsSummary.mockResolvedValueOnce({ ...ANALYTICS_SUMMARY, period: '7d' });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '直近1週間はどう?', sessionId: 'sess-as-02' });

      expect(res.status).toBe(200);
      expect(mockFetchAnalyticsSummary).toHaveBeenCalledWith({
        db: mockDb,
        tenantId: 'tenant-abc',
        period: '7d',
      });
      expect(res.body.actions[0].result).toContain('直近7日間');
    });

    it('get_conversion_summary: growthプランなら実際の数値サマリーを返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-cs-1', 'get_conversion_summary', {}))
        .mockResolvedValueOnce(makeGroqResponse('成約は順調です。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
      mockFetchConversionSummary.mockResolvedValueOnce(CONVERSION_SUMMARY);

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '成約につながっている?', sessionId: 'sess-cs-01' });

      expect(res.status).toBe(200);
      expect(mockFetchConversionSummary).toHaveBeenCalledWith({
        db: mockDb,
        tenantId: 'tenant-abc',
        period: '30d',
      });
      const result = res.body.actions[0].result as string;
      expect(result).toContain('142件');
      expect(result).toContain('67.6%');
      expect(result).toContain('成約 40件');
      expect(result).toContain('社会的証明 75%');
      expect(result).toContain('answer（11件）');
    });

    // get_legacy_ui_link(analytics/conversion) と同じ基準。プラン未満のテナントには
    // 案内リンクだけでなく数値そのものも返さない。
    it.each([
      ['get_analytics_summary', 'sess-as-03'],
      ['get_conversion_summary', 'sess-cs-03'],
    ])('%s: starterプランは数値を返さずプラン制限メッセージを返す', async (toolName, sessionId) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-pg-1', toolName, {}))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '分析を見せて', sessionId });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('Growthプラン以上');
      expect(mockFetchAnalyticsSummary).not.toHaveBeenCalled();
      expect(mockFetchConversionSummary).not.toHaveBeenCalled();
      // 数値が1つも漏れていないこと
      expect(result).not.toMatch(/\d/);
    });

    // super_admin の「クライアントビューで見る」はテナントに見えている状態の再現が目的のため、
    // get_legacy_ui_link(analytics/conversion) と同様プランゲートをバイパスさせない。
    it.each([
      ['get_analytics_summary', 'sess-as-04'],
      ['get_conversion_summary', 'sess-cs-04'],
    ])('%s: super_admin が starterテナントをプレビューしてもプラン制限メッセージを返す', async (toolName, sessionId) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-pg-2', toolName, {}))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '分析を見せて', sessionId, targetTenantId: 'tenant-starter' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('Growthプラン以上');
      expect(mockFetchAnalyticsSummary).not.toHaveBeenCalled();
      expect(mockFetchConversionSummary).not.toHaveBeenCalled();
    });

    it.each([
      ['get_analytics_summary', 'sess-as-05'],
      ['get_conversion_summary', 'sess-cs-05'],
    ])('%s: super_admin がテナント未特定 → プラン制限ではなく「テナントが特定できません」を返す', async (toolName, sessionId) => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-pg-3', toolName, {}))
        .mockResolvedValueOnce(makeGroqResponse('テナントを指定してください。'));

      const res = await request(makeApp(SUPER_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '分析を見せて', sessionId });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('テナントが特定できません');
      expect(result).not.toContain('Growthプラン以上');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // import_industry_faq_templates
  // -------------------------------------------------------------------------
  describe('import_industry_faq_templates', () => {
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

    it('confirmed=false → テンプレート一覧を提示するのみで登録されない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-ind-1', 'import_industry_faq_templates', { industry: 'beauty', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('こちらでよろしいですか？'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '美容室です', sessionId: 'sess-ind-01' });

      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      const result = res.body.actions[0].result as string;
      expect(result).toContain('美容・サロン');
      expect(result).toContain('予約は必要ですか？');
    });

    it('不明な業種の場合はその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-ind-2', 'import_industry_faq_templates', { industry: 'space_travel', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認できませんでした。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '宇宙旅行業です', sessionId: 'sess-ind-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('不明な業種');
    });

    it('confirmed=true → 全テンプレートがINSERTされ、テナントのonboarding項目が更新される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-ind-3', 'import_industry_faq_templates', { industry: 'beauty', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('登録しました。'));

      for (let i = 0; i < 5; i++) {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 100 + i, question: `q${i}`, answer: `a${i}`, is_published: true }],
        });
      }
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE tenants

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '登録して', sessionId: 'sess-ind-03' });

      expect(res.status).toBe(200);
      const insertCalls = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO faq_docs'));
      expect(insertCalls).toHaveLength(5);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE tenants SET onboarding_industry'),
        ['beauty', 'tenant-abc'],
      );
      expect(res.body.actions[0].result).toContain('5件登録しました');
    });
  });

  // -------------------------------------------------------------------------
  // get_avatar_status
  // -------------------------------------------------------------------------
  describe('get_avatar_status', () => {
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

    it('有効かつ稼働中の設定がある場合はその名前を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-av-1', 'get_avatar_status', {}))
        .mockResolvedValueOnce(makeGroqResponse('アバターは稼働中です。'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ avatar_enabled: 'true' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'av-1', name: '接客担当アバター' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターの状況を教えて', sessionId: 'sess-av-01' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('有効');
      expect(result).toContain('接客担当アバター');
    });

    it('無効な場合は無効である旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-av-2', 'get_avatar_status', {}))
        .mockResolvedValueOnce(makeGroqResponse('アバターは無効です。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ avatar_enabled: 'false' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターの状況を教えて', sessionId: 'sess-av-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('無効');
    });
  });

  // -------------------------------------------------------------------------
  // get_avatar_list / deactivate_avatar
  // 一覧が無いと activate_avatar は ID を知っている人しか使えない = チャットから実行不能
  // だったため追加した経路。既定アバターの扱いが最大の罠なのでそこを固定する。
  // -------------------------------------------------------------------------
  describe('get_avatar_list / deactivate_avatar', () => {
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

    it('既定アバター(r2c_default)は is_active=true でも「稼働中」と表示しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-list-1', 'get_avatar_list', {}))
        .mockResolvedValueOnce(makeGroqResponse('一覧をお伝えしました。'));

      // 既定アバターは部分unique制約から除外されており全行 is_active = true。
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'av-own-1', name: '自社スタッフ', is_active: false, tenant_id: 'tenant-abc' },
          { id: 'av-def-1', name: '見本アバターA', is_active: true, tenant_id: 'r2c_default' },
          { id: 'av-def-2', name: '見本アバターB', is_active: true, tenant_id: 'r2c_default' },
        ],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターの一覧を見せて', sessionId: 'sess-list-01' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('自社スタッフ');
      expect(result).toContain('見本アバターA（既定の見本）');
      expect(result).not.toContain('見本アバターA（稼働中）');
    });

    it('自テナントの稼働中の設定には稼働中の印が付く', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-list-2', 'get_avatar_list', {}))
        .mockResolvedValueOnce(makeGroqResponse('一覧をお伝えしました。'));

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'av-own-1', name: '接客担当', is_active: true, tenant_id: 'tenant-abc' }],
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターの一覧を見せて', sessionId: 'sess-list-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('接客担当（稼働中）');
    });

    it('件数が多くても500字で黙って欠けず、残件数を明示する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-list-3', 'get_avatar_list', {}))
        .mockResolvedValueOnce(makeGroqResponse('一覧をお伝えしました。'));

      const rows = Array.from({ length: 30 }, (_, i) => ({
        id: `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}`,
        name: `アバター${i}`,
        is_active: false,
        tenant_id: 'tenant-abc',
      }));
      mockQuery.mockResolvedValueOnce({ rows });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターの一覧を見せて', sessionId: 'sess-list-03' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('アバター設定は30件あります');
      expect(result).toMatch(/ほか\d+件/);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('設定が1件も無い場合はその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-list-4', 'get_avatar_list', {}))
        .mockResolvedValueOnce(makeGroqResponse('まだありません。'));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターの一覧を見せて', sessionId: 'sess-list-04' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('まだありません');
    });

    it('稼働中を停止でき、既定アバターは停止対象から除外される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-deact-1', 'deactivate_avatar', {}))
        .mockResolvedValueOnce(makeGroqResponse('停止しました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ name: '接客担当' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを止めて', sessionId: 'sess-deact-01' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('停止しました');
      const sql = mockQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('is_default = false OR is_default IS NULL');
      expect(mockQuery.mock.calls[0]![1]).toEqual(['tenant-abc']);
    });

    it('稼働中が無いときは停止せずその旨を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-deact-2', 'deactivate_avatar', {}))
        .mockResolvedValueOnce(makeGroqResponse('稼働中はありません。'));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを止めて', sessionId: 'sess-deact-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('稼働中のアバターはありません');
    });
  });

  // -------------------------------------------------------------------------
  // activate_avatar — プラン制限(Growth〜)がチャット経由でも素通りしないことの回帰テスト
  // -------------------------------------------------------------------------
  describe('activate_avatar: プラン制限', () => {
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

    it('starterプランは有効化できず、DB更新(db.connect)も発火しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-act-1', 'activate_avatar', { id: 'av-1' }))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-act-01' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('Growthプラン以上');
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('growthプランは有効化できる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-act-2', 'activate_avatar', { id: 'av-1' }))
        .mockResolvedValueOnce(makeGroqResponse('有効化しました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
      const clientQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // deactivate all
        .mockResolvedValueOnce({ rows: [{ id: 'av-1' }] }) // activate target
        .mockResolvedValueOnce({ rows: [] }) // tenants.features sync
        .mockResolvedValueOnce({ rows: [] }); // COMMIT
      mockConnect.mockResolvedValueOnce({ query: clientQuery, release: jest.fn() });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-act-02' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('有効化しました');
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('planが未設定(null)の場合はfail-safeでstarter扱いとなり有効化できない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-act-3', 'activate_avatar', { id: 'av-1' }))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-act-03' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('Growthプラン以上');
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('IDがUUIDでない場合も500にならず、一覧で確認するよう案内する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-act-4', 'activate_avatar', { id: 'それっぽいID' }))
        .mockResolvedValueOnce(makeGroqResponse('IDをご確認ください。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
      // Postgres は uuid 列への不正値で 22P02 を投げる。executor が握って日本語で返すこと。
      const invalidUuid = Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
      const clientQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(invalidUuid) // deactivate all(idを使う前段で落ちる場合もある)
        .mockResolvedValue({ rows: [] }); // ROLLBACK
      mockConnect.mockResolvedValueOnce({ query: clientQuery, release: jest.fn() });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-act-04' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('get_avatar_list');
    });

    it('他テナントのIDは有効化されず、一覧で確認するよう案内する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-act-5', 'activate_avatar', { id: 'av-other-tenant' }))
        .mockResolvedValueOnce(makeGroqResponse('見つかりませんでした。'));

      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
      const clientQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // deactivate all
        .mockResolvedValueOnce({ rows: [] }) // activate target → tenant_id 不一致で0件
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
      mockConnect.mockResolvedValueOnce({ query: clientQuery, release: jest.fn() });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-act-05' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('設定が見つかりません');
      expect(result).toContain('get_avatar_list');
    });
  });

  // -------------------------------------------------------------------------
  // GID 1217007275510096: 同じ会話の中で同じプラン制限の全文案内を毎回繰り返さない。
  // 初回は従来の全文のまま、2回目以降は短い確認だけ。判定はセッション単位・機能単位。
  // (制限そのものは変わらない = 数値やリンクは相変わらず返さない)
  // -------------------------------------------------------------------------
  describe('プラン制限メッセージの繰り返し抑制', () => {
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

    // 他のAPI(analytics/routes.ts 等)と共有している既存の文言。この繰り返し抑制で
    // 初回メッセージの文言が変わっていないことを1文字単位で固定する。
    const FULL_GROWTH_NOTICE = 'この機能はGrowthプラン以上でご利用いただけます';
    const FULL_AVATAR_NOTICE = 'AIアバター機能はGrowthプラン以上でご利用いただけます';

    /** starterプランのテナントとしてプラン制限付きツールを1ターン実行し、その結果文字列を返す */
    async function askGated(
      toolName: string,
      sessionId: string,
      callId: string,
      args: Record<string, unknown> = {},
    ): Promise<string> {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse(callId, toolName, args))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '分析を見せて', sessionId });

      expect(res.status).toBe(200);
      return res.body.actions[0].result as string;
    }

    it('初回は既存の全文をそのまま返す', async () => {
      const result = await askGated('get_analytics_summary', 'sess-plan-rep-01', 'call-rep-1');
      expect(result).toBe(FULL_GROWTH_NOTICE);
    });

    it('同一セッション・同一機能の2回目は全文を繰り返さず短い文になる', async () => {
      const first = await askGated('get_analytics_summary', 'sess-plan-rep-02', 'call-rep-2');
      expect(first).toBe(FULL_GROWTH_NOTICE);

      const second = await askGated('get_analytics_summary', 'sess-plan-rep-02', 'call-rep-3');
      expect(second).not.toBe(FULL_GROWTH_NOTICE);
      expect(second).not.toContain('Growthプラン以上');
      expect(second.length).toBeLessThan(FULL_GROWTH_NOTICE.length * 0.8);
      // 短くなっても制限は効いたまま(数値は一切返さない)
      expect(mockFetchAnalyticsSummary).not.toHaveBeenCalled();
    });

    it('別セッションなら同じ機能でも初回として全文を返す(グローバルな抑制ではない)', async () => {
      expect(await askGated('get_analytics_summary', 'sess-plan-rep-03', 'call-rep-4')).toBe(FULL_GROWTH_NOTICE);
      expect(await askGated('get_analytics_summary', 'sess-plan-rep-04', 'call-rep-5')).toBe(FULL_GROWTH_NOTICE);
    });

    it('同一セッションでも別の機能なら初回として全文を返す(機能ごとに1回ずつ案内する)', async () => {
      expect(await askGated('get_analytics_summary', 'sess-plan-rep-05', 'call-rep-6')).toBe(FULL_GROWTH_NOTICE);
      expect(await askGated('get_conversion_summary', 'sess-plan-rep-05', 'call-rep-7')).toBe(FULL_GROWTH_NOTICE);
      expect(await askGated('activate_avatar', 'sess-plan-rep-05', 'call-rep-8', { id: 'av-1' })).toBe(FULL_AVATAR_NOTICE);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('旧UI案内(get_legacy_ui_link)と数値サマリーは同じ機能の案内として1回に集約される', async () => {
      const first = await askGated('get_legacy_ui_link', 'sess-plan-rep-06', 'call-rep-9', { feature: 'analytics' });
      expect(first).toBe(FULL_GROWTH_NOTICE);

      const second = await askGated('get_analytics_summary', 'sess-plan-rep-06', 'call-rep-10');
      expect(second).not.toContain('Growthプラン以上');
      // 押せないリンクカードが出ないことは短い文でも変わらない
      expect(second).not.toMatch(/画面:/);
      expect(second).not.toMatch(/URL:/);
    });
  });

  // -------------------------------------------------------------------------
  // request_sai_task / get_sai_task_status
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

    it('client_admin: confirmed=false → 依頼されずブロックされる', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を直して', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認してから依頼します。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料表記を直して', sessionId: 'sess-sai-01' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('確認が必要');
    });

    it('client_admin: 月次コスト上限に達している場合は依頼されない', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'enterprise' }] });
      mockCheckSaiMonthlyCostCeiling.mockResolvedValueOnce({ ok: false, spentCents: 100000, ceilingCents: 100000 });
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を直して', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('上限に達しています。'));

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料表記を直して', sessionId: 'sess-sai-02' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      expect(res.body.actions[0].result).toContain('上限');
    });

    it('client_admin: confirmed=true かつ上限内 → Saiに依頼されタスクIDが返る', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'enterprise' }] });
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を新しい内容に更新', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('依頼しました。'));

      mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-99', status: 'queued' });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '送料表記を新しい内容に更新して', sessionId: 'sess-sai-03' });

      expect(res.status).toBe(200);
      expect(mockSubmitSaiTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: '送料表記を新しい内容に更新' }),
      );
      expect(res.body.actions[0].result).toContain('sai-task-99');
    });

    // -----------------------------------------------------------------------
    // GID 1216944249525907: request_sai_task はEnterpriseプラン以上限定
    // -----------------------------------------------------------------------
    describe('request_sai_task: プラン制限', () => {
      it('starterプランは依頼できず、Saiにも上限チェックにも到達しない', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });
        mockFetch
          .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を直して', confirmed: true }))
          .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

        const res = await request(makeApp(CLIENT_ADMIN_USER))
          .post('/v1/admin/agent/chat')
          .send({ message: '送料表記を直して', sessionId: 'sess-sai-plan-01' });

        expect(res.status).toBe(200);
        expect(res.body.actions[0].result).toContain('Enterpriseプラン以上');
        expect(mockCheckSaiMonthlyCostCeiling).not.toHaveBeenCalled();
        expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      });

      it('growthプランはまだEnterprise未達のため依頼できない', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
        mockFetch
          .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を直して', confirmed: true }))
          .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

        const res = await request(makeApp(CLIENT_ADMIN_USER))
          .post('/v1/admin/agent/chat')
          .send({ message: '送料表記を直して', sessionId: 'sess-sai-plan-02' });

        expect(res.status).toBe(200);
        expect(res.body.actions[0].result).toContain('Enterpriseプラン以上');
        expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      });

      it('planが未設定(null)の場合はfail-safeでstarter扱いとなり依頼できない', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });
        mockFetch
          .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を直して', confirmed: true }))
          .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));

        const res = await request(makeApp(CLIENT_ADMIN_USER))
          .post('/v1/admin/agent/chat')
          .send({ message: '送料表記を直して', sessionId: 'sess-sai-plan-03' });

        expect(res.status).toBe(200);
        expect(res.body.actions[0].result).toContain('Enterpriseプラン以上');
        expect(mockSubmitSaiTask).not.toHaveBeenCalled();
      });

      it('super_adminはプラン(starter)に関わらずバイパスできる', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });
        mockFetch
          .mockResolvedValueOnce(toolCallResponse('request_sai_task', { description: '送料表記を直して', confirmed: true }))
          .mockResolvedValueOnce(makeGroqResponse('依頼しました。'));

        mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-200', status: 'queued' });

        const res = await request(makeApp(SUPER_ADMIN_USER))
          .post('/v1/admin/agent/chat')
          .send({ message: '送料表記を直して', sessionId: 'sess-sai-plan-04', targetTenantId: 'tenant-abc' });

        expect(res.status).toBe(200);
        expect(mockSubmitSaiTask).toHaveBeenCalled();
        expect(res.body.actions[0].result).toContain('sai-task-200');
      });
    });

    it('client_admin: get_sai_task_status で状態と自己申告非信用の注記を返す', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('get_sai_task_status', { task_id: 'sai-task-99' }))
        .mockResolvedValueOnce(makeGroqResponse('進捗を確認しました。'));

      mockGetSaiTask.mockResolvedValueOnce({
        status: 'in_progress', steps: 3, max_steps: 15, description: 'x',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '進捗を教えて', sessionId: 'sess-sai-04' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('in_progress');
      expect(mockTrackUsage).not.toHaveBeenCalledWith(
        expect.objectContaining({ featureUsed: 'sai_agent' }),
      );
    });

    it('タスク完了時のみ、他のLLM機能と同じtrackUsage(sai_agent)でコストが計上される', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('get_sai_task_status', { task_id: 'sai-task-100' }))
        .mockResolvedValueOnce(makeGroqResponse('完了しました。'));

      mockGetSaiTask.mockResolvedValueOnce({
        status: 'complete', steps: 5, max_steps: 15, description: 'x',
        outcome: 'agent_reported_done', last_action: 'click save button',
      });

      const res = await request(makeApp(CLIENT_ADMIN_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: '進捗を教えて', sessionId: 'sess-sai-05' });

      expect(res.status).toBe(200);
      const result = res.body.actions[0].result as string;
      expect(result).toContain('complete');
      expect(result).toContain('自己申告は信用しない');
      expect(mockTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-abc',
          requestId: 'sai-agent-request:sai-task-100',
          featureUsed: 'sai_agent',
          saiAgentSteps: 5,
        }),
      );
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

      // 挙動メトリクス: 連鎖ブロックは reason=chain として記録される
      expect(recordedMetrics('agent_write_blocked')).toEqual([
        {
          metricName: 'agent_write_blocked',
          tenantId: 'tenant-abc',
          labels: { tool: 'save_faq', reason: 'chain', surface: 'unknown' },
          value: 1,
        },
      ]);
      expect(recordedMetrics('agent_turn_hops')).toEqual([
        { metricName: 'agent_turn_hops', tenantId: 'tenant-abc', labels: { hit_limit: false, surface: 'unknown' }, value: 2 },
      ]);
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
  // 設定変更の監査ログ (tenant_settings_history)
  // チャット経由の設定変更が旧UIと同じテーブルに追跡できることの回帰テスト
  // -------------------------------------------------------------------------
  describe('設定変更の監査ログ (tenant_settings_history)', () => {
    // extractAuth は su.email を changedBy に使うため、email 付きのユーザーで検証する
    const AUDIT_USER = {
      email: 'admin@example.com',
      app_metadata: { role: 'client_admin', tenant_id: 'tenant-abc' },
    };

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

    it('set_ga4_id 成功時に ga4_measurement_id の変更を記録する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-1', 'set_ga4_id', { measurement_id: 'G-ABC123' }))
        .mockResolvedValueOnce(makeGroqResponse('GA4 IDを設定しました。'));
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE tenants

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4を G-ABC123 にして', sessionId: 'sess-audit-01' });

      expect(res.status).toBe(200);
      expect(recordedSettingsChanges()).toEqual([
        {
          tenantId: 'tenant-abc',
          changedBy: 'admin@example.com',
          fieldName: 'ga4_measurement_id',
          oldValue: null,
          newValue: 'G-ABC123',
        },
      ]);
    });

    it('set_posthog 成功時に posthog_host の変更を記録する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-2', 'set_posthog', { host: 'https://app.posthog.com' }))
        .mockResolvedValueOnce(makeGroqResponse('PostHogを設定しました。'));
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'PostHogを設定して', sessionId: 'sess-audit-02' });

      expect(res.status).toBe(200);
      expect(recordedSettingsChanges()).toEqual([
        {
          tenantId: 'tenant-abc',
          changedBy: 'admin@example.com',
          fieldName: 'posthog_host',
          oldValue: null,
          newValue: 'https://app.posthog.com',
        },
      ]);
    });

    it('set_widget_theme 成功時に widget_theme の差分を記録する', async () => {
      mockFetch
        .mockResolvedValueOnce(
          toolCallResponse('call-au-3', 'set_widget_theme', { theme: { primaryColor: '#3B82F6' } }),
        )
        .mockResolvedValueOnce(makeGroqResponse('テーマを更新しました。'));
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'テーマを青にして', sessionId: 'sess-audit-03' });

      expect(res.status).toBe(200);
      expect(recordedSettingsChanges()).toEqual([
        {
          tenantId: 'tenant-abc',
          changedBy: 'admin@example.com',
          fieldName: 'widget_theme',
          oldValue: null,
          newValue: { primaryColor: '#3B82F6' },
        },
      ]);
    });

    it('activate_avatar 成功時に active_avatar_config_id の変更を記録する', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-4', 'activate_avatar', { id: 'av-1' }))
        .mockResolvedValueOnce(makeGroqResponse('アバターを有効化しました。'));
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });
      const clientQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // deactivate all
        .mockResolvedValueOnce({ rows: [{ id: 'av-1' }] }) // activate target
        .mockResolvedValueOnce({ rows: [] }) // tenants.features sync
        .mockResolvedValueOnce({ rows: [] }); // COMMIT
      mockConnect.mockResolvedValueOnce({ query: clientQuery, release: jest.fn() });

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-audit-04' });

      expect(res.status).toBe(200);
      expect(recordedSettingsChanges()).toEqual([
        {
          tenantId: 'tenant-abc',
          changedBy: 'admin@example.com',
          fieldName: 'active_avatar_config_id',
          oldValue: null,
          newValue: 'av-1',
        },
      ]);
    });

    it('activate_avatar がプラン制限でブロックされた場合は記録しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-5', 'activate_avatar', { id: 'av-1' }))
        .mockResolvedValueOnce(makeGroqResponse('プラン制限のためお伝えしました。'));
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'アバターを有効化して', sessionId: 'sess-audit-05' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('Growthプラン以上');
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockRecordAgentSettingsChange).not.toHaveBeenCalled();
    });

    it('set_ga4_id が形式不正で書き込まれなかった場合は記録しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-5b', 'set_ga4_id', { measurement_id: 'INVALID' }))
        .mockResolvedValueOnce(makeGroqResponse('形式が正しくありませんでした。'));

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4を INVALID にして', sessionId: 'sess-audit-05b' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('形式が不正です');
      expect(mockRecordAgentSettingsChange).not.toHaveBeenCalled();
    });

    it('set_ga4_id の UPDATE が失敗した場合は記録しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-5c', 'set_ga4_id', { measurement_id: 'G-ABC123' }))
        .mockResolvedValueOnce(makeGroqResponse('設定に失敗しました。'));
      mockQuery.mockRejectedValueOnce(new Error('db down'));

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4を G-ABC123 にして', sessionId: 'sess-audit-05c' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('失敗しました');
      expect(mockRecordAgentSettingsChange).not.toHaveBeenCalled();
    });

    it('確認ブロックされた書き込み(confirmed=false)は記録しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-6', 'save_faq', { question: 'q', answer: 'a', confirmed: false }))
        .mockResolvedValueOnce(makeGroqResponse('確認をお願いします。'));

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを保存して', sessionId: 'sess-audit-06' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('確認が必要です');
      expect(mockRecordAgentSettingsChange).not.toHaveBeenCalled();
    });

    it('対象4ツール以外の書き込み(save_faq成功)は tenant_settings_history に記録しない', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-7', 'save_faq', { question: 'q', answer: 'a', confirmed: true }))
        .mockResolvedValueOnce(makeGroqResponse('FAQを保存しました。'));
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, question: 'q', answer: 'a', is_published: true }],
      });

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'FAQを保存して', sessionId: 'sess-audit-07' });

      expect(res.status).toBe(200);
      expect(res.body.actions[0].result).toContain('FAQを保存しました');
      expect(mockRecordAgentSettingsChange).not.toHaveBeenCalled();
    });

    it('監査記録が例外を投げてもチャット応答は 200 のまま返る', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-8', 'set_ga4_id', { measurement_id: 'G-ABC123' }))
        .mockResolvedValueOnce(makeGroqResponse('GA4 IDを設定しました。'));
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockRecordAgentSettingsChange.mockImplementation(() => {
        throw new Error('audit boom');
      });

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4を G-ABC123 にして', sessionId: 'sess-audit-08' });

      expect(res.status).toBe(200);
      expect(res.body.reply).toBe('GA4 IDを設定しました。');
      expect(res.body.actions[0].result).toContain('G-ABC123');
    });

    it('監査記録が reject してもチャット応答は 200 のまま返る', async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallResponse('call-au-9', 'set_ga4_id', { measurement_id: 'G-ABC123' }))
        .mockResolvedValueOnce(makeGroqResponse('GA4 IDを設定しました。'));
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockRecordAgentSettingsChange.mockRejectedValue(new Error('audit boom'));

      const res = await request(makeApp(AUDIT_USER))
        .post('/v1/admin/agent/chat')
        .send({ message: 'GA4を G-ABC123 にして', sessionId: 'sess-audit-09' });

      expect(res.status).toBe(200);
      expect(res.body.reply).toBe('GA4 IDを設定しました。');
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

      // 挙動メトリクス: SSE経路でも JSON経路と同じくツール呼び出しとターン完了が記録される
      expect(recordedMetrics('agent_tool_invoked')).toEqual([
        {
          metricName: 'agent_tool_invoked',
          tenantId: 'tenant-abc',
          labels: { tool: 'get_tenant_settings', outcome: 'ok', surface: 'unknown' },
          value: 1,
        },
      ]);
      expect(recordedMetrics('agent_turn_hops')).toEqual([
        { metricName: 'agent_turn_hops', tenantId: 'tenant-abc', labels: { hit_limit: false, surface: 'unknown' }, value: 1 },
      ]);
      expect(recordedMetrics('agent_turn_completed')).toEqual([
        { metricName: 'agent_turn_completed', tenantId: 'tenant-abc', labels: { answered_from: 'tool_action', surface: 'unknown' }, value: 1 },
      ]);
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
});

// ---------------------------------------------------------------------------
// UIイベント計測（chat_first_toggle）。計測専用のベストエフォート副回線なので、
// 「トグルの挙動を絶対に壊さない」ことが本体の契約（docs/AGENT_METRICS.md）。
// ---------------------------------------------------------------------------

describe('POST /v1/admin/agent/ui-event', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('enabled:true → 200 {ok:true} と chat_first_toggle(JWT由来テナント) を記録する', async () => {
    const res = await request(makeApp(CLIENT_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordedMetrics('chat_first_toggle')).toEqual([
      {
        metricName: 'chat_first_toggle',
        tenantId: 'tenant-abc',
        labels: { enabled: true },
        value: 1,
      },
    ]);
  });

  it('enabled:false → 200 と chat_first_toggle(enabled:false) を記録する', async () => {
    const res = await request(makeApp(CLIENT_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordedMetrics('chat_first_toggle')).toEqual([
      {
        metricName: 'chat_first_toggle',
        tenantId: 'tenant-abc',
        labels: { enabled: false },
        value: 1,
      },
    ]);
  });

  it('テナント未特定の super_admin → tenantId は NULL で記録される', async () => {
    const res = await request(makeApp(SUPER_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true });

    expect(res.status).toBe(200);
    expect(recordedMetrics('chat_first_toggle')).toEqual([
      { metricName: 'chat_first_toggle', tenantId: null, labels: { enabled: true }, value: 1 },
    ]);
  });

  it('supabaseUser なし → 403（chat と同じ）', async () => {
    const res = await request(makeApp(undefined))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true });

    expect(res.status).toBe(403);
    expect(recordedMetrics('chat_first_toggle')).toEqual([]);
  });

  it('role が不正（viewer）→ 403', async () => {
    const res = await request(makeApp({ app_metadata: { role: 'viewer', tenant_id: 'tenant-abc' } }))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true });

    expect(res.status).toBe(403);
    expect(recordedMetrics('chat_first_toggle')).toEqual([]);
  });

  describe('バリデーション（event は閉じた enum）', () => {
    it.each([
      ['event が欠落', { enabled: true }],
      ['event が未定義の値', { event: 'some_other_ui_event', enabled: true }],
      ['enabled が欠落', { event: 'chat_first_toggle' }],
      ['enabled が boolean でない', { event: 'chat_first_toggle', enabled: 'true' }],
      ['空 body', {}],
    ])('%s → 400 で何も記録しない', async (_label, body) => {
      const res = await request(makeApp(CLIENT_ADMIN_USER)).post('/v1/admin/agent/ui-event').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(mockRecordAgentMetric).not.toHaveBeenCalled();
    });
  });

  it('body の tenantId は無視され JWT 由来テナントで記録される', async () => {
    const res = await request(makeApp(CLIENT_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true, tenantId: 'evil-tenant-override' });

    expect(res.status).toBe(200);
    expect(recordedMetrics('chat_first_toggle')).toEqual([
      { metricName: 'chat_first_toggle', tenantId: 'tenant-abc', labels: { enabled: true }, value: 1 },
    ]);
  });

  it('recordAgentMetric が throw しても 200 {ok:true} を返す（計測失敗をトグルに見せない）', async () => {
    mockRecordAgentMetric.mockImplementation(() => {
      throw new Error('metrics sync boom');
    });

    const res = await request(makeApp(CLIENT_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('recordAgentMetric が reject しても 200 {ok:true} を返す', async () => {
    mockRecordAgentMetric.mockImplementation(() => Promise.reject(new Error('metrics async boom')));

    const res = await request(makeApp(CLIENT_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('Groq もDBも呼ばない（計測だけの副回線）', async () => {
    const res = await request(makeApp(CLIENT_ADMIN_USER))
      .post('/v1/admin/agent/ui-event')
      .send({ event: 'chat_first_toggle', enabled: true });

    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
