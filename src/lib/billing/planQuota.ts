// src/lib/billing/planQuota.ts
// free_ad プランの月次上限判定。
//
// なぜ分離したか: 月次境界の計算は CLAUDE.md 絶対にやってはいけないこと16
// 「AT TIME ZONE を片側だけ書く」の典型的な事故箇所（本番でのみズレ、数値は
// もっともらしく出るため気づけない）。src/lib/date/weekRange.ts の getWeekRange と
// 同じ理由・同じ手法（process TZ に一切依存しない UTC 算術）でテスト容易性のため
// 純粋関数として切り出す。呼び出し元は src/api/chat/route.ts（createChatHandler）で、
// このファイル自体は DB に触れない。
//
// 単位は「usage_logs の行数(= /api/chat 1回のリクエスト)」。Asana 1217759064329998
// item(7)の指示どおり既存 usage_logs の集計から出し、新しいDB列・新しい集計対象
// (chat_sessions の distinct 数など)を作らない。1会話あたり平均5ターンという
// costCalculator.ts の原価モデル（1会話(5ターン)約0.55円）を踏まえると、上限200は
// 「約200会話分のリクエスト」を安全側(実際の会話数換算では下回る方向)に見積もった
// 値になる——1セッションが200ターンを超える極端な単一会話がある場合、その月の
// 残り新規会話が止まる可能性はあるが、原価上限(月あたり最大 200 × 約0.11円
// ≈ 22円/テナント)を超えることはなく、R2C負担としては安全側に倒れている。
export const FREE_AD_MONTHLY_REQUEST_LIMIT = 200;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface MonthRangeJst {
  /** 当月の開始（1日 00:00:00 JST）をUTC Dateで表したもの */
  monthStart: Date;
  /** 翌月の開始（= 当月の終端、比較は半開区間 [monthStart, monthEnd) で行う） */
  monthEnd: Date;
}

/**
 * now が属する JST 暦月の範囲を返す。
 *
 * weekRange.ts の getWeekRange と同じ手法: now を +9h シフトしてから UTC ゲッター
 * (getUTCFullYear / getUTCMonth) で読むと process TZ に依存せず JST の壁時計表現の
 * 年月が得られる。月初日を Date.UTC で作ってから -9h 戻すことで、SQL 側の
 * `created_at >= $1 AND created_at < $2`（timestamptz 列との比較）にそのまま渡せる
 * UTC Date を返す。SQL 側で `AT TIME ZONE` を書く必要はない。
 */
export function getMonthRangeJst(now: Date): MonthRangeJst {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  const shiftedMonthStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  );
  const shiftedNextMonthStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    1,
    0,
    0,
    0,
    0,
  );

  return {
    monthStart: new Date(shiftedMonthStart - JST_OFFSET_MS),
    monthEnd: new Date(shiftedNextMonthStart - JST_OFFSET_MS),
  };
}

/**
 * 当月の既存リクエスト数（このリクエストを記録する「前」の usage_logs 件数）が
 * 上限に達しているかを判定する。
 *
 * @throws currentMonthRequestCount / limit が負の場合
 */
export function isFreeAdMonthlyQuotaExceeded(
  currentMonthRequestCount: number,
  limit: number = FREE_AD_MONTHLY_REQUEST_LIMIT,
): boolean {
  if (currentMonthRequestCount < 0) {
    throw new Error(`Invalid currentMonthRequestCount: ${currentMonthRequestCount}`);
  }
  if (limit < 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }
  return currentMonthRequestCount >= limit;
}
