// src/agent/gap/gapRecommender.test.ts
// GID 1217808323836843: generateRecommendations が tenantId をスコープに持ちながら
// callGeminiJudge への引き渡しを忘れ、trackUsage が tenant_id='unknown' で計上され
// 続けていた。再発防止テスト。

jest.mock('../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));
jest.mock('../../lib/db', () => ({
  getPool: jest.fn(),
}));
jest.mock('../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(''),
}));
jest.mock('../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn().mockResolvedValue({
    avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [],
    effectiveRulePatterns: [], totalTenants: 0, dataAsOf: new Date().toISOString(),
  }),
  formatCrossTenantContext: jest.fn().mockReturnValue(''),
}));
jest.mock('../../lib/research', () => ({
  getResearchProvider: jest.fn().mockReturnValue(null),
}));
jest.mock('../../lib/research/featureCheck', () => ({
  isDeepResearchEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../lib/research/queryBuilder', () => ({
  buildResearchQuery: jest.fn().mockReturnValue(''),
}));

import { generateRecommendations } from './gapRecommender';
import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';

const mockCallGeminiJudge = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;
const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;

describe('generateRecommendations: tenantId の callGeminiJudge への伝播', () => {
  beforeEach(() => {
    mockCallGeminiJudge.mockReset();
    mockGetPool.mockReset();
  });

  it('callGeminiJudge に実 tenantId を渡す（tenant_id="unknown" 計上を防ぐ）', async () => {
    const mockQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1, user_question: '営業時間は？' }] }) // SELECT gaps
      .mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockGetPool.mockReturnValue({ query: mockQuery } as any);
    mockCallGeminiJudge.mockResolvedValue(
      '[{"index":1,"recommended_action":"営業時間FAQを追加","suggested_answer":"平日9-18時です"}]'
    );

    await generateRecommendations('carnation');

    expect(mockCallGeminiJudge).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'carnation', billable: false }),
    );
  });

  it('未回答ギャップが無ければ callGeminiJudge を呼ばずに空配列を返す', async () => {
    const mockQuery = jest.fn().mockResolvedValueOnce({ rows: [] });
    mockGetPool.mockReturnValue({ query: mockQuery } as any);

    const result = await generateRecommendations('carnation');

    expect(result).toEqual([]);
    expect(mockCallGeminiJudge).not.toHaveBeenCalled();
  });
});
