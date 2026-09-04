// src/lib/date/jstOffset.ts
// JST(UTC+9固定・DSTなし)壁時計計算の共通化。
//
// weekRange.ts(getWeekRange)とplanQuota.ts(getMonthRangeJst)が同じ手法
// 「+9hシフト→UTCゲッターで読む→-9hシフトで戻す」を個別に実装していたため、
// シフト量とシフト処理そのものをここへ集約する(出力は変更しない純粋なリファクタ)。

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * now を +9h シフトした Date を返す。
 * 呼び出し側がこの Date の UTC ゲッター(getUTCFullYear/getUTCMonth/getUTCDate/getUTCDay等)
 * を読むと、process TZ に依存せず JST の壁時計表現(年月日・曜日)が得られる。
 */
export function shiftToJstWallClock(now: Date): Date {
  return new Date(now.getTime() + JST_OFFSET_MS);
}

/**
 * now を含む「JST の暦日の開始（00:00 JST）」を UTC Date で返す。
 * WordPress プラグイン計画の日次総量ガード(D7: 新規作成30件/日)が、
 * getMonthRangeJst / getWeekRange と同じ手法(process TZ非依存のUTC算術)で
 * 日境界を必要としたため追加。
 */
export function getDayStartJst(now: Date): Date {
  const shifted = shiftToJstWallClock(now);
  const shiftedDayStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    0, 0, 0, 0,
  );
  return new Date(shiftedDayStart - JST_OFFSET_MS);
}
