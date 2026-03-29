// tests/phase46/gapRecommender.test.ts
// Phase46 Stream B: gapRecommender unit tests

const mockQuery = jest.fn();
const mockPool = { query: mockQuery };

jest.mock('../../src/lib/db', () => ({ getPool: () => mockPool }));
jest.mock('../../src/lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));

import { callGeminiJudge } from '../../src/lib/gemini/client';
import { generateRecommendations } from '../../src/agent/gap/gapRecommender';

const mockCallGemini = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;

const GAPS = [
  { id: 1, user_question: '返品ポリシーはどうなっていますか？' },
  { id: 2, user_question: '送料はいくらですか？' },
];

const GEMINI_RESPONSE = JSON.stringify([
  { index: 1, recommended_action: '返品ポリシーページのFAQを追加する', suggested_answer: '返品は購入後30日以内に受け付けています。' },
  { index: 2, recommended_action: '送料に関するFAQを追加する', suggested_answer: '送料は全国一律500円です。' },
]);

describe('generateRecommendations', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCallGemini.mockReset();
  });

  it('1. fetches gaps, calls Gemini, saves to DB, returns recommendations', async () => {
    // gaps query
    mockQuery.mockResolvedValueOnce({ rows: GAPS });
    // faq summary query
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // UPDATE gap 1
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // UPDATE gap 2
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockCallGemini.mockResolvedValueOnce(GEMINI_RESPONSE);

    const result = await generateRecommendations('tenant-abc');

    expect(result).toHaveLength(2);
    expect(result[0]!.gapId).toBe(1);
    expect(result[0]!.recommendedAction).toBe('返品ポリシーページのFAQを追加する');
    expect(result[1]!.gapId).toBe(2);
  });

  it('2. returns [] when no pending gaps found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateRecommendations('tenant-empty');

    expect(result).toHaveLength(0);
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it('3. returns [] when Gemini call throws', async () => {
    mockQuery.mockResolvedValueOnce({ rows: GAPS });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockCallGemini.mockRejectedValueOnce(new Error('Gemini API error'));

    const result = await generateRecommendations('tenant-fail');

    expect(result).toHaveLength(0);
  });

  it('4. returns [] when Gemini response has no JSON array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: GAPS });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockCallGemini.mockResolvedValueOnce('申し訳ありませんが、JSONを生成できませんでした。');

    const result = await generateRecommendations('tenant-bad-json');

    expect(result).toHaveLength(0);
  });

  it('5. truncates recommendedAction to 500 chars and suggestedAnswer to 1000 chars', async () => {
    const longRecommendedAction = 'A'.repeat(600);
    const longSuggestedAnswer = 'B'.repeat(1200);

    mockQuery.mockResolvedValueOnce({ rows: [GAPS[0]!] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

    mockCallGemini.mockResolvedValueOnce(
      JSON.stringify([{ index: 1, recommended_action: longRecommendedAction, suggested_answer: longSuggestedAnswer }]),
    );

    const result = await generateRecommendations('tenant-trunc');

    expect(result[0]!.recommendedAction).toHaveLength(500);
    expect(result[0]!.suggestedAnswer).toHaveLength(1000);
  });

  it('6. skips invalid index entries without crashing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [GAPS[0]!] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE for valid item

    mockCallGemini.mockResolvedValueOnce(
      JSON.stringify([
        { index: 99, recommended_action: '存在しないindex', suggested_answer: 'N/A' },
        { index: 1, recommended_action: '有効な提案', suggested_answer: '有効な回答' },
      ]),
    );

    const result = await generateRecommendations('tenant-skip');

    expect(result).toHaveLength(1);
    expect(result[0]!.recommendedAction).toBe('有効な提案');
  });

  it('7. respects limit parameter (max BATCH_SIZE=20)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await generateRecommendations('tenant-limit', 5);

    const firstCall = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(firstCall[1][1]).toBe(5); // limit arg passed to DB query
  });

  it('8. DB failure on gaps query returns [] without throwing', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await generateRecommendations('tenant-db-fail');

    expect(result).toHaveLength(0);
  });
});
