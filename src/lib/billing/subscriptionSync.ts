// src/lib/billing/subscriptionSync.ts
// プラン変更を Stripe の subscription item 構成へ追随させる、唯一の場所。
//
// ★なぜ必要か★
// #1015 で Standard/Growth を「基本料 + 込み枠 + 超過従量」にしたが、プランを変える
// 経路(PUT /v1/admin/my-tenant/plan と PATCH /v1/admin/tenants/:id)は tenants.plan を
// UPDATE するだけで Stripe を一切触っていなかった。結果:
//   - 基本料(¥9,800 / ¥29,800)の item がいつまでも作られず、月額が永久に請求されない
//   - 超過数量の送り先 item が無く、stripeSync.ts の _reportQuotaOverageUsage が
//     「subscription に該当次元の item が無い」と鳴らして、その次元は請求されない
// つまりプラン変更UIは「押せるが金は動かない」状態だった(CLAUDE.md 禁止44 の変種)。
//
// ★プラン→price の対応はここに書かない★
// planPricing.ts の getSubscriptionItemPrices が唯一の出どころで、items を作る
// billingApi.ts(オンボード)・数量を送る stripeSync.ts・構成を直すこのファイルの
// 3者が同じ関数を通る。ここに price ID を書き写すと「作った item と送り先が違う」
// = 別の単価で請求される事故になる(禁止6)。
//
// ★倍率も単価もこのファイルは持たない★
// 単価は Stripe の price が持ち、数量はコードが持つ、という分担
// (.claude/rules/billing.md §7 / 禁止56)。item の付け外ししかしない。
import { getSubscriptionItemPrices, toSubscriptionItems, type BillingCycle } from './planPricing';

interface MinimalLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

/**
 * 同期の結果。呼び出し元(HTTPルート)はこれをそのままレスポンスに載せ、
 * UI が「プランは変わったが支払い設定が未完了」を出せるようにする。
 *
 * ★成功を1種類にまとめない★
 * 「同期した」「元から正しい」「そもそも請求対象外」「サブスクが無い」は
 * 利用者に見せるべき文言が全部違う。ひとつの boolean に潰すと、
 * サブスク未登録(=お金が一切動かない)が「成功」に混ざって見えなくなる(禁止20)。
 */
export type SubscriptionSyncStatus =
  /** item 構成を変更した。 */
  | 'synced'
  /** 既に目標構成と一致していた(再送・連打)。 */
  | 'no_change'
  /** free_ad / enterprise で、そもそも自動請求の対象外。サブスクも無い。 */
  | 'not_billable_plan'
  /** free_ad へ落ちたので、既存サブスクを期末解約に予約した。 */
  | 'scheduled_cancel'
  /** enterprise は個別交渉。既存サブスクには触らず、人手での組み直しが要る。 */
  | 'manual_plan'
  /** 有料プランなのにアクティブなサブスクが無い。テナントを決済登録へ誘導する。 */
  | 'no_subscription'
  /** price の環境変数が未設定。デプロイ順序の事故。 */
  | 'price_not_configured'
  /** STRIPE_SECRET_KEY が無い(ローカル・CI)。 */
  | 'stripe_not_configured'
  /** Stripe 呼び出しが失敗した。プラン自体は既に変更済みである点に注意。 */
  | 'failed';

export interface SubscriptionSyncResult {
  status: SubscriptionSyncStatus;
  /** 追加した price ID(status='synced' のとき)。 */
  addedPrices?: string[];
  /** 削除した subscription item ID(status='synced' のとき)。 */
  removedItemIds?: string[];
  /** price_not_configured のときに欠けている環境変数名。 */
  missing?: string[];
  /** failed のときの原因(ログ・PRの調査用。UIには出さない)。 */
  message?: string;
}

/**
 * テナントの対応が要る = テナントに「支払い設定が未完了です」と出すべき状態か。
 *
 * 画面ごとに status の羅列を書かないための唯一の判定(禁止6)。
 * failed をここに含めるのは、原因が env でも Stripe 障害でも、
 * テナント側から見れば「請求が始まっていない」という同じ事実だから。
 */
export function needsBillingAttention(result: SubscriptionSyncResult): boolean {
  return (
    result.status === 'no_subscription' ||
    result.status === 'price_not_configured' ||
    result.status === 'stripe_not_configured' ||
    result.status === 'failed' ||
    result.status === 'manual_plan'
  );
}

function getStripeClient(): any {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return null;
  const Stripe = require('stripe');
  return new Stripe(secret, { apiVersion: '2024-06-20' });
}

/** price オブジェクトから usage_type を読む。展開されていない場合は null。 */
function usageTypeOf(price: unknown): string | null {
  if (typeof price !== 'object' || price === null) return null;
  const recurring = (price as { recurring?: { usage_type?: unknown } }).recurring;
  return typeof recurring?.usage_type === 'string' ? recurring.usage_type : null;
}

function priceIdOf(price: unknown): string | null {
  if (typeof price === 'string') return price;
  if (typeof price === 'object' && price !== null) {
    const id = (price as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * プラン変更後の subscription item 構成を Stripe 側へ反映する。
 *
 * @param stripe テスト時にモックを差し込めるよう引数で受ける(このファイルは
 *   Stripe クライアントの生成方法を知らなくてよい)。
 * @param billingCycle 基本料の請求周期。年払いは planPricing.ts が現状ブロックしている。
 */
export async function syncSubscriptionItemsToPlan(
  db: any,
  stripe: any,
  logger: MinimalLogger,
  tenantId: string,
  plan: string | null,
  billingCycle: BillingCycle = 'monthly',
): Promise<SubscriptionSyncResult> {
  const subRow = await db.query(
    `SELECT stripe_subscription_id FROM stripe_subscriptions
      WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId],
  );
  const subscriptionId: string | undefined = subRow.rows[0]?.stripe_subscription_id;

  // ── 自動請求の対象外プラン ───────────────────────────────────────────────
  // free_ad は倍率0で請求が発生しない。enterprise は個別交渉で人が Stripe 側を組む。
  // 「対象外だから何もしない」で終わらせると、有料プランから降りたテナントに
  // 基本料が請求され続ける(黙って課金し続けるのが最悪の失敗なので、ここは能動的に止める)。
  if (plan === 'free_ad') {
    if (!subscriptionId) return { status: 'not_billable_plan' };
    try {
      // 即時解約ではなく期末解約にする。当期に既に報告済みの従量分は請求されるべきで、
      // 即時に消すとその分の売上が黙って消える(過少請求は過大請求と同じくらい直しにくい)。
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      logger.info(
        { tenantId, subscriptionId },
        '[subscriptionSync] free_ad へ降格したため期末解約を予約した',
      );
      return { status: 'scheduled_cancel' };
    } catch (err) {
      logger.error({ err, tenantId, subscriptionId }, '[subscriptionSync] 期末解約の予約に失敗した');
      return { status: 'failed', message: String((err as Error)?.message ?? err) };
    }
  }

  if (plan === 'enterprise') {
    if (!subscriptionId) return { status: 'not_billable_plan' };
    // 個別交渉の内容(値引き・特別枠)を自動処理で踏み潰さない。人が直すべき状態として鳴らす。
    logger.warn(
      { tenantId, subscriptionId },
      '[subscriptionSync] enterprise は個別契約のため item を自動変更しない — ' +
        'Stripe ダッシュボードで契約内容に合わせて組み直すこと',
    );
    return { status: 'manual_plan' };
  }

  // ── 自動請求の対象プラン(starter / standard / growth) ──────────────────
  const priceResult = getSubscriptionItemPrices(plan, billingCycle);
  if (!priceResult.ok) {
    if (priceResult.reason === 'price_not_configured') {
      logger.error(
        { tenantId, plan, missing: priceResult.missing },
        '[subscriptionSync] price の環境変数が未設定 — item 構成を直せない',
      );
      return { status: 'price_not_configured', missing: priceResult.missing };
    }
    // plan_not_self_serve は上で処理済み、billing_cycle_not_supported は
    // 呼び出し元が monthly 固定で呼ぶ限り到達しない。到達したら設定の事故なので鳴らす。
    logger.error({ tenantId, plan, reason: priceResult.reason }, '[subscriptionSync] price を引けない');
    return { status: 'failed', message: priceResult.reason };
  }

  if (!subscriptionId) {
    // 有料プランなのに請求経路が無い = このままでは1円も請求されない。
    // 呼び出し元はこれをテナントへ「支払い設定が未完了」として見せる。
    logger.warn(
      { tenantId, plan },
      '[subscriptionSync] 有料プランだがアクティブな subscription が無い — 決済登録へ誘導すること',
    );
    return { status: 'no_subscription' };
  }

  const desiredPrices = toSubscriptionItems(priceResult.prices).map((i) => i.price);
  const desiredSet = new Set(desiredPrices);

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const currentItems: any[] = subscription.items?.data ?? [];

    const currentPriceIds = new Set<string>();
    for (const item of currentItems) {
      const id = priceIdOf(item.price);
      if (id) currentPriceIds.add(id);
    }

    const addedPrices = desiredPrices.filter((p) => !currentPriceIds.has(p));

    // ★従量(metered)の item は、目標構成に無くても消さない★
    // 当期に既に報告済みの数量はその item にぶら下がっている。metered item の削除は
    // clear_usage を伴い、当期の報告済み数量ごと消える = その分が請求されなくなる。
    // 残しても翌期以降は数量0で ¥0 の item になるだけで害が無いので、
    // 「消して売上を落とす」より「残して無害にする」を選ぶ。
    // 一方 licensed(基本料)は残すと Standard と Growth の両方が請求されるため必ず消す。
    const removedItemIds: string[] = [];
    const keptMeteredPriceIds: string[] = [];
    for (const item of currentItems) {
      const id = priceIdOf(item.price);
      if (!id || desiredSet.has(id)) continue;
      const usageType = usageTypeOf(item.price);
      if (usageType === 'metered') {
        keptMeteredPriceIds.push(id);
        continue;
      }
      // usage_type を読めない(price が展開されていない)場合も消さない。
      // 判断材料が無いまま消すと、当期の従量分を巻き添えにしうる。
      if (usageType === null) {
        logger.warn(
          { tenantId, subscriptionId, itemId: item.id, priceId: id },
          '[subscriptionSync] price の usage_type を判定できないため item を残した',
        );
        continue;
      }
      removedItemIds.push(item.id);
    }

    // 一度 free_ad へ落として戻ってきたテナントは cancel_at_period_end が立ったままで、
    // item を正しく組み直しても期末に解約される。有料プランへ戻る以上は必ず降ろす。
    const needsCancelReset = subscription.cancel_at_period_end === true;

    if (addedPrices.length === 0 && removedItemIds.length === 0 && !needsCancelReset) {
      logger.debug({ tenantId, plan }, '[subscriptionSync] item 構成は既に目標と一致している');
      return { status: 'no_change' };
    }

    const items = [
      ...addedPrices.map((price) => ({ price })),
      ...removedItemIds.map((id) => ({ id, deleted: true })),
    ];

    await stripe.subscriptions.update(subscriptionId, {
      ...(items.length > 0 ? { items } : {}),
      // 月中の基本料は日割りする(Stripe 既定)。込み枠は日割りしない方針
      // (.claude/rules/billing.md §7 / 2026-08-26 決定)なので、アップグレード月は
      // 「日割りの基本料で1か月分の枠」になる = テナント有利側に倒れる。
      // 意図した非対称なので、UI 側で「枠は日割りされません」と明示すること。
      proration_behavior: 'create_prorations',
      ...(needsCancelReset ? { cancel_at_period_end: false } : {}),
      metadata: { tenant_id: tenantId, plan: plan ?? '', billing_cycle: billingCycle },
    });

    // stripe_subscriptions.stripe_price_id は「そのテナントのプランを代表する price」。
    // billingApi.ts のオンボードと同じ規則(基本料、無ければテキスト従量)で更新する。
    const representativePriceId = priceResult.prices.base ?? priceResult.prices.text;
    if (representativePriceId) {
      await db.query(
        `UPDATE stripe_subscriptions SET stripe_price_id = $1, updated_at = NOW()
          WHERE tenant_id = $2`,
        [representativePriceId, tenantId],
      );
    }

    logger.info(
      { tenantId, plan, subscriptionId, addedPrices, removedItemIds, keptMeteredPriceIds },
      '[subscriptionSync] subscription item をプランに追随させた',
    );
    return { status: 'synced', addedPrices, removedItemIds };
  } catch (err) {
    logger.error(
      { err, tenantId, plan, subscriptionId },
      '[subscriptionSync] item 構成の更新に失敗した — プランは変更済みで請求だけが追随していない',
    );
    return { status: 'failed', message: String((err as Error)?.message ?? err) };
  }
}

/**
 * HTTP ルートから呼ぶための薄いラッパ。Stripe クライアントの用意と
 * 「そもそも Stripe が設定されていない環境(ローカル・CI)」の扱いだけを引き受ける。
 *
 * ★例外を投げない★
 * プラン変更は既に COMMIT 済みで、ここで throw すると 500 になり
 * 「変更に失敗した」と表示されてテナントが再送する(2回目は no-op)。
 * 失敗は必ず戻り値で表現し、呼び出し元がレスポンスに載せる。
 */
export async function syncSubscriptionForTenant(
  db: any,
  logger: MinimalLogger,
  tenantId: string,
  plan: string | null,
  billingCycle: BillingCycle = 'monthly',
): Promise<SubscriptionSyncResult> {
  try {
    const stripe = getStripeClient();
    if (!stripe) {
      logger.warn(
        { tenantId, plan },
        '[subscriptionSync] STRIPE_SECRET_KEY が未設定のため item 構成を同期できない',
      );
      return { status: 'stripe_not_configured' };
    }
    return await syncSubscriptionItemsToPlan(db, stripe, logger, tenantId, plan, billingCycle);
  } catch (err) {
    logger.error({ err, tenantId, plan }, '[subscriptionSync] 同期処理が例外で落ちた');
    return { status: 'failed', message: String((err as Error)?.message ?? err) };
  }
}
