// src/lib/billing/suspensionGate.ts
// fix/unpaid-suspension [P0]: 未払・退会テナントの提供停止/劣化ゲート。
//
// ★背景(この機能が無かったときの穴)★
// invoice.payment_failed は Slack 通知と usage_logs.billing_status='failed' の記録
// だけで、chat/avatar は止まらなかった。customer.subscription.deleted も
// stripe_subscriptions.is_active=false にするだけで、テナントの chat/avatar は
// 継続していた(= 支払いが止まっても原価だけ出続ける)。ここはその停止判定を
// 既存の plan ゲート機構(planFeatures.ts の queryTenantPlan と同じ「DBから引いて
// 判定する」流儀)に沿って一元化する。
//
// ★段階を設ける(急停止で正当テナントを巻き込まない)★
//   active     … 健全。従来どおり全提供。
//   grace      … past_due だが猶予期間内。まだ全提供する(Stripe が自動リトライ中)。
//   restricted … past_due が猶予を超過。有料機能(avatar/voice)を止め、テキストchatは
//                free_ad 相当(月次上限)へ降格して継続する。
//   suspended  … unpaid / canceled / subscription削除。原価が出る経路を全停止する。
//
// ★fail-safe の向きは経路ごとに変える(PR本文に明記)★
// queryTenantPlan の fail-safe は「最も制限が強い free_ad へ倒す」= 機能を開かない向き。
// ここでも「判定材料が無い/壊れている」ときの向きを決めるが、
//   - テキストchat(安価・最高トラフィック): 判定不能(DB例外)は allow へ倒す。
//     billing系の一時障害で全テナントのchatが止まる実害の方が、延滞テナントを
//     数秒余分に通す原価より大きい(既存 isFreeAdQuotaExceededForTenant の fail-open と整合)。
//   - avatar/voice(高原価・低頻度): 判定不能は block へ倒す(原価保護)。
// この非対称は resolver ではなく呼び出し側の述語(blocksPaidFeature / blocksTextChat)で
// 表現し、resolver 自体は純粋関数に保つ。

import type { Pool } from "pg";

export type BillingAccess = "active" | "grace" | "restricted" | "suspended";

/**
 * past_due の猶予日数。delinquent_since からこの日数を超えると restricted へ移る。
 * env 未設定・不正値は 7 日。0 以上の整数のみ受け付ける(負値・NaN は既定へ)。
 */
export function getPastDueGraceDays(): number {
  const raw = process.env.BILLING_PAST_DUE_GRACE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_GRACE_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GRACE_DAYS;
  return Math.floor(n);
}
const DEFAULT_GRACE_DAYS = 7;

// Stripe subscription.status のうち「即・停止」に倒すもの。
//   unpaid            … dunning を撃ち尽くした未回収。
//   canceled          … 解約済み。
//   incomplete_expired… 初回決済が期限切れで確定失敗(サブスクは成立しなかった)。
//   paused            … 一時停止(提供を続ける理由が無い)。
const SUSPENDED_STATUSES: ReadonlySet<string> = new Set([
  "unpaid",
  "canceled",
  "incomplete_expired",
  "paused",
]);

// 停止対象になり得る「有料・セルフサービス」プラン。free_ad は止める subscription が
// そもそも無い(広告原資・原価はR2C負担が前提)。enterprise は個別契約でStripeの
// セルフサービス状態と一致しないため、ここでは自動停止の対象にしない(手動運用)。
const SELF_SERVE_PAID_PLANS: ReadonlySet<string> = new Set(["starter", "standard", "growth"]);

export interface BillingStateRow {
  /** tenants.plan。 */
  plan: string | null | undefined;
  /** tenants.subscription_status(webhook が焼き付けた Stripe の生 status)。 */
  subscriptionStatus: string | null | undefined;
  /** stripe_subscriptions.is_active(subscription.deleted で false)。行が無ければ null。 */
  subActive: boolean | null | undefined;
  /** tenants.delinquent_since(past_due 起点)。 */
  delinquentSince: Date | string | null | undefined;
}

/**
 * テナントの課金アクセス段を算出する純粋関数(DBに触れない・時刻を注入できる)。
 *
 * ★free_ad / enterprise / 未知プランは常に active★
 * free_ad は止める対象が無い。enterprise は個別契約でStripeのセルフサービス状態と
 * 一致しないため自動停止しない。未知(null含む)も自動停止しない(既存テナントを
 * 巻き込まないため。tenants.subscription_status=NULL の全既存テナントもここを通る)。
 *
 * ★NULL の subscription_status は「延滞なし」★
 * 本機能の migration 適用前から居るテナントは全員 subscription_status=NULL になる。
 * NULL を延滞扱いにすると全顧客が一斉停止するので、明示的に active を返す。
 */
export function resolveBillingAccess(
  row: BillingStateRow,
  now: Date = new Date(),
  graceDays: number = getPastDueGraceDays(),
): BillingAccess {
  const plan = row.plan ?? undefined;
  if (!plan || !SELF_SERVE_PAID_PLANS.has(plan)) {
    // free_ad / enterprise / 未知/null は自動停止の対象外。
    return "active";
  }

  const status = row.subscriptionStatus ?? undefined;

  // subscription.deleted は stripe_subscriptions.is_active=false を立てるが
  // subscription_status を必ずしも 'canceled' にできるとは限らない(旧イベント順序・
  // migration 未適用時など)。有料プランで subscription が明示的に非アクティブなら停止。
  // subActive===null(=stripe_subscriptions に行が無い)は「未契約/決済未設定」であり、
  // これは needsBillingAttention(支払い設定が未完了)の警告で扱う正常導線なので停止しない。
  if (row.subActive === false) return "suspended";

  if (status && SUSPENDED_STATUSES.has(status)) return "suspended";

  if (status === "past_due") {
    const since = toDate(row.delinquentSince);
    if (since === null) {
      // past_due なのに起点が無い(異常だが防御的に)。猶予の開始直後として grace 扱い。
      return "grace";
    }
    const graceMs = graceDays * 24 * 60 * 60 * 1000;
    return now.getTime() - since.getTime() > graceMs ? "restricted" : "grace";
  }

  // active / trialing / incomplete / null など → 提供継続。
  return "active";
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * DB からテナントの課金状態を引いてアクセス段を返す。
 *
 * - 42703(subscription_status / delinquent_since 未適用)は fail-open で 'active' を返す。
 *   migration 適用前にコードが先行デプロイされてもゲートを無効化するだけで本番を壊さない。
 * - それ以外のDB例外は null を返し、fail-safe の向きは呼び出し側の述語に委ねる
 *   (テキストchatは allow、avatar/voiceは block)。
 */
export async function queryBillingAccess(
  pool: Pick<Pool, "query">,
  tenantId: string,
  now: Date = new Date(),
): Promise<BillingAccess | null> {
  try {
    const result = await pool.query<{
      plan: string | null;
      subscription_status: string | null;
      delinquent_since: Date | string | null;
      sub_active: boolean | null;
    }>(
      `SELECT t.plan,
              t.subscription_status,
              t.delinquent_since,
              s.is_active AS sub_active
         FROM tenants t
         LEFT JOIN stripe_subscriptions s ON s.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    const r = result.rows[0];
    if (!r) return "active"; // テナント不在は他層で弾く。ここでは停止しない。
    return resolveBillingAccess(
      {
        plan: r.plan,
        subscriptionStatus: r.subscription_status,
        subActive: r.sub_active,
        delinquentSince: r.delinquent_since,
      },
      now,
    );
  } catch (err: any) {
    // 42703 = 列未存在(migration未適用)。ゲートを無効化して従来動作を保つ。
    if (err?.code === "42703") return "active";
    return null;
  }
}

/**
 * 有料機能(avatar / voice など従量原価が出る経路)を課金状態でブロックすべきか。
 * restricted(猶予超過で降格)・suspended(未払/退会)の両方で止める。
 * access===null(判定不能)は原価保護のため block(fail-closed)。
 */
export function blocksPaidFeature(access: BillingAccess | null): boolean {
  if (access === null) return true;
  return access === "restricted" || access === "suspended";
}

/**
 * テキストchat(安価・最高トラフィック)を課金状態で全停止すべきか。
 * suspended(未払/退会)でのみ全停止する。restricted は「停止」ではなく
 * free_ad 相当への降格(shouldDegradeToFreeAdCap)で扱う。
 * access===null(判定不能)は可用性優先で allow(fail-open)。
 */
export function blocksTextChat(access: BillingAccess | null): boolean {
  return access === "suspended";
}

/**
 * テキストchat を free_ad 相当(月次上限)へ降格すべきか。
 * restricted のときのみ true(有料プランでも free_ad の会話上限を適用して原価を抑える)。
 */
export function shouldDegradeToFreeAdCap(access: BillingAccess | null): boolean {
  return access === "restricted";
}
