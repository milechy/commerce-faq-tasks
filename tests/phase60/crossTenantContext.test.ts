// tests/phase60/crossTenantContext.test.ts
// Phase60-B: crossTenantContext ユニットテスト

jest.mock('../../src/lib/db', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { pool } from '../../src/lib/db';
import {
  getCrossTenantContext,
  formatCrossTenantContext,
  _clearCacheForTesting,
  CrossTenantContext,
} from '../../src/lib/crossTenantContext';

const mockQuery = pool!.query as jest.Mock;

function makeAvgRow(overrides: Partial<{
  avg_overall: string;
  avg_psych: string;
  avg_reaction: string;
  avg_stage: string;
  total_tenants: string;
}> = {}) {
  return {
    avg_overall: '72.5',
    avg_psych: '68.0',
    avg_reaction: '75.0',
    avg_stage: '70.0',
    total_tenants: '5',
    ...overrides,
  };
}

describe('[60B] crossTenantContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearCacheForTesting();
  });

  // 1. スコアが正しく返される
  it('1. getCrossTenantContext — avgScores が正しく計算される', async () => {
    mockQuery
      // fetchAvgScores
      .mockResolvedValueOnce({ rows: [makeAvgRow()] })
      // fetchTopPsychologyPrinciples
      .mockResolvedValueOnce({ rows: [
        { principle: '返報性', cv_rate: '35.5', total: '10' },
      ]})
      // fetchCommonGapPatterns
      .mockResolvedValueOnce({ rows: [
        { pattern: 'llm_low_score', gap_count: '8' },
      ]})
      // fetchEffectiveRulePatterns
      .mockResolvedValueOnce({ rows: [{ total_rules: '20', active_rules: '15' }] });

    const ctx = await getCrossTenantContext();

    expect(ctx.avgScores).not.toBeNull();
    expect(ctx.avgScores!.overall).toBe(72.5);
    expect(ctx.avgScores!.psychologyFit).toBe(68.0);
    expect(ctx.avgScores!.customerReaction).toBe(75.0);
    expect(ctx.avgScores!.stageProgress).toBe(70.0);
    expect(ctx.totalTenants).toBe(5);
  });

  // 2. 心理原則リストが返される
  it('2. getCrossTenantContext — topPsychologyPrinciples が正しく返される', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeAvgRow()] })
      .mockResolvedValueOnce({ rows: [
        { principle: '返報性', cv_rate: '35.5', total: '12' },
        { principle: 'スノッブ効果', cv_rate: '28.0', total: '7' },
      ]})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_rules: '5', active_rules: '3' }] });

    const ctx = await getCrossTenantContext();

    expect(ctx.topPsychologyPrinciples).toHaveLength(2);
    expect(ctx.topPsychologyPrinciples[0]!.principle).toBe('返報性');
    expect(ctx.topPsychologyPrinciples[0]!.conversionRate).toBe(35.5);
    expect(ctx.topPsychologyPrinciples[0]!.sampleSize).toBe(12);
  });

  // 3. テーブル不存在 (42P01) でも空コンテキストを返す（silent fail）
  it('3. テーブルが存在しない (42P01) → 空コンテキスト、エラーログなし', async () => {
    const tableErr = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    mockQuery.mockRejectedValue(tableErr);

    const ctx = await getCrossTenantContext();

    expect(ctx.avgScores).toBeNull();
    expect(ctx.topPsychologyPrinciples).toHaveLength(0);
    expect(ctx.totalTenants).toBe(0);

    const { logger } = require('../../src/lib/logger');
    // 42P01 エラーはwarnを呼ばない
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // 4. PII・テナント識別情報が含まれない（tenant_id / visitor_id を返さない）
  it('4. 返り値にtenant_id・visitor_idが含まれない', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeAvgRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_rules: '3', active_rules: '2' }] });

    const ctx = await getCrossTenantContext();

    const json = JSON.stringify(ctx);
    expect(json).not.toContain('tenant_id');
    expect(json).not.toContain('visitor_id');
  });

  // 5. faq_embeddings テーブルにアクセスしない
  it('5. faq_embeddingsテーブルにアクセスしない', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeAvgRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await getCrossTenantContext();

    const allSql: string[] = (mockQuery.mock.calls as [string, unknown[]][])
      .map(([sql]) => sql as string);
    expect(allSql.every((sql) => !sql.includes('faq_embeddings'))).toBe(true);
  });

  // 6. キャッシュ: 2回目の呼び出しでDBクエリが増えない
  it('6. 1時間TTLキャッシュ — 2回目はDBを呼ばない', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeAvgRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await getCrossTenantContext();
    const callCountAfterFirst = mockQuery.mock.calls.length;

    await getCrossTenantContext(); // キャッシュヒット
    expect(mockQuery.mock.calls.length).toBe(callCountAfterFirst); // 増えない
  });

  // 7. formatCrossTenantContext — 見出しとスコア行が含まれる
  it('7. formatCrossTenantContext — 見出しとスコア行が含まれる', () => {
    const ctx: CrossTenantContext = {
      avgScores: { overall: 72.5, psychologyFit: 68, customerReaction: 75, stageProgress: 70 },
      topPsychologyPrinciples: [{ principle: '返報性', conversionRate: 35.5, sampleSize: 10 }],
      commonGapPatterns: ['llm_low_score(8件)'],
      effectiveRulePatterns: ['全テナント合計20件（有効: 15件）'],
      totalTenants: 5,
      dataAsOf: '2025-01-01T00:00:00.000Z',
    };

    const formatted = formatCrossTenantContext(ctx);

    expect(formatted).toContain('## クロステナント統計（匿名集計）');
    expect(formatted).toContain('72.5点');
    expect(formatted).toContain('返報性');
    expect(formatted).toContain('llm_low_score');
  });

  // 8. formatCrossTenantContext — データなしのときは空文字列
  it('8. formatCrossTenantContext — 全データ空 → 空文字列', () => {
    const ctx: CrossTenantContext = {
      avgScores: null,
      topPsychologyPrinciples: [],
      commonGapPatterns: [],
      effectiveRulePatterns: [],
      totalTenants: 0,
      dataAsOf: '2025-01-01T00:00:00.000Z',
    };

    expect(formatCrossTenantContext(ctx)).toBe('');
  });
});
