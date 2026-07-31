/**
 * weekRange ユニットテスト
 *
 * - 正常系: 月曜0時JSTちょうど / 経過あり / 日曜深夜 / 年またぎ
 * - 境界値: 週の最初の瞬間(elapsed=0)
 * - TZ非依存: process.env.TZ をUTC以外に変えても結果が変わらないこと
 *   （AT TIME ZONE を片側だけ書く事故はSQL側の話だが、この関数がもし process TZ に
 *   依存する実装に書き換えられた場合の回帰をここで検知する）
 */

import { getWeekRange } from './weekRange';

describe('getWeekRange', () => {
  it('月曜00:00:00.000 JSTちょうどでは今週の開始が現在時刻と一致し、先週比較の経過は0になる', () => {
    const now = new Date('2026-08-02T15:00:00.000Z'); // 2026-08-03T00:00:00 JST (月)
    const r = getWeekRange(now);

    expect(r.weekStart.toISOString()).toBe('2026-08-02T15:00:00.000Z');
    expect(r.prevWeekStart.toISOString()).toBe('2026-07-26T15:00:00.000Z');
    expect(r.prevWeekEnd.getTime()).toBe(r.prevWeekStart.getTime());
  });

  it('月曜03:00 JST(経過3時間)では、先週の同一経過時間の終端が3時間後になる', () => {
    const now = new Date('2026-08-02T18:00:00.000Z'); // 2026-08-03T03:00:00 JST (月)
    const r = getWeekRange(now);

    expect(r.weekStart.toISOString()).toBe('2026-08-02T15:00:00.000Z');
    expect(r.prevWeekEnd.toISOString()).toBe('2026-07-26T18:00:00.000Z');
    expect(r.prevWeekEnd.getTime() - r.prevWeekStart.getTime()).toBe(3 * 60 * 60 * 1000);
  });

  it('日曜23:59:59.999 JSTでも同じ週の開始のままである（週末の境界）', () => {
    const now = new Date('2026-08-09T14:59:59.999Z'); // 2026-08-09T23:59:59.999 JST (日)
    const r = getWeekRange(now);

    expect(r.weekStart.toISOString()).toBe('2026-08-02T15:00:00.000Z');
  });

  it('翌週月曜00:00:00.000 JSTちょうどでは週が切り替わる', () => {
    const now = new Date('2026-08-09T15:00:00.000Z'); // 2026-08-10T00:00:00 JST (月・翌週)
    const r = getWeekRange(now);

    expect(r.weekStart.toISOString()).toBe('2026-08-09T15:00:00.000Z');
    expect(r.prevWeekStart.toISOString()).toBe('2026-08-02T15:00:00.000Z');
  });

  it('年またぎでも正しい月曜(2025-12-29 JST)を計算できる', () => {
    const now = new Date('2025-12-30T12:00:00.000Z'); // 2025-12-30T21:00:00 JST (火)
    const r = getWeekRange(now);

    expect(r.weekStart.toISOString()).toBe('2025-12-28T15:00:00.000Z'); // 2025-12-29T00:00:00 JST (月)
  });

  it('process.env.TZ を変更しても結果が変わらない（process TZ非依存の回帰検知）', () => {
    const now = new Date('2026-08-02T18:00:00.000Z');
    const originalTz = process.env.TZ;

    try {
      process.env.TZ = 'America/New_York';
      const inNy = getWeekRange(now);

      process.env.TZ = 'UTC';
      const inUtc = getWeekRange(now);

      expect(inNy.weekStart.toISOString()).toBe(inUtc.weekStart.toISOString());
      expect(inNy.prevWeekStart.toISOString()).toBe(inUtc.prevWeekStart.toISOString());
      expect(inNy.prevWeekEnd.toISOString()).toBe(inUtc.prevWeekEnd.toISOString());
      expect(inUtc.weekStart.toISOString()).toBe('2026-08-02T15:00:00.000Z');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
