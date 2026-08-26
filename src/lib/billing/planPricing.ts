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

// ---------------------------------------------------------------------------
// プラン → Stripe subscription item の price 構成(単一の出どころ)。
//
// billingApi.ts(オンボーディングで items を作る側)と stripeSync.ts(使用量を
// 「どの item へ」送るかを決める側)の両方がここを通す。プラン→price の対応を
// 2ファイルに書き写すと、片方だけ直したときに「作った item と送り先の item が
// 食い違う」= 請求が別の単価で計上される事故になる(CLAUDE.md 禁止6)。
//
// ★倍率(PLAN_MULTIPLIERS)は price 側に織り込まれている★
// テキスト超過は Starter ¥20 / Standard ¥25 / Growth ¥30 の**別々の price** として
// 実在する。旧来の STRIPE_METERED_PRICE_ID は全プラン共通の単一 price だったため
// 数量側に倍率を掛ける必要があったが、プランごとに price を分けた時点でその役目は
// price へ移った。ここを使う経路で数量に倍率を掛けると二重適用になる
// (planQuota.ts の computeQuotaOverage のコメント参照)。
//
// ★年払いの interval 制約(要・本番確認)★
// Stripe は1つの subscription に interval の異なる price を混在できない。
// 基本料の年払い price(interval=year)と、超過従量 price(metered)の interval が
// 食い違っていると subscriptions.create がそのまま失敗する。超過 price 側を
// 年 interval で作ってあるかは、テストモードで1度通して確認すること
// (このコードからは検証できない。PR 本文の未確認事項に記載)。
// ---------------------------------------------------------------------------

/** 基本料の請求周期。込み枠を持つプラン(standard/growth)でのみ意味を持つ。 */
export type BillingCycle = 'monthly' | 'annual';

/**
 * 1テナント分の subscription item 構成。
 *
 * 配列ではなく次元ごとの名前付きフィールドにしているのは、stripeSync.ts が
 * 「テキスト超過の数量をどの item へ送るか」を**配列の位置で推測せずに**
 * 引けるようにするため。位置依存にすると、items の並び順を変えた瞬間に
 * アバターの分数がテキストの単価で請求される。
 */
export interface SubscriptionItemPrices {
  /** 基本料(定額・metered ではない)。純従量プランには存在しない。 */
  base?: string;
  /** テキスト従量。純従量プランでは1単位目から、込み枠プランでは超過分に適用される。 */
  text?: string;
  /** アバター超過(分単位)。込み枠プランにのみ存在する。 */
  avatarOverage?: string;
}

export type SubscriptionItemPricesResult =
  | { ok: true; prices: SubscriptionItemPrices }
  /** 自動オンボーディングの対象外のプラン(free_ad / enterprise)。 */
  | { ok: false; reason: 'plan_not_self_serve' }
  /** 年払いを持たないプランに annual を要求された。 */
  | { ok: false; reason: 'billing_cycle_not_supported' }
  /** 必要な price の環境変数が未設定(デプロイ順序の事故)。missing に変数名が入る。 */
  | { ok: false; reason: 'price_not_configured'; missing: string[] };

/**
 * 自動でStripeサブスクリプションを作ってよいプランか。
 *
 * free_ad は倍率0で請求が発生しない(有料サブスクを作る意味が無い)。
 * enterprise は個別交渉のため Stripe ダッシュボードで人が組む
 * (自動化すると交渉内容と食い違ったまま請求が走る)。
 * null / 未知のプランは planMultiplier と同じ fail-safe で starter 扱いにする —
 * 「請求できない」より「純従量で請求する」方が請求漏れを避けられる。
 */
export function isSelfServeBillablePlan(plan: string | null | undefined): boolean {
  return plan !== 'free_ad' && plan !== 'enterprise';
}

/** 未知/null を starter へ倒したうえでの正規化プラン名(price 構成の判定用)。 */
function normalizeBillablePlan(plan: string | null | undefined): 'starter' | 'standard' | 'growth' {
  return plan === 'standard' || plan === 'growth' ? plan : 'starter';
}

/**
 * プランと請求周期から、作成すべき subscription item の price ID を引く。
 *
 * - starter(および未知/null): テキスト従量 1本のみ。基本料も込み枠も無い。
 *   STRIPE_PRICE_STARTER_TEXT(¥20/会話)を使い、未設定なら旧 STRIPE_METERED_PRICE_ID
 *   へフォールバックする(env の配布がコードのデプロイに間に合わない場合でも
 *   オンボーディング導線自体は生かす。ただし旧 price は ¥10 のプレースホルダなので
 *   呼び出し側で警告を出すこと)。
 * - standard / growth: 基本料(monthly/annual) + テキスト超過 + アバター超過 の3本。
 */
export function getSubscriptionItemPrices(
  plan: string | null | undefined,
  billingCycle: BillingCycle = 'monthly',
): SubscriptionItemPricesResult {
  if (!isSelfServeBillablePlan(plan)) return { ok: false, reason: 'plan_not_self_serve' };

  const normalized = normalizeBillablePlan(plan);

  if (normalized === 'starter') {
    // 純従量プランに年払いは無い(基本料が存在しないため請求周期が定義できない)。
    // 黙って monthly として受けると「年払いで契約したつもり」との齟齬が残るため弾く。
    if (billingCycle === 'annual') return { ok: false, reason: 'billing_cycle_not_supported' };
    const text = process.env.STRIPE_PRICE_STARTER_TEXT || process.env.STRIPE_METERED_PRICE_ID;
    if (!text) {
      return { ok: false, reason: 'price_not_configured', missing: ['STRIPE_PRICE_STARTER_TEXT'] };
    }
    return { ok: true, prices: { text } };
  }

  // ★年払いは現状ブロックする(2026-08-26 実地確認)★
  // Stripe は「1 subscription 内の全 price が同じ recurring.interval であること」を
  // 要求する(flexible billing mode 未使用・pin済み apiVersion '2024-06-20' の場合)。
  // 年払い基本料(interval=year)と、テキスト/アバター超過price(interval=month、
  // 年次のvariantを作っていない)を同じsubscriptionに混在させると
  // `subscriptions.create` がinvalid_request_errorで即座に失敗する
  // (実際にStripe test-modeで再現確認済み: "All prices on a subscription must
  // have the same `recurring.interval`..."）。
  // 恒久対応は (a) flexible billing modeへ全社的にapiVersionを上げる
  // (billingApi.ts/stripeSync.ts/stripeWebhook.ts全ての契約に影響するため単独PRでやらない)
  // か (b) 年払い基本料を`_chargeMonthlyFixedShare`と同じ単発invoiceItems.createで
  // 請求し、subscription自体は超過分(month interval)だけで構成する、のいずれか。
  // どちらも本PRのスコープ外。実装するまでは明示的に拒否し、
  // 「年払いを選んだのに月払いで契約された」という黙った齟齬を防ぐ。
  if (billingCycle === 'annual') return { ok: false, reason: 'billing_cycle_not_supported' };

  const prefix = normalized === 'standard' ? 'STRIPE_PRICE_STANDARD' : 'STRIPE_PRICE_GROWTH';
  const baseVar = `${prefix}_BASE_MONTHLY`;
  const textVar = `${prefix}_TEXT_OVERAGE`;
  const avatarVar = `${prefix}_AVATAR_OVERAGE`;

  const base = process.env[baseVar];
  const text = process.env[textVar];
  const avatarOverage = process.env[avatarVar];

  // 一部だけ設定されている状態で作ると、欠けた次元が「請求されないまま気づかれない」
  // (禁止50 と同型: 壊れているときに何も言わない)。3本揃わなければ作らない。
  const missing = [
    [baseVar, base] as const,
    [textVar, text] as const,
    [avatarVar, avatarOverage] as const,
  ].filter(([, v]) => !v).map(([name]) => name);
  if (missing.length > 0) return { ok: false, reason: 'price_not_configured', missing };

  return { ok: true, prices: { base, text, avatarOverage } };
}

/** SubscriptionItemPrices を Stripe subscriptions.create の items 配列へ落とす。 */
export function toSubscriptionItems(prices: SubscriptionItemPrices): Array<{ price: string }> {
  return [prices.base, prices.text, prices.avatarOverage]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((price) => ({ price }));
}
