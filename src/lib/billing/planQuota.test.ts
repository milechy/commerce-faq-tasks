/**
 * planQuota ユニットテスト
 *
 * - getMonthRangeJst: JST月初ちょうど / 月末深夜 / 月またぎ / 年またぎ / TZ非依存
 * - isFreeAdMonthlyQuotaExceeded: 境界値(N-1/N/N+1) / 上限0 / 負の値で例外
 */

import { getMonthRangeJst, isFreeAdMonthlyQuotaExceeded, FREE_AD_MONTHLY_REQUEST_LIMIT } from './planQuota';

describe('getMonthRangeJst', () => {
  it('JST月初(1日00:00:00.000)ちょうどでは monthStart が現在時刻と一致する', () => {
    const now = new Date('2026-07-31T15:00:00.000Z'); // 2026-08-01T00:00:00 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    expect(r.monthEnd.toISOString()).toBe('2026-08-31T15:00:00.000Z'); // 2026-09-01T00:00:00 JST
  });

  it('JST月末23:59:59.999でも同じ月の範囲のままである（月末の境界）', () => {
    const now = new Date('2026-08-31T14:59:59.999Z'); // 2026-08-31T23:59:59.999 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2026-07-31T15:00:00.000Z'); // 2026-08-01T00:00:00 JST
    expect(r.monthEnd.toISOString()).toBe('2026-08-31T15:00:00.000Z'); // 2026-09-01T00:00:00 JST
  });

  it('翌月に入った瞬間(JST 00:00:00.000ちょうど)に月が切り替わる', () => {
    const now = new Date('2026-08-31T15:00:00.000Z'); // 2026-09-01T00:00:00 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2026-08-31T15:00:00.000Z');
    expect(r.monthEnd.toISOString()).toBe('2026-09-30T15:00:00.000Z'); // 2026-10-01T00:00:00 JST
  });

  it('年またぎ(12月→1月)でも正しい月初を計算できる', () => {
    const now = new Date('2025-12-15T12:00:00.000Z'); // 2025-12-15T21:00:00 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2025-11-30T15:00:00.000Z'); // 2025-12-01T00:00:00 JST
    expect(r.monthEnd.toISOString()).toBe('2025-12-31T15:00:00.000Z'); // 2026-01-01T00:00:00 JST
  });

  it('2月(うるう年)でも正しく翌月(3月)へ切り替わる', () => {
    const now = new Date('2028-02-15T12:00:00.000Z'); // 2028年はうるう年
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2028-01-31T15:00:00.000Z'); // 2028-02-01T00:00:00 JST
    expect(r.monthEnd.toISOString()).toBe('2028-02-29T15:00:00.000Z'); // 2028-03-01T00:00:00 JST(うるう年)
  });

  it('process.env.TZ を変更しても結果が変わらない（process TZ非依存の回帰検知）', () => {
    const now = new Date('2026-08-15T18:00:00.000Z');
    const originalTz = process.env.TZ;

    try {
      process.env.TZ = 'America/New_York';
      const inNy = getMonthRangeJst(now);

      process.env.TZ = 'UTC';
      const inUtc = getMonthRangeJst(now);

      expect(inNy.monthStart.toISOString()).toBe(inUtc.monthStart.toISOString());
      expect(inNy.monthEnd.toISOString()).toBe(inUtc.monthEnd.toISOString());
      expect(inUtc.monthStart.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('process.env.TZ = Asia/Tokyo でも UTC と同じ結果になる（境界時刻での回帰検知）', () => {
    const now = new Date('2026-08-31T14:59:59.999Z'); // JST月末ぎりぎり
    const originalTz = process.env.TZ;

    try {
      process.env.TZ = 'Asia/Tokyo';
      const inTokyo = getMonthRangeJst(now);

      process.env.TZ = 'UTC';
      const inUtc = getMonthRangeJst(now);

      expect(inTokyo.monthStart.toISOString()).toBe(inUtc.monthStart.toISOString());
      expect(inTokyo.monthEnd.toISOString()).toBe(inUtc.monthEnd.toISOString());
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('isFreeAdMonthlyQuotaExceeded', () => {
  it('既定の上限は200である', () => {
    expect(FREE_AD_MONTHLY_REQUEST_LIMIT).toBe(200);
  });

  it('上限未満(199件)なら false（200件目のリクエストを許可する）', () => {
    expect(isFreeAdMonthlyQuotaExceeded(199)).toBe(false);
  });

  it('ちょうど上限(200件)なら true（201件目のリクエストは拒否する）', () => {
    expect(isFreeAdMonthlyQuotaExceeded(200)).toBe(true);
  });

  it('上限超過(201件)なら true', () => {
    expect(isFreeAdMonthlyQuotaExceeded(201)).toBe(true);
  });

  it('0件なら false', () => {
    expect(isFreeAdMonthlyQuotaExceeded(0)).toBe(false);
  });

  it('上限を明示的に0にすると、0件でも true（初回のリクエストから拒否。無限ループ・無応答にならない）', () => {
    expect(isFreeAdMonthlyQuotaExceeded(0, 0)).toBe(true);
  });

  it('負のcountは例外を投げる', () => {
    expect(() => isFreeAdMonthlyQuotaExceeded(-1)).toThrow(/Invalid currentMonthRequestCount/);
  });

  it('負のlimitは例外を投げる', () => {
    expect(() => isFreeAdMonthlyQuotaExceeded(5, -1)).toThrow(/Invalid limit/);
  });

  it('カスタム上限を指定できる', () => {
    expect(isFreeAdMonthlyQuotaExceeded(9, 10)).toBe(false);
    expect(isFreeAdMonthlyQuotaExceeded(10, 10)).toBe(true);
  });
});
