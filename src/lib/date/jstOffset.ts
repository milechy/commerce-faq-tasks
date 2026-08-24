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
