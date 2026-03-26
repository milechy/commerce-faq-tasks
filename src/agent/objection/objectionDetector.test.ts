// src/agent/objection/objectionDetector.test.ts
// Phase46: objectionDetector / objectionInjector のユニットテスト

jest.mock('../llm/groqClient', () => ({
  callGroqWith429Retry: jest.fn(),
}));

import { callGroqWith429Retry } from '../llm/groqClient';
import {
  detectObjectionPatterns,
  saveObjectionPatterns,
  type ChatMessage,
} from './objectionDetector';
import {
  buildObjectionInjectionPrompt,
  findRelevantObjectionPatterns,
  type InjectionContext,
} from './objectionInjector';

const mockCallGroq = callGroqWith429Retry as jest.MockedFunction<typeof callGroqWith429Retry>;

// --- detectObjectionPatterns ---

describe('detectObjectionPatterns', () => {
  test('3ターンパターン検出: 反論→対応→肯定', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '高いですね、ちょっと予算が厳しいです' },
      {
        role: 'assistant',
        content: '価値説明: このプランは長期的にコストを削減できます',
        metadata: { used_principles: ['価値提案'] },
      },
      { role: 'user', content: 'なるほど、それは確かに良さそうですね' },
    ];

    const patterns = detectObjectionPatterns(messages);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].triggerPhrase).toBe('高いですね、ちょっと予算が厳しいです');
    expect(patterns[0].responseStrategy).toBe('価値説明: このプランは長期的にコストを削減できます');
    expect(patterns[0].principleUsed).toBe('価値提案');
  });

  test('反論キーワードなし: 0パターン', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'この商品について教えてください' },
      { role: 'assistant', content: 'こちらの商品は多機能で人気があります' },
      { role: 'user', content: 'わかりました、ありがとう' },
    ];

    const patterns = detectObjectionPatterns(messages);

    expect(patterns).toHaveLength(0);
  });

  test('肯定反応なし: 0パターン', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '高いですね' },
      { role: 'assistant', content: '価値があります' },
      { role: 'user', content: 'やっぱりいいです、結構です' },
    ];

    const patterns = detectObjectionPatterns(messages);

    expect(patterns).toHaveLength(0);
  });

  test('principleUsedがない場合はnullになる', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '値段が高い' },
      { role: 'assistant', content: '品質が保証されています' },
      { role: 'user', content: 'そうですね、確かに' },
    ];

    const patterns = detectObjectionPatterns(messages);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].principleUsed).toBeNull();
  });

  test('メッセージが2件以下の場合は0パターン', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '高いですね' },
      { role: 'assistant', content: '価値があります' },
    ];

    const patterns = detectObjectionPatterns(messages);

    expect(patterns).toHaveLength(0);
  });
});

// --- success_rate計算ロジックの単体テスト ---

describe('success_rate計算', () => {
  test('既存sample_count=4, success_rate=0.8の場合、加重平均が正しく計算される', () => {
    const existingSampleCount = 4;
    const existingSuccessRate = 0.8;
    const newSuccessRate = 1.0; // 新規は全て成功

    const newSampleCount = existingSampleCount + 1;
    const calculatedSuccessRate =
      (existingSuccessRate * existingSampleCount + newSuccessRate) / newSampleCount;

    expect(calculatedSuccessRate).toBeCloseTo(0.84, 5);
    expect(newSampleCount).toBe(5);
  });
});

// --- saveObjectionPatterns ---

describe('saveObjectionPatterns', () => {
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    jest.clearAllMocks();
  });

  test('Groq正規化成功時にUPSERTが実行される', async () => {
    mockCallGroq.mockResolvedValueOnce(
      JSON.stringify({ trigger_phrase: '高い', response_strategy: '価値を説明した' }),
    );

    const patterns = [
      {
        triggerPhrase: '高いですね、予算が厳しい',
        responseStrategy: '価値説明: このプランは長期的にコストを削減できます',
        principleUsed: '価値提案',
      },
    ];

    await saveObjectionPatterns('tenant-test', patterns, mockPool as any);

    expect(mockCallGroq).toHaveBeenCalledTimes(1);
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).toContain('ON CONFLICT (tenant_id, trigger_phrase) DO UPDATE');
    expect(queryCall[1][0]).toBe('tenant-test');
    expect(queryCall[1][1]).toBe('高い');
    expect(queryCall[1][2]).toBe('価値を説明した');
    expect(queryCall[1][3]).toBe('価値提案');
  });

  test('Groq失敗時はフォールバックして元の値でUPSERTが実行される', async () => {
    mockCallGroq.mockRejectedValueOnce(new Error('Groq API error'));

    const patterns = [
      {
        triggerPhrase: '高い',
        responseStrategy: '価値を説明した',
        principleUsed: null,
      },
    ];

    await saveObjectionPatterns('tenant-test', patterns, mockPool as any);

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[1][1]).toBe('高い');
    expect(queryCall[1][2]).toBe('価値を説明した');
  });

  test('空パターン配列の場合はDBアクセスなし', async () => {
    await saveObjectionPatterns('tenant-test', [], mockPool as any);

    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockCallGroq).not.toHaveBeenCalled();
  });
});

// --- buildObjectionInjectionPrompt ---

describe('buildObjectionInjectionPrompt', () => {
  test('パターン3件 → 正しいフォーマットの文字列が返る', () => {
    const context: InjectionContext = {
      patterns: [
        { trigger_phrase: '高い', response_strategy: '価値を説明した', success_rate: 0.9 },
        { trigger_phrase: '他社の方が安い', response_strategy: '差別化を強調した', success_rate: 0.8 },
        { trigger_phrase: '必要ない', response_strategy: '必要性を喚起した', success_rate: 0.7 },
      ],
    };

    const result = buildObjectionInjectionPrompt(context);

    expect(result).toContain('【過去の成功パターン（内部参考用 — そのまま使わず自然に応用してください）】');
    expect(result).toContain('この顧客の反論に似た過去の成功事例:');
    expect(result).toContain('「高い」と言われた時 → 価値を説明した（成功率: 90%）');
    expect(result).toContain('「他社の方が安い」と言われた時 → 差別化を強調した（成功率: 80%）');
    expect(result).toContain('「必要ない」と言われた時 → 必要性を喚起した（成功率: 70%）');
  });

  test('最大3件に制限される', () => {
    const context: InjectionContext = {
      patterns: [
        { trigger_phrase: '高い', response_strategy: '対応1', success_rate: 0.9 },
        { trigger_phrase: '他社', response_strategy: '対応2', success_rate: 0.8 },
        { trigger_phrase: '予算', response_strategy: '対応3', success_rate: 0.7 },
        { trigger_phrase: '費用', response_strategy: '対応4', success_rate: 0.6 },
      ],
    };

    const result = buildObjectionInjectionPrompt(context);

    // 4件目は含まれない
    expect(result).not.toContain('対応4');
    // 3件は含まれる
    expect(result).toContain('対応1');
    expect(result).toContain('対応2');
    expect(result).toContain('対応3');
  });

  test('空パターン → 空文字列が返る', () => {
    const context: InjectionContext = { patterns: [] };
    const result = buildObjectionInjectionPrompt(context);
    expect(result).toBe('');
  });
});

// --- findRelevantObjectionPatterns ---

describe('findRelevantObjectionPatterns', () => {
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  });

  test('反論キーワードなし → DBアクセスなし', async () => {
    const querySpy = jest.spyOn(mockPool, 'query');

    const result = await findRelevantObjectionPatterns(
      'tenant-test',
      'この商品について教えてください',
      mockPool as any,
    );

    expect(querySpy).not.toHaveBeenCalled();
    expect(result.patterns).toHaveLength(0);
  });

  test('反論キーワードあり → DBアクセスあり', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { trigger_phrase: '高い', response_strategy: '価値を説明した', success_rate: 0.9 },
      ],
    });

    const result = await findRelevantObjectionPatterns(
      'tenant-test',
      '高いですね',
      mockPool as any,
    );

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].trigger_phrase).toBe('高い');
  });

  test('DBエラー時は空配列を返す', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('DB connection error'));

    const result = await findRelevantObjectionPatterns(
      'tenant-test',
      '高いですね',
      mockPool as any,
    );

    expect(result.patterns).toHaveLength(0);
  });
});
