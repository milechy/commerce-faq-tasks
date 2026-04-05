// tests/phase58/autoTuning.test.ts
// Phase58: Auto-tuning フライホイール テスト

jest.mock('../../src/lib/db', () => ({
  pool: null,
  getPool: jest.fn(() => { throw new Error('no pool'); }),
}));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

import {
  detectRepeatedJudgeSuggestions,
  detectABWinners,
  detectTopPrinciples,
} from '../../src/api/conversion/autoTuning';

// pool を動的に差し替えるためのヘルパー
function mockPool(responses: Array<{ rows: any[] }>) {
  let callCount = 0;
  const mockP = {
    query: jest.fn().mockImplementation(() =>
      Promise.resolve(responses[callCount++] ?? { rows: [] })
    ),
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.replaceProperty(require('../../src/lib/db'), 'pool', mockP);
  return mockP;
}

describe('detectRepeatedJudgeSuggestions', () => {
  afterEach(() => {
    jest.replaceProperty(require('../../src/lib/db'), 'pool', null);
  });

  it('pool が null → 空配列', async () => {
    const result = await detectRepeatedJudgeSuggestions('tenant-a');
    expect(result).toEqual([]);
  });

  it('3回以上の提案 → 候補あり', async () => {
    mockPool([{ rows: [{ rule: '挨拶を追加する', cnt: 5 }] }]);
    const result = await detectRepeatedJudgeSuggestions('tenant-a');
    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('judge_repeated');
    expect(result[0]!.data['count']).toBe(5);
  });

  it('0件 → 空配列', async () => {
    mockPool([{ rows: [] }]);
    const result = await detectRepeatedJudgeSuggestions('tenant-a');
    expect(result).toEqual([]);
  });

  it('description が cnt を含む', async () => {
    mockPool([{ rows: [{ rule: 'ルールX', cnt: 3 }] }]);
    const result = await detectRepeatedJudgeSuggestions('tenant-a');
    expect(result[0]!.description).toContain('3');
  });
});

describe('detectABWinners', () => {
  afterEach(() => {
    jest.replaceProperty(require('../../src/lib/db'), 'pool', null);
  });

  it('pool が null → 空配列', async () => {
    const result = await detectABWinners('tenant-a');
    expect(result).toEqual([]);
  });

  it('サンプルサイズ達成 + 5%差以上 → 勝者検出', async () => {
    mockPool([{
      rows: [{
        id: 1, name: '実験A', variant_a: '{}', variant_b: '{}', min_sample_size: 100,
        count_a: 100, conv_a: 40, count_b: 100, conv_b: 20, // 差20%
      }],
    }]);
    const result = await detectABWinners('tenant-a');
    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('ab_winner');
    expect(result[0]!.data['winner']).toBe('A');
  });

  it('差が5%未満 → 検出なし', async () => {
    mockPool([{
      rows: [{
        id: 1, name: '実験B', variant_a: '{}', variant_b: '{}', min_sample_size: 100,
        count_a: 100, conv_a: 31, count_b: 100, conv_b: 30, // 差1%
      }],
    }]);
    const result = await detectABWinners('tenant-a');
    expect(result).toEqual([]);
  });

  it('0件 → 空配列', async () => {
    mockPool([{ rows: [] }]);
    const result = await detectABWinners('tenant-a');
    expect(result).toEqual([]);
  });
});

describe('detectTopPrinciples', () => {
  afterEach(() => {
    jest.replaceProperty(require('../../src/lib/db'), 'pool', null);
  });

  it('pool が null → 空配列', async () => {
    const result = await detectTopPrinciples('tenant-a');
    expect(result).toEqual([]);
  });

  it('5件以上のCV → ランキング返却', async () => {
    mockPool([{
      rows: [
        { principle: '損失回避', total: 10, avg_temp: 75 },
        { principle: '社会的証明', total: 7, avg_temp: 60 },
      ],
    }]);
    const result = await detectTopPrinciples('tenant-a');
    expect(result.length).toBe(2);
    expect(result[0]!.type).toBe('effectiveness_top');
    expect(result[0]!.data['principle']).toBe('損失回避');
  });

  it('0件 → 空配列', async () => {
    mockPool([{ rows: [] }]);
    const result = await detectTopPrinciples('tenant-a');
    expect(result).toEqual([]);
  });

  it('description に原則名とCV数が含まれる', async () => {
    mockPool([{ rows: [{ principle: '希少性', total: 8, avg_temp: 70 }] }]);
    const result = await detectTopPrinciples('tenant-a');
    expect(result[0]!.description).toContain('希少性');
    expect(result[0]!.description).toContain('8');
  });
});
