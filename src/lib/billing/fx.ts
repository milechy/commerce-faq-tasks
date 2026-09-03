/**
 * USD → JPY の換算レート。このファイルがリポジトリ内で唯一の換算の出どころ。
 *
 * ■ なぜ新設したか
 * `.claude/rules/billing.md` は「リポジトリに USD→JPY の換算処理は存在しない」と
 * 書いていたが、実際には analyticsSummaryRoutes.ts に `estimatedCostUsd * 150` が
 * 1箇所だけ存在した（2026-09-04 の粗利分析の設計時に発見）。
 * 粗利（売上は JPY、原価は USD セント）を出すには換算が要るため、2本目のレートを
 * 作る前に既存の1箇所ごとここへ集約する。
 *
 * ■ 既定値を 150 にしている理由
 * 既存の唯一の換算箇所と同じ値。ここを変えると同じ画面群で違う円が出るため、
 * 移行時点では意図的に据え置く（レートの見直しは別課題）。
 *
 * ■ この値の性質（レポート側で必ず開示すること）
 * 固定レートによる概算であり、実際の為替でも Stripe の約定レートでもない。
 * レート履歴を持たないので、この値を変更すると【過去月の粗利も後から変わる】。
 * 月次で確定させたい場合はスナップショットを別途持つ必要がある（未実装）。
 * そのため換算値を返す API は必ず fxMeta() を併記し、フィールド名も
 * `*_jpy_converted` のように「換算した円」であることを名前に出す。
 */

/**
 * USD/JPY レート。env `USD_JPY_RATE` で上書き可能、既定 150。
 *
 * `Number(...) || 150` は NaN と 0 の両方を既定へ倒す。0 を許すと原価が
 * 全額 0 円になり「原価ゼロで粗利＝売上」という嘘の数字が出るため、
 * 0 は設定ミスとして扱う。
 */
export const USD_JPY_RATE = Number(process.env.USD_JPY_RATE ?? '150') || 150;

/**
 * USD → JPY（整数）。
 *
 * ★ここを通さずに円へ換算しないこと★ — レートが2本になると、同じ原価が
 * 画面によって違う円で出る。
 *
 * @param usd USD（セントではない）
 * @returns 円（整数）。usd が有限数でなければ null（0 を返さない — 禁止20）
 */
export function usdToJpy(usd: number | null | undefined): number | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  return Math.round(usd * USD_JPY_RATE);
}

/**
 * USD セント → JPY（整数）。
 *
 * @param cents USD セント（usage_logs.cost_base_cents / cost_total_cents の単位）
 * @returns 円（整数）。cents が有限数でなければ null（0 を返さない — 禁止20）
 */
export function usdCentsToJpy(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
  return usdToJpy(cents / 100);
}

/** 換算に使ったレートとその出どころ。換算値を返す API は必ずこれを併記する。 */
export function fxMeta(): { usd_jpy: number; source: 'env:USD_JPY_RATE' | 'default'; basis: 'fixed_rate_estimate' } {
  return {
    usd_jpy: USD_JPY_RATE,
    source: process.env.USD_JPY_RATE ? 'env:USD_JPY_RATE' : 'default',
    // 固定レートによる概算であることを、呼び出し元が構造的に扱えるようにする
    // （文言だけに頼ると画面側で落ちる）。
    basis: 'fixed_rate_estimate',
  };
}
