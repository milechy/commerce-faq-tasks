// tests/phase57/behaviorContext.test.ts
// Phase57: getBehaviorContext / formatBehaviorContextForPrompt テスト

import { formatBehaviorContextForPrompt } from '../../src/api/events/behaviorContext';
import type { BehaviorContext } from '../../src/api/events/behaviorContext';

// pool をモック
jest.mock('../../src/lib/db', () => ({ pool: null }));

// temperatureScoring をモック
jest.mock('../../src/api/events/temperatureScoring', () => ({
  getVisitorTemperature: jest.fn().mockResolvedValue({ score: 50, level: 'warm' }),
  calculateTemperature: jest.requireActual('../../src/api/events/temperatureScoring').calculateTemperature,
}));

describe('formatBehaviorContextForPrompt', () => {
  const baseCold: BehaviorContext = {
    pageViewsSummary: [],
    maxScrollDepth: 0,
    totalIdleTime: 0,
    tempScore: 10,
    tempLevel: 'cold',
    referrerSummary: 'direct',
    isReturnVisit: false,
    productViews: [],
  };

  it('cold → 信頼構築重視のアプローチ', () => {
    const text = formatBehaviorContextForPrompt(baseCold);
    expect(text).toContain('信頼構築重視');
    expect(text).toContain('cold');
  });

  it('warm → 提案重視のアプローチ', () => {
    const ctx: BehaviorContext = { ...baseCold, tempLevel: 'warm', tempScore: 50 };
    const text = formatBehaviorContextForPrompt(ctx);
    expect(text).toContain('提案重視');
    expect(text).toContain('warm');
  });

  it('hot → クロージング重視のアプローチ', () => {
    const ctx: BehaviorContext = { ...baseCold, tempLevel: 'hot', tempScore: 80 };
    const text = formatBehaviorContextForPrompt(ctx);
    expect(text).toContain('クロージング重視');
    expect(text).toContain('hot');
  });

  it('pageViewsSummary が含まれる', () => {
    const ctx: BehaviorContext = {
      ...baseCold,
      pageViewsSummary: ['https://example.com/', 'https://example.com/products'],
    };
    const text = formatBehaviorContextForPrompt(ctx);
    expect(text).toContain('https://example.com/');
  });

  it('productViews が3件まで含まれる', () => {
    const ctx: BehaviorContext = {
      ...baseCold,
      productViews: ['商品A', '商品B', '商品C'],
    };
    const text = formatBehaviorContextForPrompt(ctx);
    expect(text).toContain('閲覧商品: 商品A, 商品B, 商品C');
  });

  it('productViews 空の場合は閲覧商品行を含まない', () => {
    const text = formatBehaviorContextForPrompt(baseCold);
    expect(text).not.toContain('閲覧商品');
  });

  it('リピーター情報が含まれる', () => {
    const ctx: BehaviorContext = { ...baseCold, isReturnVisit: true };
    const text = formatBehaviorContextForPrompt(ctx);
    expect(text).toContain('リピーター');
  });

  it('初回訪問情報が含まれる', () => {
    const text = formatBehaviorContextForPrompt(baseCold);
    expect(text).toContain('初回');
  });

  it('スクロール深度と滞在時間が含まれる', () => {
    const ctx: BehaviorContext = {
      ...baseCold,
      maxScrollDepth: 75,
      totalIdleTime: 120,
    };
    const text = formatBehaviorContextForPrompt(ctx);
    expect(text).toContain('75%');
    expect(text).toContain('120秒');
  });
});

describe('getBehaviorContext', () => {
  it('pool が null → null を返す', async () => {
    // pool is mocked as null
    const { getBehaviorContext } = await import('../../src/api/events/behaviorContext');
    const result = await getBehaviorContext('tenant-a', 'visitor-1');
    expect(result).toBeNull();
  });

  it('visitorId が空 → null を返す', async () => {
    const { getBehaviorContext } = await import('../../src/api/events/behaviorContext');
    const result = await getBehaviorContext('tenant-a', '');
    expect(result).toBeNull();
  });
});
