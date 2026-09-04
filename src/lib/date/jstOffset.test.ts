// src/lib/date/jstOffset.test.ts
//
// getDayStartJst は WordPress プラグイン計画の日次総量ガード(D7)向けに追加した。
// getWeekRange / getMonthRangeJst と同じ手法(process TZ非依存のUTC算術)を
// 使っているため、境界がJSTの日付をまたぐ瞬間だけを確認すれば十分。

import { getDayStartJst } from "./jstOffset";

describe("getDayStartJst", () => {
  it("JST日中の任意時刻から、その日の00:00 JSTを返す(UTC表現)", () => {
    // 2026-09-04 15:00 JST = 2026-09-04 06:00 UTC
    const now = new Date("2026-09-04T06:00:00.000Z");
    // 00:00 JST = 前日 15:00 UTC
    expect(getDayStartJst(now)).toEqual(new Date("2026-09-03T15:00:00.000Z"));
  });

  it("JSTの日付が変わる境界をまたぐ(UTC 14:59→15:00)", () => {
    // 2026-09-04 23:59 JST = 2026-09-04 14:59 UTC → まだ9/4
    const beforeMidnight = new Date("2026-09-04T14:59:00.000Z");
    expect(getDayStartJst(beforeMidnight)).toEqual(new Date("2026-09-03T15:00:00.000Z"));

    // 2026-09-05 00:00 JST = 2026-09-04 15:00 UTC → 9/5 になる
    const atMidnight = new Date("2026-09-04T15:00:00.000Z");
    expect(getDayStartJst(atMidnight)).toEqual(new Date("2026-09-04T15:00:00.000Z"));
  });

  it("ちょうど00:00 JSTを渡すと自分自身を返す(冪等)", () => {
    const dayStart = new Date("2026-09-03T15:00:00.000Z"); // 2026-09-04 00:00 JST
    expect(getDayStartJst(dayStart)).toEqual(dayStart);
  });

  // process TZ に依存しないことの直接確認: UTC表記とJST表記で同じ瞬間を渡しても
  // 同じ結果になる。
  it("同じ瞬間ならタイムゾーン表記が違っても同じ結果になる", () => {
    const utc = new Date("2026-09-04T06:00:00.000Z");
    const jst = new Date("2026-09-04T15:00:00.000+09:00");
    expect(utc.getTime()).toBe(jst.getTime());
    expect(getDayStartJst(utc)).toEqual(getDayStartJst(jst));
  });

  it("月をまたぐ境界でも正しい(8/31→9/1 JST)", () => {
    // 2026-09-01 00:30 JST = 2026-08-31 15:30 UTC
    const now = new Date("2026-08-31T15:30:00.000Z");
    // 00:00 JST(9/1) = 8/31 15:00 UTC
    expect(getDayStartJst(now)).toEqual(new Date("2026-08-31T15:00:00.000Z"));
  });
});
