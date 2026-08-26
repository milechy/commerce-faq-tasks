// src/lib/billing/planPricing.ts
// プラン倍率（Stripe 請求数量に乗じる係数）の単一の出どころ。
//
// なぜ stripeSync.ts から切り出したか:
// 倍率は「請求バッチが読む値」から「利用記録時に焼き付ける値」へ役割が変わり、
// usageTracker.ts（最高トラフィックの書き込み経路）からも参照する必要が出た。
// 利用記録が Stripe 連携バッチのモジュールに依存するのは筋が悪いため、
// 純粋な値と純粋関数だけをここに置く（planQuota.ts と同じ方針）。
// stripeSync.ts は後方互換のため引き続き re-export する。
//
// ★fail-safe の向きに注意★
// このファイルの fail-safe は「請求漏れを避ける」方向（未知 → starter 1.0）であり、
// planFeatures.ts の機能ゲート用 fail-safe「最も制限の強い free_ad」とは
// 意図的に逆向きである。取り違えると、
//   - 機能ゲート側に寄せる → DB障害時に請求が 0 になる（売上が静かに消える）
//   - 請求側に寄せる      → DB障害時にプラン外機能が開く（権能の漏れ）
// のどちらかが起きる。両者を1つの関数に統合しないこと。

/**
 * プラン倍率: Stripe に報告する数量に乗じる（リクエスト課金 × プラン別単価）。
 * admin-ui PLAN_OPTIONS と一致
 * （Free(広告表示) ×0 / Starter ×1.0 / Standard ×1.25 / Growth ×1.5 / Enterprise ×2.5）。
 * free_ad の 0 は原価をR2Cが負担する広告原資プランであることを表す。
 *
 * ★これは「テキスト」の倍率であって、アバターの分単価には使えない★
 * 確定価格（.claude/rules/billing.md §7）ではテキスト超過が
 * ¥20 →（×1.25）¥25 →（×1.5）¥30 と倍率どおりに整合する一方、
 * アバターの超過は Standard ¥100/分 → Growth ¥80/分 と**逆向きに下がる**
 * （上位プランほど分単価を下げるアップセル誘因。CLAUDE.md 禁止56）。
 * したがってアバターの分単価をここの倍率から算出すると、必ず向きが反転する。
 * 分単価はプランごとの定数として別に持つこと（本PRのスコープ外。
 * 課金計算の書き換えは computeExpectedBilling 側の別PRが担当する）。
 */
export const PLAN_MULTIPLIERS: Record<string, number> = {
  free_ad: 0,
  starter: 1.0,
  standard: 1.25,
  growth: 1.5,
  enterprise: 2.5,
};

/**
 * プラン名から倍率を引く。
 *
 * `?? 'starter'` は null/undefined のみを捕捉するため 0 はそのまま通る
 * （free_ad の 0 が満額請求 1.0 にすり替わらない）。末尾の `?? 1.0` は
 * 未知の文字列に対する請求漏れ回避のフォールバック。
 */
export function planMultiplier(plan: string | null | undefined): number {
  const key = plan ?? 'starter';
  // 素の [key] だと Object.prototype 由来のキー('constructor' 等)で
  // 関数が返り、`?? 1.0`(null/undefined しか捕まえない)を素通りする。
  // tenants.plan の CHECK 制約が未適用の環境では任意の文字列が入りうるため、
  // 自前プロパティに限定したうえで数値であることまで確認する。
  const value = Object.prototype.hasOwnProperty.call(PLAN_MULTIPLIERS, key)
    ? PLAN_MULTIPLIERS[key]
    : undefined;
  return typeof value === 'number' ? value : 1.0;
}
