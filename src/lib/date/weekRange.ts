/**
 * 「今週」の境界を計算する（暦週・月曜00:00 JST起点）。get_weekly_briefing が使う。
 *
 * SQL側へ AT TIME ZONE を直書きしない — JST(UTC+9固定・DSTなし)のオフセットを
 * UTC ベースの算術だけで適用するため、実行環境の process TZ には一切依存しない。
 * テスト容易性のため純粋関数として切り出してある(weekRange.test.ts参照)。
 *
 * (旧: weeklyReportGeneratorとの共有を理由に切り出していたが、同ジェネレータは
 *  #602で撤去済み。現在の唯一の利用箇所は actionExecutor.ts の get_weekly_briefing)
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface WeekRange {
  /** 今週の開始（月曜00:00 JST）をUTC Dateで表したもの */
  weekStart: Date;
  /** 先週の開始（今週開始のちょうど7日前 = 先週の月曜00:00 JST） */
  prevWeekStart: Date;
  /**
   * 先週の同一経過時間の終端（prevWeekStart + (now - weekStart)）。
   * 前週比の比較対象および「先週の確定値」の表示に使う。先週は既に終わっているため、
   * このスライスは「今週」のようにこれから増える途中の値ではなく確定している。
   */
  prevWeekEnd: Date;
}

export function getWeekRange(now: Date): WeekRange {
  // now を +9h シフトしてから UTC ゲッターで読むと、process TZ に依存せず JST の
  // 壁時計表現（年月日・曜日）が得られる。
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  const dayOfWeek = shifted.getUTCDay(); // 0=日,1=月,...,6=土
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  const shiftedMondayMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday,
    0,
    0,
    0,
    0,
  );

  const weekStart = new Date(shiftedMondayMidnight - JST_OFFSET_MS);
  const prevWeekStart = new Date(weekStart.getTime() - WEEK_MS);
  const elapsedMs = now.getTime() - weekStart.getTime();
  const prevWeekEnd = new Date(prevWeekStart.getTime() + elapsedMs);

  return { weekStart, prevWeekStart, prevWeekEnd };
}
