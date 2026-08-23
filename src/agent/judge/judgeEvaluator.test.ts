// src/agent/judge/judgeEvaluator.test.ts
// Phase45 Stream A: unit tests for judgeEvaluator
// Updated to mock callGeminiJudge (implementation migrated from Groq to Gemini)

jest.mock('../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));

jest.mock('../../lib/db', () => ({
  getPool: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

// Phase52h: Notification側の副作用をテスト内で切り離す
jest.mock('../../lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

// Phase60-A: knowledgeSearchUtil をモック（pgvector/embedding は外部依存）
jest.mock('../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(''),
}));

// Phase60-B: crossTenantContext をモック（DBアクセス不要）
jest.mock('../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn().mockResolvedValue({
    avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [],
    effectiveRulePatterns: [], totalTenants: 0, dataAsOf: '',
  }),
  formatCrossTenantContext: jest.fn().mockReturnValue(''),
}));

// Phase47-B: rewardBridge を no-op モック（fetch が走ると OOM/flaky の原因）
jest.mock('../openclaw/rewardBridge', () => ({
  sendRewardSignal: jest.fn().mockResolvedValue(undefined),
}));

import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';
import { readFile } from 'fs/promises';
import { evaluateSession, SessionNotFoundError, SessionTenantMismatchError, SessionTooShortError, SessionAlreadyEvaluatedError } from './judgeEvaluator';
import { sendRewardSignal } from '../openclaw/rewardBridge';

const mockCallGroq = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;
const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockSendRewardSignal = sendRewardSignal as jest.MockedFunction<typeof sendRewardSignal>;

// Phase47-B: fire-and-forget (setImmediate + dynamic import) を消化する
async function flushFireAndForget(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const PROMPT_TEMPLATE =
  'Judge prompt template\n{{CONVERSATION_LOG}}\nOutput JSON only.';

function makeGroqResponse(overrides: Partial<{
  overall_score: number;
  psychology_fit_score: number;
  customer_reaction_score: number;
  stage_progress_score: number;
  taboo_violation_score: number;
}>): string {
  const scores = {
    overall_score: 75,
    psychology_fit_score: 80,
    customer_reaction_score: 70,
    stage_progress_score: 75,
    taboo_violation_score: 90,
    ...overrides,
  };
  return JSON.stringify({
    ...scores,
    feedback: {
      psychology_fit: 'Good use of mirroring',
      customer_reaction: 'Customer responded positively',
      stage_progress: 'Natural flow from clarify to propose',
      taboo_violation: '違反なし',
      summary: '全体的に良好な会話でした。',
    },
    suggested_rules: [
      {
        rule_text: 'Always clarify budget before proposing',
        reason: 'Helps match products to customer needs',
        priority: 'high',
      },
    ],
  });
}

function makeMockPool(queryImpl?: jest.Mock): jest.Mocked<{ query: jest.Mock }> {
  const query = queryImpl ?? jest.fn();
  return { query } as jest.Mocked<{ query: jest.Mock }>;
}

describe('evaluateSession', () => {
  beforeEach(async () => {
    // Phase47-B: 前テストの fire-and-forget (setImmediate) を消化してから mock をリセット
    await flushFireAndForget();
    jest.clearAllMocks();
    // Default: prompt file loads successfully
    mockReadFile.mockResolvedValue(PROMPT_TEMPLATE as never);
  });

  it('1. successful evaluation — correct scores computed, saveEvaluation called', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    // chat_sessions query
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-123', tenant_id: 'tenant-abc', prompt_variant_id: 'v-test-1' }] })
      // chat_messages query
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '中古車の予算は？', created_at: new Date() },
          { role: 'assistant', content: 'ご予算の目安を教えてください。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({
      overall_score: 75,
      psychology_fit_score: 80,
      customer_reaction_score: 70,
      stage_progress_score: 75,
      taboo_violation_score: 90,
    }));

    const result = await evaluateSession('session-123');

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(75);
    expect(result!.psychology_fit_score).toBe(80);
    expect(result!.customer_reaction_score).toBe(70);
    expect(result!.stage_progress_score).toBe(75);
    expect(result!.taboo_violation_score).toBe(90);

    // tuning_rules SELECT (call index 2) must include the 'global' shared-tenant fallback
    // so judge evaluates against the same rule set runtime applies (tenant + global)
    const tuningSelectCall = mockPool.query.mock.calls[2]!;
    expect(tuningSelectCall[0]).toContain('tuning_rules');
    expect(tuningSelectCall[0]).toMatch(/tenant_id = \$1\s+OR\s+tenant_id = 'global'/);

    // INSERT was called with tenant_id and session_id (index 3 after Phase60-A tuning_rules SELECT)
    const insertCall = mockPool.query.mock.calls[3]!;
    expect(insertCall[1]).toContain('tenant-abc');
    expect(insertCall[1]).toContain('session-123');

    // callGeminiJudge が正しい tenantId を usageContext として渡していること
    // （billable:false は維持=Stripe請求には含めないが、テナント別消費量として計上する）
    expect(mockCallGroq).toHaveBeenCalledWith(
      expect.any(String),
      { tenantId: 'tenant-abc', billable: false },
    );
  });

  it('2. low score triggers tuning_rules insert (score < 60)', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-low', tenant_id: 'tenant-low', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '商品が欲しい', created_at: new Date() },
          { role: 'assistant', content: '商品Aです。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // INSERT tuning_rules
      .mockResolvedValueOnce({ rows: [] });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({
      overall_score: 30,
      psychology_fit_score: 20,
      customer_reaction_score: 30,
      stage_progress_score: 40,
      taboo_violation_score: 50,
    }));

    const result = await evaluateSession('session-low');

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(30);

    // Should have called INSERT for tuning_rules (5th query call after Phase60-A)
    expect(mockPool.query.mock.calls.length).toBeGreaterThanOrEqual(5);
    const tuningInsertCall = mockPool.query.mock.calls[4]!;
    expect(tuningInsertCall[0]).toContain('tuning_rules');
    // is_active=false と source='judge' が明示されること(店主の承認なしに有効化しない)
    expect(tuningInsertCall[0]).toContain('is_active');
    expect(tuningInsertCall[0]).toContain('false');
    expect(tuningInsertCall[0]).toContain("'judge'");
  });

  it('3. high score does NOT insert tuning_rules (score >= 60)', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-high', tenant_id: 'tenant-high', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '予算200万で家族4人', created_at: new Date() },
          { role: 'assistant', content: 'ファミリー向けのシエンタが198万円で...', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({
      overall_score: 82,
      psychology_fit_score: 85,
      customer_reaction_score: 80,
      stage_progress_score: 82,
      taboo_violation_score: 95,
    }));

    const result = await evaluateSession('session-high');

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(82);

    // 4 queries: sessions, messages, tuning_rules SELECT (Phase60-A), INSERT evaluations
    // tuning_rules INSERT should NOT be called (score >= threshold)
    expect(mockPool.query.mock.calls.length).toBe(4);
    const queryTexts = mockPool.query.mock.calls.map((c) => c[0] as string);
    const insertCalls = queryTexts.filter((q) => q.includes('INSERT') && q.includes('tuning_rules'));
    expect(insertCalls.length).toBe(0);
  });

  it('4. Groq failure → returns null, does not throw', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-fail', tenant_id: 'tenant-fail', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'hi', created_at: new Date() },
          { role: 'assistant', content: 'hello', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] });

    // Both attempts fail
    mockCallGroq
      .mockRejectedValueOnce(new Error('Groq network error'))
      .mockRejectedValueOnce(new Error('Groq network error'));

    await expect(evaluateSession('session-grq-fail')).resolves.toBeNull();
  });

  it('5. DB failure → returns null, does not throw', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    // chat_sessions query throws
    mockPool.query.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(evaluateSession('session-db-fail')).resolves.toBeNull();
  });

  it('6. Messages truncated to 200 chars in conversation log', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    const longContent = 'あ'.repeat(300);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-trunc', tenant_id: 'tenant-trunc', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: longContent, created_at: new Date() },
          { role: 'assistant', content: '承知しました。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 70 }));

    await evaluateSession('session-trunc');

    expect(mockCallGroq).toHaveBeenCalledTimes(1);
    const callArgs = mockCallGroq.mock.calls[0]!;
    // callGeminiJudge takes a single string prompt argument
    const promptArg = callArgs[0] as string;

    // 200 chars of 'あ' should be present
    expect(promptArg).toContain('あ'.repeat(200));
    // 201st char should not be present (300 chars would be present if not truncated)
    expect(promptArg).not.toContain('あ'.repeat(201));
  });

  // Phase47-B: 評価完了後の OpenClaw-RL reward signal 配線
  // PR-10: outcome の元だった flowContextStore(terminalReason)は書き手が LangGraph一式のみで
  // 実在しなかった（PR-10で削除）。書き手を作らず削除する側を選んだため、outcome は常に
  // 'unknown' 固定で送られる（挙動自体は変わらない。元々 terminalReason は常に undefined だった）。
  it('7. Phase47-B: 評価成功時に sendRewardSignal が正しい payload で呼ばれる（outcome は常に unknown 固定）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-reward', tenant_id: 'tenant-reward', prompt_variant_id: 'v-test-1' }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '納期はいつですか？', created_at: new Date() },
          { role: 'assistant', content: '最短で3日です。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 75 }));

    const result = await evaluateSession('session-reward');
    expect(result).not.toBeNull();

    await flushFireAndForget();

    expect(mockSendRewardSignal).toHaveBeenCalledTimes(1);
    expect(mockSendRewardSignal).toHaveBeenCalledWith({
      tenantId: 'tenant-reward',
      sessionId: 'session-reward',
      variantId: 'v-test-1',
      score: 75,
      outcome: 'unknown',
    });
  });

  it('8. Phase47-B: prompt_variant_id が null なら variantId: null, outcome: unknown', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-novariant', tenant_id: 'tenant-novariant', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '在庫はありますか？', created_at: new Date() },
          { role: 'assistant', content: 'ございます。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 80 }));

    const result = await evaluateSession('session-novariant');
    expect(result).not.toBeNull();

    await flushFireAndForget();

    expect(mockSendRewardSignal).toHaveBeenCalledTimes(1);
    expect(mockSendRewardSignal).toHaveBeenCalledWith({
      tenantId: 'tenant-novariant',
      sessionId: 'session-novariant',
      variantId: null,
      score: 80,
      outcome: 'unknown',
    });
  });

  // ---------------------------------------------------------------------------
  // expectedTenantId によるテナント越境防止（D1a, evaluations/trigger 経由）
  // ユニットレベルでは今まで未検証だった実ロジック本体（routes.ts側はモックのみでテスト済み）。
  // ---------------------------------------------------------------------------

  it('9. [正常系] expectedTenantId がセッションのtenant_idと一致 → 通常通り評価される', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-match', tenant_id: 'tenant-a', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'hi', created_at: new Date() },
          { role: 'assistant', content: 'hello', created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 80 }));

    const result = await evaluateSession('session-match', 'tenant-a');
    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(80);
  });

  it('10. [境界値] expectedTenantId がセッションの実tenant_idと不一致 → SessionTenantMismatchErrorをthrow、messagesクエリは実行されない', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'internal-uuid-victim', tenant_id: 'tenant-victim', prompt_variant_id: null }],
    });

    await expect(evaluateSession('session-victim', 'tenant-attacker')).rejects.toThrow(
      'session session-victim does not belong to the expected tenant',
    );

    // messages/tuning_rules/INSERT へは到達しない（chat_sessions取得の1回のみ）
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockCallGroq).not.toHaveBeenCalled();
  });

  it('11. [正常系] expectedTenantId=undefined（super_admin相当）→ tenant一致チェックをスキップし全テナントを評価できる', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-any', tenant_id: 'tenant-any-other', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'hi', created_at: new Date() },
          { role: 'assistant', content: 'hello', created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 80 }));

    const result = await evaluateSession('session-any', undefined);
    expect(result).not.toBeNull();
  });

  it('12. [イレギュラー] expectedTenantId が空文字列 → 実テナントIDと一致しない限り不一致扱いになる（空文字を「未指定」として扱わない）', async () => {
    // routes.ts側は isSuperAdmin ? undefined : jwtTenantId を渡す設計であり、
    // roleAuthMiddleware が空tenantを事前に403で弾くため理論上到達しない経路だが、
    // 万一呼び出し規約が破られた場合に「空文字列だから素通り」という劣化防御に
    // ならないことを固定する（'' !== 'tenant-a' で確実に不一致判定される）。
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'internal-uuid-x', tenant_id: 'tenant-a', prompt_variant_id: null }],
    });

    await expect(evaluateSession('session-x', '')).rejects.toThrow(
      'session session-x does not belong to the expected tenant',
    );
  });

  it('13. [存在確認オラクル防止] セッション自体が存在しない場合は expectedTenantId の有無に関わらず SessionNotFoundError をthrowする（nullを返さない）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // chat_sessions: 0行

    await expect(evaluateSession('session-does-not-exist', 'tenant-a')).rejects.toThrow(SessionNotFoundError);
    expect(mockCallGroq).not.toHaveBeenCalled();
  });

  it('14. [存在確認オラクル防止] 「不在」(SessionNotFoundError)と「他テナントのもの」(SessionTenantMismatchError)が別のエラークラスとして区別できる（呼び出し元routes.tsが同一404に統合するための前提）', async () => {
    const mockPool1 = makeMockPool();
    mockGetPool.mockReturnValue(mockPool1 as any);
    mockPool1.query.mockResolvedValueOnce({ rows: [] });
    await expect(evaluateSession('missing-session', 'tenant-a')).rejects.toBeInstanceOf(SessionNotFoundError);

    const mockPool2 = makeMockPool();
    mockGetPool.mockReturnValue(mockPool2 as any);
    mockPool2.query.mockResolvedValueOnce({
      rows: [{ id: 'internal-1', tenant_id: 'tenant-b', prompt_variant_id: null }],
    });
    await expect(evaluateSession('other-tenant-session', 'tenant-a')).rejects.toBeInstanceOf(SessionTenantMismatchError);
  });

  it('15. [境界値] メッセージが0件のセッション → SessionTooShortErrorをthrowする（nullを返さない）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-empty', tenant_id: 'tenant-a', prompt_variant_id: null }] })
      .mockResolvedValueOnce({ rows: [] }); // messages: 0件

    await expect(evaluateSession('session-empty')).rejects.toThrow(SessionTooShortError);
    expect(mockCallGroq).not.toHaveBeenCalled();
  });

  it('16. [境界値] メッセージが1件のみのセッション → SessionTooShortErrorをthrowする（nullを返さない）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-2', tenant_id: 'tenant-a', prompt_variant_id: null }] })
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'こんにちは', created_at: new Date() }] });

    await expect(evaluateSession('session-single-message')).rejects.toThrow(SessionTooShortError);
    expect(mockCallGroq).not.toHaveBeenCalled();
  });

  it('17. [境界値] メッセージがちょうど2件 → SessionTooShortErrorはthrowされず通常通り評価される（0/1件との境界を挟んで反対側を固定する）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-boundary', tenant_id: 'tenant-a', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'こんにちは', created_at: new Date() },
          { role: 'assistant', content: 'いらっしゃいませ', created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 70 }));

    const result = await evaluateSession('session-boundary-2msgs');

    expect(result).not.toBeNull();
    expect(mockCallGroq).toHaveBeenCalledTimes(1);
  });

  it('18. [イレギュラー] 全メッセージがassistant発言のみ（ユーザー発言ゼロ）でも評価は継続する（firstUserMsg空文字列でクラッシュしない）', async () => {
    // 実運用では通常あり得ない（AIが先に2回連続発話するセッション構成）が、
    // messages.length <= 1 のガードは role を見ないため、この構成でも
    // SessionTooShortError にはならず素通りする。firstUserMsg = '' になった際に
    // searchKnowledgeForSuggestion がスキップされ、以降の処理が例外を投げないことを固定する。
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-noUser', tenant_id: 'tenant-a', prompt_variant_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'assistant', content: 'いらっしゃいませ', created_at: new Date() },
          { role: 'assistant', content: '何かお探しですか？', created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 60 }));

    const result = await evaluateSession('session-no-user-messages');

    expect(result).not.toBeNull();
    // searchKnowledgeForSuggestion は firstUserMsg 空文字列のためスキップされ、
    // Gemini 呼び出しには到達すること（クラッシュせず先に進んだ証跡）
    expect(mockCallGroq).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 多重評価ガード（Phase75）
  //
  // 自動評価は langGraphOrchestrator / flowControl の計7箇所から fire-and-forget で
  // 叩かれる。ターン予算超過セッションでは turnIndex > maxTurnsPerSession が以降ずっと
  // 真になるため、ユーザーが発言するたびに何度でも再発火する（並行性を伴わない決定的な
  // 多重実行）。Gemini の二重課金と、重複行による KPI 平均の下振れを防ぐ。
  // -------------------------------------------------------------------------

  it('19. [多重発火防止] 既に評価済みのセッションは SessionAlreadyEvaluatedError をthrowし、Geminiを呼ばない', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    // chat_sessions + EXISTS(conversation_evaluations) を1クエリで返す
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'internal-uuid-dup',
        tenant_id: 'tenant-a',
        prompt_variant_id: null,
        already_evaluated: true,
      }],
    });

    await expect(evaluateSession('session-already-done')).rejects.toThrow(SessionAlreadyEvaluatedError);

    // 最重要: Gemini に到達していないこと（二重課金が起きない証跡）
    expect(mockCallGroq).not.toHaveBeenCalled();
    // messages 取得にも進まない = 後続クエリを一切発行していない
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('20. [多重発火防止] 未評価(already_evaluated=false)なら従来どおり評価が走る（ガードが常時発火しないことの反対側を固定）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'internal-uuid-fresh',
          tenant_id: 'tenant-a',
          prompt_variant_id: null,
          already_evaluated: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'こんにちは', created_at: new Date() },
          { role: 'assistant', content: 'いらっしゃいませ', created_at: new Date() },
        ],
      })
      // tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 70 }));

    const result = await evaluateSession('session-fresh');

    expect(result).not.toBeNull();
    expect(mockCallGroq).toHaveBeenCalledTimes(1);
  });

  it('21. [多重発火防止] 予算超過セッションを何度evaluateしても Gemini は1回だけ（決定的な再発火のシミュレーション）', async () => {
    // langGraphOrchestrator は「終端到達」ごとに evaluateSession を叩く。
    // 予算超過後は毎ターン再発火するため、同じ sessionId で複数回呼ばれる状況を再現する。
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    // 1回目は未評価 → 通常評価。2回目以降は評価済み → ガードで打ち切り。
    let evaluated = false;
    mockPool.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM chat_sessions')) {
        return Promise.resolve({
          rows: [{
            id: 'internal-uuid-budget',
            tenant_id: 'tenant-a',
            prompt_variant_id: null,
            already_evaluated: evaluated,
          }],
        });
      }
      if (typeof sql === 'string' && sql.includes('FROM chat_messages')) {
        return Promise.resolve({
          rows: [
            { role: 'user', content: 'まだ続けたい', created_at: new Date() },
            { role: 'assistant', content: '承知しました', created_at: new Date() },
          ],
        });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO conversation_evaluations')) {
        evaluated = true; // 以降のセッション取得は already_evaluated=true を返す
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });
    mockCallGroq.mockResolvedValue(makeGroqResponse({ overall_score: 70 }));

    // 13ターン目
    const first = await evaluateSession('session-over-budget');
    expect(first).not.toBeNull();

    // 14・15ターン目（ユーザーが発言し続けた場合の再発火）
    await expect(evaluateSession('session-over-budget')).rejects.toThrow(SessionAlreadyEvaluatedError);
    await expect(evaluateSession('session-over-budget')).rejects.toThrow(SessionAlreadyEvaluatedError);

    // Gemini 課金は1回だけ
    expect(mockCallGroq).toHaveBeenCalledTimes(1);
  });

  it('22. [同時実行] INSERTがON CONFLICTで弾かれた敗者は、評価結果は返すが副作用(tuning_rules/通知/reward)をスキップする', async () => {
    // 事前チェック(1b)は「確認してから実行」なので、真に並行した2本は両方すり抜けうる。
    // 行を入れられるのは片方だけなので、敗者は rowCount=0 で検知して副作用を止める。
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'internal-uuid-race',
          tenant_id: 'tenant-race',
          prompt_variant_id: 'v-race',
          already_evaluated: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '雑な対応だな', created_at: new Date() },
          { role: 'assistant', content: 'すみません', created_at: new Date() },
        ],
      })
      // tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations → 競合で0行（敗者）
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 低スコア = 本来なら tuning_rules INSERT・通知・gap検出が走る条件
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 20 }));

    const result = await evaluateSession('session-race-loser');
    await flushFireAndForget();

    // 評価自体は成立しているので結果は返す
    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(20);

    // 副作用は一切追加で走らない: クエリはINSERTまでの4本で打ち切られている
    expect(mockPool.query).toHaveBeenCalledTimes(4);
    // reward signal も送られない（勝者側が送るため）
    expect(mockSendRewardSignal).not.toHaveBeenCalled();
  });

  it('23. [同時実行] 勝者(rowCount=1)は従来どおり副作用が走る（22の反対側を固定）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'internal-uuid-winner',
          tenant_id: 'tenant-winner',
          prompt_variant_id: 'v-win',
          already_evaluated: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '雑な対応だな', created_at: new Date() },
          { role: 'assistant', content: 'すみません', created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations → 1行入った（勝者）
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // INSERT tuning_rules
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 20 }));

    const result = await evaluateSession('session-race-winner');
    await flushFireAndForget();

    expect(result).not.toBeNull();
    // tuning_rules INSERT まで進んでいる（敗者の4本との差分が副作用の有無）
    expect(mockPool.query.mock.calls.length).toBeGreaterThan(4);
    const tuningInsertCall = mockPool.query.mock.calls[4]!;
    expect(tuningInsertCall[0]).toContain('INSERT INTO tuning_rules');
    expect(mockSendRewardSignal).toHaveBeenCalledTimes(1);
  });

  it('24. [ON CONFLICTターゲット] 両INSERTが一意制約のターゲットを明示している（無指定だとSERIAL idにしか反応せずno-opになる回帰の防止）', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'internal-uuid-conflict',
          tenant_id: 'tenant-c',
          prompt_variant_id: null,
          already_evaluated: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'ひどい', created_at: new Date() },
          { role: 'assistant', content: '申し訳ありません', created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 20 }));

    await evaluateSession('session-conflict-target');
    await flushFireAndForget();

    const evalInsertSql = mockPool.query.mock.calls[3]![0] as string;
    expect(evalInsertSql).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*session_id\s*\)\s*DO NOTHING/);

    const ruleInsertSql = mockPool.query.mock.calls[4]![0] as string;
    expect(ruleInsertSql).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*trigger_pattern\s*\)\s*DO NOTHING/);
  });
});
