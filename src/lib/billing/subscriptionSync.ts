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
  /** free_ad で、そもそも自動請求の対象外(倍率0で永久に$0)。サブスクも無い。 */
  | 'not_billable_plan'
  /** free_ad へ落ちたので、既存サブスクを期末解約に予約した。 */
  | 'scheduled_cancel'
  /** enterprise は個別交渉。サブスクの有無を問わず、人手での契約・組み直しが要る。 */
  | 'manual_plan'
  /** 有料プランなのにアクティブなサブスクが無い。テナントを決済登録へ誘導する。 */
  | 'no_subscription'
  /** price の環境変数が未設定。デプロイ順序の事故。 */
  | 'price_not_configured'
  /** STRIPE_SECRET_KEY が無い(ローカル・CI)。 */
  | 'stripe_not_configured'
  /** Stripe 呼び出しが失敗した。プラン自体は既に変更済みである点に注意。 */
  | 'failed'
  /**
   * 同期の実行中に、別の(より新しい)プラン変更が既にCOMMIT済みだったため
   * この同期を見送った。その新しい変更自身の同期呼び出しが正しいplanで
   * 追随するため、これはエラーではない(needsBillingAttentionには含めない)。
   */
  | 'superseded';

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
const ATTENTION_STATUSES: ReadonlySet<SubscriptionSyncStatus> = new Set([
  'no_subscription',
  'price_not_configured',
  'stripe_not_configured',
  'failed',
  'manual_plan',
]);

export function needsBillingAttention(result: SubscriptionSyncResult): boolean {
  return ATTENTION_STATUSES.has(result.status);
}

/**
 * tenants.billing_sync_status に永続化された文字列に対する同じ判定(2026-08-26 レビュー是正)。
 * billingApi.ts の fetchBillingInvoices がリロード後の「支払い設定が未完了」表示を
 * 復元するために使う。needsBillingAttention と判定基準を分けると、片方だけ直した
 * ときにドリフトする(禁止6と同種の理由でロジックを1箇所にする)。
 */
export function billingSyncStatusNeedsAttention(status: string | null): boolean {
  return status !== null && ATTENTION_STATUSES.has(status as SubscriptionSyncStatus);
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
  // ★停止中(is_active=false)テナントは何のplanであろうと期末解約を予約する★
  // (2026-08-26 レビュー是正)。PUT /v1/admin/my-tenant/plan は停止中テナントの
  // プラン変更自体を403で塞いでいるため常に true で呼ばれるが、super_admin の
  // PATCH /v1/admin/tenants/:id は「停止(is_active:false) + 昇格(plan)」を
  // 同一リクエストで送れる。この判定を欠くと、テナントは使えないのに
  // Stripe側だけ基本料 item が追加され課金が始まる(=停止しても課金は止まらず、
  // 停止中に昇格すると課金だけ始まる、の両方の事故を1箇所で防ぐ)。
  isActive: boolean = true,
): Promise<SubscriptionSyncResult> {
  const subRow = await db.query(
    `SELECT stripe_subscription_id FROM stripe_subscriptions
      WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId],
  );
  const subscriptionId: string | undefined = subRow.rows[0]?.stripe_subscription_id;

  if (!isActive) {
    if (!subscriptionId) return { status: 'not_billable_plan' };
    try {
      // free_ad降格と同じ理由で即時解約ではなく期末解約にする(当期報告済みの
      // 従量分を取りこぼさない)。
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      logger.info(
        { tenantId, subscriptionId },
        '[subscriptionSync] テナントが停止中のため期末解約を予約した',
      );
      return { status: 'scheduled_cancel' };
    } catch (err) {
      logger.error({ err, tenantId, subscriptionId }, '[subscriptionSync] 停止中テナントの期末解約予約に失敗した');
      return { status: 'failed', message: String((err as Error)?.message ?? err) };
    }
  }

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
    // ★subscription の有無にかかわらず manual_plan(要対応)★
    // not_billable_plan は「請求が発生しないので何もしなくてよい」を意味し free_ad
    // 専用の値(倍率0で永久に$0)。enterprise は個別契約なので、subscription が
    // 無いのは「未契約のまま権能だけ開いている」状態そのもの — free_ad と違って
    // 放置してよい状態ではない。ここを not_billable_plan にすると、セルフサービスで
    // starter/growth から enterprise へ自己申告した瞬間に voice_clone / deep_research /
    // sai_task が開通するのに、誰にも「営業が要る」と鳴らないまま黙って進む
    // (このファイル自体の目的=「押せるが金は動かない」を防ぐ、と正面から矛盾する)。
    logger.warn(
      { tenantId, subscriptionId },
      subscriptionId
        ? '[subscriptionSync] enterprise は個別契約のため item を自動変更しない — ' +
          'Stripe ダッシュボードで契約内容に合わせて組み直すこと'
        : '[subscriptionSync] enterprise へ変更されたが Stripe 契約が存在しない — ' +
          '個別契約の締結(または Stripe ダッシュボードでの手動セットアップ)が必要',
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
 *
 * ★同一テナントへの並行プラン変更を advisory lock で直列化する(2026-08-26 レビュー是正)★
 * 呼び出し元(routes.ts)は SELECT ... FOR UPDATE の行ロックを COMMIT 後に解放してから
 * この関数を呼ぶため、Stripe への read-modify-write(subscriptions.retrieve → update)は
 * 排他区間の外で実行される。2つのプラン変更リクエストがほぼ同時に来ると、両方が
 * 「変更前の item 構成」を見て自分の分の price を追加し、基本料 item が2本(旧・新の両プラン分)
 * 同時に付いて二重請求になる(実際に再現可能なシナリオとして確認済み)。
 * advisory lock でこの関数の実行そのものを直列化し、ロック獲得後に tenants.plan を
 * 再読込して自分が呼ばれた時点の plan と一致するかを確認する。不一致なら「自分より新しい
 * プラン変更が既に COMMIT 済み」ということなので、古い状態で同期して二重に item を
 * 付けないよう同期を諦める(その新しい変更リクエスト自身の syncSubscriptionForTenant 呼び出しが、
 * 自分の COMMIT 直後に正しい plan で同期するため、結果的に最新の plan だけが同期される)。
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

    const client = await db.connect();
    try {
      // pg_advisory_lock はセッション(=このコネクション)単位。lock/unlock を
      // 同一クライアントで行わないと、プールが別コネクションへ振り分けたときに
      // 解放されず全体を巻き込んで詰まる。
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`billing_sync:${tenantId}`]);
      try {
        // is_active もここで読み直す(呼び出し元から引数で受け取らない)。ロック獲得後の
        // DBの値が唯一の真実で、呼び出し元が保持する古いスナップショットより信頼できる。
        const current = await client.query('SELECT plan, is_active FROM tenants WHERE id = $1', [tenantId]);
        const currentPlan: string | null = current.rows[0]?.plan ?? null;
        const currentIsActive: boolean = current.rows[0]?.is_active ?? true;
        if (currentPlan !== plan) {
          logger.warn(
            { tenantId, requestedPlan: plan, currentPlan },
            '[subscriptionSync] ロック獲得時点で別の変更によりplanが更新済みのため、この同期は見送る(後続の変更が正しい状態に揃える)',
          );
          return { status: 'superseded' };
        }
        const result = await syncSubscriptionItemsToPlan(client, stripe, logger, tenantId, plan, billingCycle, currentIsActive);

        // ★直近の同期結果をtenantsへ焼き付ける(2026-08-26 レビュー是正)★
        // 従来はレスポンスにしか載せておらず、PlanSection.tsxのコンポーネントstateが
        // 消えるリロードのたびに「支払い設定が未完了」の警告が跡形もなく消えていた。
        // billingApi.ts の fetchBillingInvoices がこれを読み直し、リロード後も
        // billingSyncStatusNeedsAttention() で同じ判定を復元する。
        // migration_billing_sync_status.sql 未適用環境でも42703をfail-openし、
        // 同期処理自体(=この関数の戻り値)は正常に完了させる。
        try {
          await client.query(
            `UPDATE tenants SET billing_sync_status = $1, billing_sync_at = NOW() WHERE id = $2`,
            [result.status, tenantId],
          );
        } catch (err) {
          logger.warn({ err, tenantId }, '[subscriptionSync] billing_sync_status の永続化に失敗した(migration未適用の可能性)');
        }

        return result;
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`billing_sync:${tenantId}`]);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err, tenantId, plan }, '[subscriptionSync] 同期処理が例外で落ちた');
    return { status: 'failed', message: String((err as Error)?.message ?? err) };
  }
}
