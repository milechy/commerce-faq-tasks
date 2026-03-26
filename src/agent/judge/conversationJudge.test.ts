// src/agent/judge/conversationJudge.test.ts
// Phase45: conversationJudge のユニットテスト

jest.mock('../llm/groqClient', () => ({
  callGroqWith429Retry: jest.fn(),
}));

import { callGroqWith429Retry } from '../llm/groqClient';
import { evaluateConversation, type JudgeInput } from './conversationJudge';

const mockCallGroq = callGroqWith429Retry as jest.MockedFunction<typeof callGroqWith429Retry>;

const baseInput: JudgeInput = {
  tenantId: 'tenant-test',
  sessionId: 'session-test-123',
  history: [
    { role: 'user', content: 'この商品について教えてください。' },
    { role: 'assistant', content: '多くのお客様が選んでいます（社会的証明）。今月中は特別価格です（希少性）。' },
  ],
  usedPrinciples: ['社会的証明', '希少性'],
  salesStages: ['clarify', 'propose'],
};

const highScoreResponse = JSON.stringify({
  principle_appropriateness: 90,
  customer_reaction: 85,
  stage_progression: 80,
  contraindication_compliance: 85,
  effective_principles: ['社会的証明', '希少性'],
  failed_principles: [],
  notes: '適切な原則使用とポジティブな顧客反応',
});

const lowScoreResponse = JSON.stringify({
  principle_appropriateness: 20,
  customer_reaction: 30,
  stage_progression: 40,
  contraindication_compliance: 50,
  effective_principles: [],
  failed_principles: ['社会的証明', '希少性'],
  notes: '原則の活用が不十分',
});

const contraIndicationResponse = JSON.stringify({
  principle_appropriateness: 10,
  customer_reaction: 5,
  stage_progression: 15,
  contraindication_compliance: 10,
  effective_principles: [],
  failed_principles: ['希少性'],
  notes: '強引な押し売りで顧客の拒絶を無視',
});

describe('evaluateConversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. 4軸スコアから総合スコアが正しく計算される', async () => {
    mockCallGroq.mockResolvedValueOnce(highScoreResponse);

    const result = await evaluateConversation(baseInput);

    // score = round(90*0.3 + 85*0.3 + 80*0.2 + 85*0.2) = round(27 + 25.5 + 16 + 17) = round(85.5) = 86
    const expectedScore = Math.round(90 * 0.3 + 85 * 0.3 + 80 * 0.2 + 85 * 0.2);
    expect(result.score).toBe(expectedScore);
    expect(result.evaluationAxes.principle_appropriateness).toBe(90);
    expect(result.evaluationAxes.customer_reaction).toBe(85);
    expect(result.evaluationAxes.stage_progression).toBe(80);
    expect(result.evaluationAxes.contraindication_compliance).toBe(85);
    expect(result.modelUsed).toBe('llama-3.3-70b-versatile');
  });

  it('2. JSONパースエラー1回目 → リトライして成功', async () => {
    mockCallGroq
      .mockResolvedValueOnce('invalid json response that cannot be parsed!!!')
      .mockResolvedValueOnce(highScoreResponse);

    const result = await evaluateConversation(baseInput);

    expect(mockCallGroq).toHaveBeenCalledTimes(2);
    expect(result.score).toBeGreaterThan(0);
    expect(result.effectivePrinciples).toEqual(['社会的証明', '希少性']);
  });

  it('3. 高スコアシナリオ (score >= 70)', async () => {
    mockCallGroq.mockResolvedValueOnce(highScoreResponse);

    const result = await evaluateConversation(baseInput);

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.effectivePrinciples.length).toBeGreaterThan(0);
    expect(result.failedPrinciples).toHaveLength(0);
  });

  it('4. 低スコアシナリオ (score <= 40)', async () => {
    mockCallGroq.mockResolvedValueOnce(lowScoreResponse);

    const result = await evaluateConversation({
      ...baseInput,
      history: [
        { role: 'user', content: 'どんな商品ですか？' },
        { role: 'assistant', content: '商品Aです。' },
      ],
    });

    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.effectivePrinciples).toHaveLength(0);
    expect(result.failedPrinciples.length).toBeGreaterThan(0);
  });

  it('5. 禁忌違反シナリオ (score <= 30)', async () => {
    mockCallGroq.mockResolvedValueOnce(contraIndicationResponse);

    const result = await evaluateConversation({
      ...baseInput,
      history: [
        { role: 'user', content: 'やっぱりいらないです。' },
        { role: 'assistant', content: '絶対に後悔します！今すぐ買ってください！今だけの価格です！' },
      ],
    });

    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.evaluationAxes.contraindication_compliance).toBeLessThanOrEqual(15);
  });

  it('6. Judge失敗時 → エラーをthrowしない（デフォルト値を返す）', async () => {
    mockCallGroq
      .mockResolvedValueOnce('INVALID')
      .mockResolvedValueOnce('ALSO INVALID');

    // エラーをthrowしないこと
    await expect(evaluateConversation(baseInput)).resolves.not.toThrow();

    const result = await evaluateConversation({
      ...baseInput,
      sessionId: 'session-fail-test',
    });
    // 2回目の呼び出し (4回目のmock呼び出し) もINVALIDなのでデフォルト値
    expect(result.score).toBe(0);
    expect(result.notes).toBe('Judge evaluation failed');
  });

  it('7. 会話履歴が200文字でスライスされること', async () => {
    const longMessage = 'あ'.repeat(300); // 300文字
    const inputWithLongHistory: JudgeInput = {
      ...baseInput,
      history: [
        { role: 'user', content: longMessage },
        { role: 'assistant', content: longMessage },
      ],
    };

    mockCallGroq.mockResolvedValueOnce(highScoreResponse);

    await evaluateConversation(inputWithLongHistory);

    // callGroqWith429Retry に渡されたプロンプトを確認
    expect(mockCallGroq).toHaveBeenCalledTimes(1);
    const callArgs = mockCallGroq.mock.calls[0]!;
    const userMessage = callArgs[0].messages.find((m) => m.role === 'user')?.content ?? '';

    // 300文字のメッセージが200文字以内にスライスされていること
    const slicedContent = 'あ'.repeat(200);
    expect(userMessage).toContain(slicedContent);
    // 201文字目以降は含まれないこと
    expect(userMessage).not.toContain('あ'.repeat(201));
  });
});
