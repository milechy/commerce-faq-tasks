// src/lib/billing/stripeSync.ts
// Phase32: Stripe Usage Record API連携（日次バッチ）

import type pino from 'pino';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 1000;

/** pino.Logger / AppLogger(lib/logger.ts)どちらでも渡せる最小限のロガー形状 */
interface MinimalLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

// プラン倍率の定義は planPricing.ts にある（usageTracker.ts が利用記録時に
// 焼き付けるため、Stripe連携モジュールへの依存を持たせたくない）。
// re-export は置かない。PLAN_MULTIPLIERS/planMultiplier が要る側は
// './planPricing' から直接importすること（二重の出どころを作らない）。
import { planMultiplier } from './planPricing';

/** 環境変数から LemonSlice 月額固定費(JPY)を取得。未設定/0 なら按分課金は無効。 */
export function getLemonsliceMonthlyFeeJpy(): number {
  return Number(process.env.LEMONSLICE_MONTHLY_FEE_JPY ?? '0') || 0;
}

/** 環境変数から LiveKit (Ship プラン) 月額固定費(JPY)を取得。未設定/0 なら按分課金は無効。 */
export function getLivekitMonthlyFeeJpy(): number {
  return Number(process.env.LIVEKIT_MONTHLY_FEE_JPY ?? '0') || 0;
}

/**
 * 環境変数からプラットフォーム共通の月額固定費(JPY)を取得。未設定/0 なら按分課金は無効。
 * Supabase / Cloudflare / Hetzner VPS / Elasticsearch 等、全テナントが共有するインフラ費の
 * 合計額を1本で設定する（費目別の内訳は持たない）。アバター専用費(LemonSlice/LiveKit)とは
 * 分母が異なり、全アクティブテナントで割る（scope='all'）。
 */
export function getPlatformMonthlyFeeJpy(): number {
  return Number(process.env.PLATFORM_MONTHLY_FEE_JPY ?? '0') || 0;
}

/** 月額固定費を当月アバター利用テナント数で均等割りした1テナント分(JPY、切り上げ)。 */
export function monthlyShareJpy(monthlyFeeJpy: number, tenantCount: number): number {
  if (monthlyFeeJpy <= 0 || tenantCount <= 0) return 0;
  return Math.ceil(monthlyFeeJpy / tenantCount);
}

/** @deprecated 後方互換のためのエイリアス。新規は monthlyShareJpy を使う。 */
export const lemonsliceShareJpy = monthlyShareJpy;

/**
 * 月額固定費を当月アクティブなテナント間で均等割りして Stripe 請求に上乗せする共通ロジック。
 * テナント単位・月1回・冪等。
 * - 無効化: 対象 feeJpy が未設定/0 のとき何もしない（デフォルト OFF）
 * - cfg.scope で分母（割り勘の対象集合）を切り替える:
 *   - 'avatar': アバター専用費（LemonSlice / LiveKit）。当月 feature_used='avatar' かつ
 *     billing_enabled=true のテナントで割る（仕様B）。アバターを使ったテナントだけが負担。
 *   - 'all': プラットフォーム共通費（Supabase/Cloudflare/Hetzner/ES）。当月に何らかの利用が
 *     あり billing_enabled=true のテナントで割る。アバター有無を問わず全アクティブテナントが負担。
 *
 * cfg.table は in-code 定数のみ（ユーザー入力を渡さない）— SQL に直挿しするため。
 */
async function _chargeMonthlyFixedShare(
  db: any,
  stripe: any,
  logger: pino.Logger,
  tenantId: string,
  periodYyyyMm: string,
  startDate: string,
  endDate: string,
  customerId: string | null,
  cfg: { feeJpy: number; table: string; label: string; idempotencyPrefix: string; scope: 'avatar' | 'all' }
): Promise<void> {
  const { feeJpy, table, label, idempotencyPrefix, scope } = cfg;
  if (feeJpy <= 0) return; // デフォルト OFF
  if (!customerId) {
    logger.warn({ tenantId, fee: label }, '[stripeSync] monthly fixed: no customerId, skipping');
    return;
  }

  // scope='avatar' はアバター利用のみを対象にする。'all' は機能を問わない（in-code 定数）。
  const featureFilter = scope === 'avatar' ? "AND feature_used = 'avatar'" : '';

  // このテナントが当月に対象の利用をしたか
  const used = await db.query(
    `SELECT 1 FROM usage_logs
      WHERE tenant_id = $1 ${featureFilter}
        AND created_at >= $2 AND created_at < $3 LIMIT 1`,
    [tenantId, startDate, endDate]
  );
  if (used.rows.length === 0) return;

  // 当月の課金対象テナント数（按分の分母）
  const cntRes = await db.query(
    `SELECT COUNT(DISTINCT u.tenant_id)::integer AS cnt
       FROM usage_logs u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.created_at >= $1 AND u.created_at < $2
        AND t.billing_enabled = true
        ${scope === 'avatar' ? "AND u.feature_used = 'avatar'" : ''}`,
    [startDate, endDate]
  );
  const tenantCount: number = Math.max(1, cntRes.rows[0]?.cnt ?? 1);
  const share = monthlyShareJpy(feeJpy, tenantCount);
  if (share <= 0) return;

  // 冪等: テナント×月で1回だけ。INSERT 成功時のみ Stripe 請求を作成する。
  const ins = await db.query(
    `INSERT INTO ${table} (tenant_id, period_yyyymm, amount_jpy, tenant_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, period_yyyymm) DO NOTHING
     RETURNING tenant_id`,
    [tenantId, periodYyyyMm, share, tenantCount]
  );
  if (ins.rows.length === 0) return; // 既に請求済み

  try {
    await stripe.invoiceItems.create(
      {
        customer:    customerId,
        amount:      share, // JPY は最小単位=1円
        currency:    'jpy',
        description: `${label} 月額按分 ${periodYyyyMm} (1/${tenantCount})`,
      },
      { idempotencyKey: `${idempotencyPrefix}:${tenantId}:${periodYyyyMm}` }
    );
    logger.info(
      { tenantId, periodYyyyMm, share, tenantCount, feeJpy, fee: label },
      '[stripeSync] monthly fixed share charged'
    );
  } catch (err) {
    // Stripe 失敗時は冪等レコードを取り消して次回再試行できるようにする
    await db.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND period_yyyymm = $2`,
      [tenantId, periodYyyyMm]
    );
    logger.error({ err, tenantId, periodYyyyMm, fee: label }, '[stripeSync] monthly fixed charge failed, rolled back');
  }
}

function getStripeClient(): any {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set');
  const Stripe = require('stripe');
  return new Stripe(secret, { apiVersion: '2024-06-20' });
}

/**
 * テナントに単発のJPY金額をStripe Invoice Itemとして直接請求する。
 * option_orders(代行作業)等、リクエスト数ベースの従量課金(reportUsageToStripe)には
 * そぐわない一時金の請求に使う。冪等(idempotencyKeyで重複防止)、billing_enabled/
 * 無料期間もreportUsageToStripeと同じ規則でチェックする。
 * @returns 請求できたら true。billing無効・customerId不明・Stripeエラー時は false。
 */
export async function chargeOneOffJpy(
  db: any,
  logger: MinimalLogger,
  opts: { tenantId: string; amountJpy: number; description: string; idempotencyKey: string },
): Promise<boolean> {
  const { tenantId, amountJpy, description, idempotencyKey } = opts;
  if (amountJpy <= 0) return false;

  try {
    const tenantRow = await db.query(
      `SELECT billing_enabled, billing_free_from, billing_free_until FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const tenant = tenantRow.rows[0];
    if (!tenant?.billing_enabled) {
      logger.info({ tenantId }, '[stripeSync] chargeOneOffJpy: billing not enabled, skipping');
      return false;
    }
    const now = new Date();
    const freeFrom  = tenant.billing_free_from  ? new Date(tenant.billing_free_from)  : null;
    const freeUntil = tenant.billing_free_until ? new Date(tenant.billing_free_until) : null;
    if (freeFrom && freeUntil && now >= freeFrom && now <= freeUntil) {
      logger.info({ tenantId }, '[stripeSync] chargeOneOffJpy: free period, skipping');
      return false;
    }

    const stripe = getStripeClient();
    const subInfo = await getSubscriptionItemId(db, tenantId, stripe, logger);
    if (!subInfo?.customerId) {
      logger.warn({ tenantId }, '[stripeSync] chargeOneOffJpy: no customerId, skipping');
      return false;
    }

    await stripe.invoiceItems.create(
      { customer: subInfo.customerId, amount: Math.round(amountJpy), currency: 'jpy', description },
      { idempotencyKey }
    );
    logger.info({ tenantId, amountJpy, description }, '[stripeSync] one-off charge created');
    return true;
  } catch (err) {
    logger.error({ err, tenantId, amountJpy, description }, '[stripeSync] one-off charge failed');
    return false;
  }
}

export function getPeriodYyyyMm(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

export function periodToDateRange(periodYyyyMm: string): { startDate: string; endDate: string } {
  const year  = Number(periodYyyyMm.slice(0, 4));
  const month = Number(periodYyyyMm.slice(4, 6));
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // 翌月1日 = 終了境界（排他）
  const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1);
  const endDate = nextMonth.toISOString().slice(0, 10);
  return { startDate, endDate };
}

/**
 * テナントのStripe SubscriptionItem IDを取得する。
 */
async function getSubscriptionItemId(
  db: any,
  tenantId: string,
  stripe: any,
  logger: MinimalLogger
): Promise<{ subscriptionId: string; itemId: string; customerId: string | null } | null> {
  const result = await db.query(
    `SELECT stripe_subscription_id
     FROM stripe_subscriptions
     WHERE tenant_id = $1 AND is_active = true
     LIMIT 1`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    logger.warn({ tenantId }, '[stripeSync] no active subscription found');
    return null;
  }

  const subscriptionId = result.rows[0].stripe_subscription_id as string;
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const item = (subscription.items?.data ?? [])[0];
    if (!item) {
      logger.warn({ tenantId, subscriptionId }, '[stripeSync] subscription has no items');
      return null;
    }
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer?.id ?? null);
    return { subscriptionId, itemId: item.id, customerId };
  } catch (err) {
    logger.error({ err, tenantId, subscriptionId }, '[stripeSync] failed to retrieve subscription');
    return null;
  }
}

/**
 * anam_session 1行分の請求数量（分単位、切り上げ）を返す。
 *
 * Anam.ai は $0.16/分の時間課金だが、Stripe報告数量は他機能と同じ「1行=1リクエスト」の
 * まま合算すると、3分セッション(原価 約$0.16×3)が「1リクエスト」分の単価でしか請求されず
 * 赤字になる（GID 1216944002701788）。anam_session行のみ秒→分に換算して数量に加算する。
 *
 * 切り上げ規則: 0秒は0（対象外）。1秒でも経過すれば1分として計上する
 * （例: 59秒→1分、60秒→1分、61秒→2分、180秒→3分）。負値は0を返す。
 */
export function anamSessionBillableUnits(sessionSeconds: number | null | undefined): number {
  const seconds = sessionSeconds ?? 0;
  if (seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
}

/**
 * 指定期間のテナント使用量を集計してStripeに報告する（冪等）。
 *
 * @param db  pg.Pool インスタンス
 * @param logger  pino Logger
 * @param opts.tenantId  省略時は全アクティブテナント
 * @param opts.periodYyyyMm  省略時は現在月（例: "202603"）
 */
export async function reportUsageToStripe(
  db: any,
  logger: pino.Logger,
  opts: { tenantId?: string; periodYyyyMm?: string } = {}
): Promise<void> {
  const stripe = getStripeClient();
  const periodYyyyMm = opts.periodYyyyMm ?? getPeriodYyyyMm();

  const tenantsQuery = opts.tenantId
    ? await db.query(
        `SELECT tenant_id FROM stripe_subscriptions WHERE tenant_id = $1 AND is_active = true`,
        [opts.tenantId]
      )
    : await db.query(
        `SELECT DISTINCT tenant_id FROM stripe_subscriptions WHERE is_active = true`
      );

  for (const row of tenantsQuery.rows) {
    await _reportTenantUsage(db, stripe, logger, row.tenant_id as string, periodYyyyMm);
  }
}

// ---------------------------------------------------------------------------
// 定期実行ラッパー（PR-3・2026-08-25収益監査）。
//
// ★これまでの問題: 起動直後の tick が無かった★
// billingHealthMonitor / billingReconciliationMonitor は setInterval 直後に
// tick() を呼び「起動直後に1回評価」するが、Stripe送信バッチ(旧実装)は
// setInterval だけで、プロセスが24時間連続で生き続けて初めて1回目が走っていた。
// R2C はデプロイ頻度が高く（PM2再起動・デプロイが24時間以内に入るのが常態）、
// 実運用では reportUsageToStripe が一度も走らないまま何日も経過し得る状態だった。
//
// ★もう1つの問題: 月末の取りこぼし★
// getPeriodYyyyMm() は常に「当月」を返すため、月末の最終実行後に発生した利用は、
// 月が変わった瞬間に「先月分」になり、以後どのtickも当月しか見ないため二度と
// 送信されない。ここでは毎tickで「先月分」も併せて送る(冪等なので毎回送っても
// 実害はない。billedQuantityが前回と同じなら idempotencyKey が一致してStripe API
// 自体は呼ばれずスキップされる)。2ヶ月以上取りこぼした場合の検知は
// billingHealthCheck.ts の stuckPendingRows(月をまたいだpending行)に委ねる
// (このスケジューラ自身は無制限の遡り探索をしない)。
// ---------------------------------------------------------------------------

const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

class StripeUsageReporter {
  private timer: NodeJS.Timeout | null = null;
  // ★禁止30: 費用が発生する定期処理を多重起動しうる形で登録しない★
  // setInterval の二重登録ガード(this.timer)に加えて、1回のtickが24h以内に
  // 終わらなかった場合に次のtickと重ならないようにする(billingHealthMonitor /
  // billingReconciliationMonitor にも無い、この処理特有のガード。
  // reportUsageToStripe はテナント数分のStripe API呼び出し+リトライを含み、
  // 実行時間が読みにくいため必要性が高い)。
  private isRunning = false;

  start(db: any, logger: pino.Logger): void {
    if (this.timer) return; // 二重起動防止
    const tick = () => {
      void this.run(db, logger);
    };
    this.timer = setInterval(tick, REPORT_INTERVAL_MS);
    tick(); // 起動直後に1回実行(次の24時間を待たない)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** テスト専用: 状態をリセットする(シングルトンのため isRunning がテスト間で残る)。 */
  _resetForTest(): void {
    this.isRunning = false;
  }

  private async run(db: any, logger: pino.Logger): Promise<void> {
    if (this.isRunning) {
      logger.warn({}, '[stripeSync] previous run still in progress, skipping this tick');
      return;
    }
    this.isRunning = true;
    try {
      const now = new Date();
      const currentPeriod = getPeriodYyyyMm(now);
      // 月初のロールオーバーで year が変わっても Date.UTC は正しく繰り下がる
      // (month=-1 は前年12月として正規化される)。
      const previousMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const previousPeriod = getPeriodYyyyMm(previousMonthDate);

      for (const periodYyyyMm of [previousPeriod, currentPeriod]) {
        try {
          await reportUsageToStripe(db, logger, { periodYyyyMm });
        } catch (err) {
          logger.error({ err, periodYyyyMm }, '[stripeSync] reportUsageToStripe failed');
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}

export const stripeUsageReporter = new StripeUsageReporter();

export interface ExpectedBilling {
  totalRequests: number;
  totalCostCents: number;
  billableUnits: number;
  unstampedRows: number;
  /** 行ごとの倍率で重み付けした加重合計を最後に1回だけ切り上げた値。Stripeへ送る絶対値。 */
  billedQuantity: number;
  /** plan_multiplier が NULL の行に適用したフォールバック倍率(現在の tenants.plan 由来)。 */
  fallbackMultiplier: number;
}

/**
 * 指定期間の期待請求量を、usage_logs から都度まるごと再計算する。
 *
 * _reportTenantUsage(実際の送信経路)と billingReconciliation.ts(月次突合ジョブ)の
 * 両方がこの関数を呼ぶ。集計式を2箇所に書き写すと、どちらか一方だけを直したときに
 * サイレントにドリフトし、「突合ジョブは常に一致と報告するが実は両方とも同じ
 * バグを踏んでいるだけ」という、突合の意味が無くなる事故になる。
 *
 * ★C-2: 月の累積を毎回丸ごと再計算し、絶対値として送る(増分方式をやめる)★
 *
 * 旧設計は「pending 行だけを対象に集計→成功したら reported に倒す」という
 * 増分方式のように書かれていたが、Stripe へは action:'set'(絶対値の置き換え)
 * で送っていた。この不一致は「同月2回目以降は idempotencyKey 一致で丸ごと
 * スキップする」ガードに隠れて表面化していなかった(Asana 1217808138968200)。
 * もしそのガードだけを外すと、2回目の実行が「新たにpendingになった差分」を
 * 絶対値としてStripeへ送り、月初からの分を上書きして消してしまう
 * (過少請求。例: 1日目 100件送信→2日目 pending の新規50件だけを『合計』として送ると
 * 累積100件が消えて50件になる)。
 *
 * 正しい直し方は「請求状態を進行管理しない」こと: billing_status を集計の
 * フィルタから外し、その月に発生した billable 行を毎回すべて数え、
 * 常に「月初からの累積」を絶対値として送る。これにより:
 *   - 集計と reported 更新の間のレース(Asana課題)も消える(集計対象が
 *     状態遷移に依存しないため、順序を問わない)
 *   - リトライが安全になる(同じ絶対値を再送するだけ)
 *   - 遅れて届いた行も次回実行で自動的に拾われる
 *   - 冪等キーの連番化が不要になる(呼び出し元で billedQuantity を鍵に含める)
 *
 * ★2026-08-26: 課金単位を「リクエスト」から「会話」と「分」へ変える★
 *
 * 本番90日の実データで、それまでの前提が2つとも否定された
 * (.claude/rules/billing.md §7 / CLAUDE.md 禁止56):
 *   - テキスト: 「1会話 ≒ 5ターン」は誤り。message_count は中央値2・p99も2(＝1往復)で、
 *     原価は ¥0.55/会話ではなく **¥0.11/会話**。リクエスト単位で請求すると
 *     「会話を長く良くする」という製品目標がそのままテナントの値上げになる。
 *     → `feature_used='chat'` は **会話(session_id)ごとに1単位**。
 *   - アバター: 原価は回数ではなく時間に比例する(実測 **¥25.9/分**)。
 *     1分未満819件が平均¥19、15分以上72件(7.6%)が平均¥799と **42倍の開き**があり、
 *     回数あたりの定額では長時間セッション1件で赤字になる。
 *     → `feature_used='avatar'` は **CEIL(avatar_session_ms/60000.0)** で分換算。
 *       既存の anam_session の CEIL(秒/60.0) と同じ扱いを全アバターへ広げたもので、
 *       anam_session の扱いは変えない(兄弟の CASE として並べる)。
 * それ以外の feature_used は従来どおり 1行=1単位（今回は広げず、狭めるだけ）。
 *
 * ★message_count >= 2 の絞り込みを「読み取り時の LEFT JOIN」で行う理由★
 *
 * 課金対象の会話は `chat_sessions.message_count >= 2`(1往復以上)で、本番の23%を占める
 * 「ウィジェットを開いただけ」は課金しない。この列は usage_logs ではなく chat_sessions
 * にあるため、(a)集計時に JOIN する か (b)計上時に billable=false を焼き付ける、の2択になる。
 *
 * **(a) を採る。(b) は上の「毎回まるごと再計算する」不変条件を壊す。**
 * trackUsage が走る時点ではその会話が1往復に達するかどうかがまだ確定していない
 * (saveMessage は fire-and-forget で、assistant 側の記録は後から入る)。
 * 書き込み時に billable=false を焼き付けると、後から2通目が入っても
 * **二度と請求対象に戻らない**(=恒久的な過少請求)。読み取り時に JOIN すれば、
 * 何度再計算しても常に「その時点の真実」に収束する。
 *
 * JOIN は INNER ではなく **LEFT JOIN で、対応する chat_sessions 行が無い場合は課金する**。
 * 理由は2つ:
 *   1. chat_sessions には Right to Erasure の削除経路がある
 *      (`deleteSessionRepository.ts`)。INNER JOIN にすると、テナントが会話を削除した
 *      瞬間にその月の billedQuantity が**減る**。これは idempotencyKey の
 *      「billedQuantity は単調非減少」という前提(下の _reportTenantUsage 参照)を壊し、
 *      過去のキーへ後戻りして請求が消える。
 *   2. saveMessage は fire-and-forget なので、記録だけが落ちることが実際に起きる
 *      (2026-08-24 の visitor_id 事故と同じ経路)。usage_logs に行がある＝
 *      LLM を実際に呼んで原価が発生した確たる証拠なので、それを取りこぼす方が損害が大きい。
 * つまり **課金しないのは「1往復に満たない会話だと積極的に確認できた」ときだけ**にする。
 *
 * ★アバターとテキストの二重計上について(既知の制約)★
 *
 * 規則上はアバターを使ったセッションはアバターとしてのみ計上する(.claude/rules/billing.md §7)。
 * 実装上これは**構造的に満たされている**: アバター経路(avatar-agent/agent.py →
 * POST /api/internal/usage)は `feature_used` に 'avatar'/'voice' しか入れられず、
 * 会話単位の COUNT に入る `feature_used='chat'` の行を作らない。
 * ただし avatar-agent は R2C の session_id をそもそも知らないため
 * (LiveKit の room 名しか持たない。2026-08-26 時点)、
 * **「このテキスト会話は同じ訪問者のアバター利用でもあったか」を突き合わせることはできない**。
 * 現状のアバターはテキストチャットの /api/chat を経由しないので実害は無いが、
 * 将来アバターとテキストが同一セッションを共有する経路が生まれた場合は、
 * agent.py 側に session_id を配線する別 PR が必要になる。ここでは解決していない。
 *
 * @param currentPlan 呼び出し時点の tenants.plan（plan_multiplier が NULL の行への
 *   フォールバック倍率算出にのみ使う。焼き付け済みの行の倍率には影響しない）。
 */
export async function computeExpectedBilling(
  db: any,
  tenantId: string,
  startDate: string,
  endDate: string,
  currentPlan: string | null
): Promise<ExpectedBilling> {
  const fallbackMultiplier = planMultiplier(currentPlan);
  const aggResult = await db.query(
    `WITH billable_rows AS (
       SELECT request_id, session_id, feature_used, created_at,
              cost_total_cents, plan_multiplier,
              anam_session_seconds, avatar_session_ms
         FROM usage_logs
        WHERE tenant_id = $1
          AND created_at >= $2
          AND created_at <  $3
          AND billable = true
     ),
     -- 会話単位で数える分（テキストチャット）。1会話=1単位。
     -- 同一会話に複数リクエストがあっても DISTINCT ON で1行に畳む。
     -- 倍率は会話の最初の行の値を採る(.claude/rules/billing.md §7)。
     -- 会話開始時点のプランで請求する、という意味。
     -- LEFT JOIN の意図: chat_sessions 行が「有って message_count < 2」のときだけ課金しない。
     -- 行が無い(削除済み・記録漏れ)場合は課金する。詳細は関数の doc コメント参照。
     conversation_units AS (
       SELECT DISTINCT ON (r.session_id)
              COALESCE(r.plan_multiplier, $4::numeric) AS multiplier
         FROM billable_rows r
         LEFT JOIN chat_sessions cs
                ON cs.tenant_id = $1
               AND cs.session_id = r.session_id
        WHERE r.feature_used = 'chat'
          AND r.session_id IS NOT NULL
          AND (cs.session_id IS NULL OR cs.message_count >= 2)
        ORDER BY r.session_id, r.created_at, r.request_id
     ),
     -- 行単位で数える分。会話に紐付かないチャット行(migration 適用前の既存行)も
     -- ここへ落ちて従来どおり 1行=1単位 になる（黙って請求から消さない）。
     row_units AS (
       SELECT
         CASE WHEN r.feature_used = 'anam_session'
                   THEN CEIL(COALESCE(r.anam_session_seconds, 0) / 60.0)
              WHEN r.feature_used = 'avatar'
                   THEN CEIL(COALESCE(r.avatar_session_ms, 0) / 60000.0)
              ELSE 1
         END AS units,
         COALESCE(r.plan_multiplier, $4::numeric) AS multiplier
         FROM billable_rows r
        WHERE NOT (r.feature_used = 'chat' AND r.session_id IS NOT NULL)
     )
     SELECT
       (SELECT COUNT(*) FROM billable_rows)::integer AS total_requests,
       (SELECT COALESCE(SUM(cost_total_cents), 0) FROM billable_rows)::integer AS total_cost_cents,
       ( (SELECT COALESCE(SUM(units), 0) FROM row_units)
       + (SELECT COUNT(*) FROM conversation_units) )::integer AS billable_units,
       ( (SELECT COALESCE(SUM(units * multiplier), 0) FROM row_units)
       + (SELECT COALESCE(SUM(multiplier), 0) FROM conversation_units) )::numeric AS billed_units_weighted,
       (SELECT COUNT(*) FILTER (WHERE plan_multiplier IS NULL) FROM billable_rows)::integer AS unstamped_rows`,
    [tenantId, startDate, endDate, fallbackMultiplier]
  );

  const totalRequests: number = aggResult.rows[0].total_requests;
  const totalCostCents: number = aggResult.rows[0].total_cost_cents;
  // chat行は会話(session_id)ごとに1単位、anam_session行は秒→分、avatar行はミリ秒→分
  // （いずれも anamSessionBillableUnits と同じ切り上げ規則）、それ以外は1行=1単位。
  //
  // avatar 行の avatar_session_ms が NULL なら 0 分になる。これは意図した挙動:
  // avatar-agent の TTS 報告(_report_tts_usage)は featureUsed を送らないため
  // feature_used='avatar' かつ avatar_session_ms=NULL の行として着地するが、
  // その発話が含まれるセッションの長さは _report_avatar_usage が別行で報告する。
  // ここで1単位ずつ数えると同じアバターセッションを発話回数分だけ二重請求する。
  const billableUnits: number = aggResult.rows[0].billable_units;
  const unstampedRows: number = aggResult.rows[0].unstamped_rows;

  // 行ごとの倍率で重み付けした合計を最後に1回だけ切り上げる
  // （行ごとに切り上げると小数倍率のテナントで請求が膨らむ）。
  // pg は numeric を文字列で返すため Number() を通す。
  const billedQuantity = Math.ceil(Number(aggResult.rows[0].billed_units_weighted));

  return { totalRequests, totalCostCents, billableUnits, unstampedRows, billedQuantity, fallbackMultiplier };
}

async function _reportTenantUsage(
  db: any,
  stripe: any,
  logger: pino.Logger,
  tenantId: string,
  periodYyyyMm: string
): Promise<void> {
  // Phase39: billing_enabled / billing_free_from / billing_free_until チェック
  // プラン倍率算出のため plan も取得する。
  const tenantRow = await db.query(
    `SELECT billing_enabled, billing_free_from, billing_free_until, plan FROM tenants WHERE id = $1`,
    [tenantId]
  );
  let plan: string | null = null;
  if (tenantRow.rows.length > 0) {
    const tenant = tenantRow.rows[0];
    plan = tenant.plan ?? null;
    if (!tenant.billing_enabled) {
      logger.info({ tenantId }, `[billing] ${tenantId}: billing not enabled, skipping Stripe report`);
      return;
    }
    const now = new Date();
    const freeFrom  = tenant.billing_free_from  ? new Date(tenant.billing_free_from)  : null;
    const freeUntil = tenant.billing_free_until ? new Date(tenant.billing_free_until) : null;
    if (freeFrom && freeUntil && now >= freeFrom && now <= freeUntil) {
      logger.info(
        { tenantId, freeFrom: tenant.billing_free_from, freeUntil: tenant.billing_free_until },
        `[billing] ${tenantId}: free period ${tenant.billing_free_from} ~ ${tenant.billing_free_until}, skipping`
      );
      return;
    }
  }

  const { startDate, endDate } = periodToDateRange(periodYyyyMm);

  // 倍率は行ごとに「利用時点で焼き付けた」 usage_logs.plan_multiplier を使う
  // （migration_usage_logs_plan_snapshot.sql）。tenants.plan を読んで月全体に
  // 掛けると、月中のプラン変更が月初まで遡って請求を書き換えてしまう
  // （enterprise で1か月使って月末に free_ad へ落とすと全額0円になる）。
  //
  // $4 = tenants.plan 由来の倍率。plan_multiplier が NULL の行
  // （本カラム追加前の既存行 / 記録時にプランを確定できなかった行）だけに
  // 適用する後方互換のフォールバックであり、確定済みの行には効かない。
  //
  // GID 1216944003337186: billable=false（管理系LLM機能・chargeOneOffJpyで別途請求済みの
  // sai_agent等）は原価がusage_logsに記録されていてもStripe請求数量の集計対象から除外する。
  // ★C-2: 月の累積を毎回丸ごと再計算し、絶対値として送る(増分方式をやめる)★
  // 詳細は computeExpectedBilling() のコメント参照。
  const { totalRequests, totalCostCents, billableUnits, unstampedRows, billedQuantity, fallbackMultiplier } =
    await computeExpectedBilling(db, tenantId, startDate, endDate, plan);

  if (totalRequests === 0) {
    logger.debug({ tenantId, periodYyyyMm }, '[stripeSync] no pending usage');
    return;
  }

  if (unstampedRows > 0) {
    // migration 適用直後は既存行が NULL のまま残るため、当面は正常に出る。
    // 適用から1か月以上経っても出続ける場合は usageTracker の焼き付けが
    // 効いていない（= 遡及請求の穴が残っている）ことを意味する。
    logger.warn(
      { tenantId, periodYyyyMm, unstampedRows, totalRequests, fallbackMultiplier },
      '[stripeSync] rows without plan_multiplier fell back to current tenants.plan'
    );
  }

  // 冪等キーに billedQuantity を含める。
  // 「(テナント, 月)」だけをキーにすると、金額が変わった2回目以降の実行が
  // 同じキーでスキップされてしまう(C-2 導入前の不具合)。金額をキーに含めることで:
  //   - 前回と同額なら同じキー → 既存行がヒットしてスキップ(何も変わっていない)
  //   - 増えていれば新しいキー → 新しい絶対値として素通りする
  // billedQuantity はその月の累積(集計クエリが行を消費しない限り単調非減少)なので、
  // 同一(テナント,月)内で過去のキーへ後戻りすることはない。
  const idempotencyKey = `billing:${tenantId}:${periodYyyyMm}:${billedQuantity}`;

  // 同額を既に送信済みならスキップ(直前の実行から変化が無い)
  const existing = await db.query(
    `SELECT status FROM stripe_usage_reports WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rows.length > 0 && existing.rows[0].status === 'sent') {
    logger.debug({ tenantId, periodYyyyMm, billedQuantity }, '[stripeSync] same amount already reported, skipping');
    return;
  }

  const subInfo = await getSubscriptionItemId(db, tenantId, stripe, logger);
  if (!subInfo) return;

  // stripe_usage_reports にupsert（冪等）。billed_quantity は「送信を試みる数量」
  // をこの時点で先に記録する。Stripe API呼び出し(下記)が例外→リトライを繰り返す間も、
  // 「何を送ろうとしたか」を突合から追えるようにするため、送信成否を待たずに書く。
  //
  // ★migration未適用でも他テナントの報告を止めないこと★
  // ここが例外を投げると、呼び出し元の reportUsageToStripe の for ループに伝播し、
  // その回のバッチで後続の全テナントが報告されないまま24時間止まる
  // (index.ts のスケジューラは reportUsageToStripe 全体を1つの catch で包むだけで、
  // テナント単位のエラー分離をしていない)。migration_stripe_usage_reports_billed_quantity.sql
  // が未適用のままデプロイすると、最初のテナントで即座に全滅しかねないため、
  // usageTracker.ts と同じパターンで 42703 のときだけ旧カラム構成に1回だけ
  // フォールバックし、記録の消失(=バッチ全体の停止)を防ぐ。
  try {
    await db.query(
      `INSERT INTO stripe_usage_reports
         (tenant_id, period_yyyymm, idempotency_key, total_requests, total_cost_cents, billed_quantity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         total_requests   = EXCLUDED.total_requests,
         total_cost_cents = EXCLUDED.total_cost_cents,
         billed_quantity  = EXCLUDED.billed_quantity,
         updated_at       = NOW()`,
      [tenantId, periodYyyyMm, idempotencyKey, totalRequests, totalCostCents, billedQuantity]
    );
  } catch (err) {
    if ((err as { code?: string })?.code !== '42703') throw err;
    logger.error(
      { err, tenantId, periodYyyyMm },
      '[stripeSync] stripe_usage_reports に billed_quantity 列が無い — ' +
      'migration_stripe_usage_reports_billed_quantity.sql が未適用。旧カラムで継続するが、' +
      '突合用の billed_quantity は記録できない状態のまま。至急 migration を適用すること'
    );
    await db.query(
      `INSERT INTO stripe_usage_reports
         (tenant_id, period_yyyymm, idempotency_key, total_requests, total_cost_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         total_requests   = EXCLUDED.total_requests,
         total_cost_cents = EXCLUDED.total_cost_cents,
         updated_at       = NOW()`,
      [tenantId, periodYyyyMm, idempotencyKey, totalRequests, totalCostCents]
    );
  }

  // Stripe送信（最大3回リトライ）
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const usageRecord = await stripe.subscriptionItems.createUsageRecord(
        subInfo.itemId,
        {
          quantity:  billedQuantity,
          timestamp: Math.floor(Date.now() / 1000),
          action:    'set',
        },
        { idempotencyKey }
      );

      await db.query(
        `UPDATE stripe_usage_reports
         SET status = 'sent', stripe_usage_record_id = $1, updated_at = NOW()
         WHERE idempotency_key = $2`,
        [usageRecord.id, idempotencyKey]
      );

      // billing_status は集計の対象条件ではなくなった(上記)ので、ここでの更新は
      // 「この月は少なくとも1回、直近の送信に含まれた」という観測用の印にすぎない。
      // billable=false の行はこの集計・報告に含まれていないため 'reported' にはしない
      // （'pending' のまま維持。原価可視化のための行であり、Stripeに送信済みという意味を
      // 持たせない）。'pending' 縛りを外すのは、集計時点より後に届いた行も
      // 次回実行で自然に拾われるため、状態遷移の順序に依存させないため。
      await db.query(
        `UPDATE usage_logs
         SET billing_status = 'reported'
         WHERE tenant_id = $1
           AND created_at >= $2
           AND created_at <  $3
           AND billable = true`,
        [tenantId, startDate, endDate]
      );

      logger.info(
        // plan / fallbackMultiplier は「未焼き付け行に適用した値」であって、
        // 焼き付け済み行の倍率ではない（月中に変更があれば行ごとに異なる）。
        { tenantId, periodYyyyMm, totalRequests, billableUnits, billedQuantity,
          currentPlan: plan, fallbackMultiplier, unstampedRows, totalCostCents },
        '[stripeSync] usage reported to Stripe'
      );

      // 月額固定費の按分を上乗せ（いずれもデフォルト OFF・冪等）。
      // アバター専用費(LemonSlice/LiveKit)は scope='avatar'（アバター利用テナントで割る）。
      await _chargeMonthlyFixedShare(
        db, stripe, logger, tenantId, periodYyyyMm, startDate, endDate, subInfo.customerId,
        {
          feeJpy:           getLemonsliceMonthlyFeeJpy(),
          table:            'lemonslice_monthly_charges',
          label:            'LemonSlice',
          idempotencyPrefix:'lemonslice-monthly',
          scope:            'avatar',
        }
      );
      // LiveKit (Ship プラン) 月額固定費の按分（LEMONSLICE と独立・冪等テーブルも別）
      await _chargeMonthlyFixedShare(
        db, stripe, logger, tenantId, periodYyyyMm, startDate, endDate, subInfo.customerId,
        {
          feeJpy:           getLivekitMonthlyFeeJpy(),
          table:            'livekit_monthly_charges',
          label:            'LiveKit',
          idempotencyPrefix:'livekit-monthly',
          scope:            'avatar',
        }
      );
      // プラットフォーム共通費(Supabase/Cloudflare/Hetzner/ES の合計)の按分。
      // scope='all'＝アバター有無を問わず当月アクティブな全テナントで均等割りする。
      await _chargeMonthlyFixedShare(
        db, stripe, logger, tenantId, periodYyyyMm, startDate, endDate, subInfo.customerId,
        {
          feeJpy:           getPlatformMonthlyFeeJpy(),
          table:            'platform_monthly_charges',
          label:            'プラットフォーム基本料',
          idempotencyPrefix:'platform-monthly',
          scope:            'all',
        }
      );
      return;
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { err, tenantId, attempt: attempt + 1, maxRetries: MAX_RETRIES },
        '[stripeSync] stripe API error, retrying'
      );
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1)));
      }
    }
  }

  // 全リトライ失敗
  await db.query(
    `UPDATE stripe_usage_reports
     SET status = 'failed',
         retry_count = retry_count + 1,
         last_error  = $1,
         updated_at  = NOW()
     WHERE idempotency_key = $2`,
    [lastError?.message?.slice(0, 500) ?? 'unknown', idempotencyKey]
  );

  logger.error(
    { tenantId, periodYyyyMm, error: lastError?.message },
    '[stripeSync] failed after max retries'
  );
}
