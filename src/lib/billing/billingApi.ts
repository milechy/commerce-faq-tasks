// src/lib/billing/billingApi.ts
// Phase32 + Phase54: 課金管理API

import type pino from 'pino';
import type { Application, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { roleAuthMiddleware, requireRole } from '../../api/middleware/roleAuth';
import { computeExpectedBilling } from './stripeSync';
import { getSubscriptionItemPrices, toSubscriptionItems } from './planPricing';
import { billingSyncStatusNeedsAttention } from './subscriptionSync';
import {
  getMonthRangeJst,
  includedQuotaForPlan,
  computeQuotaOverage,
  FREE_AD_MONTHLY_CONVERSATION_LIMIT,
  FREE_AD_MONTHLY_ADMIN_CONSULT_LIMIT,
} from './planQuota';
import {
  fetchTenantEconomics, fetchTenantEconomicsDetail,
  type TenantBillingSnapshot, type PeriodInvoice,
} from './tenantEconomics';
import type { TenantUpsellFigures } from './upsellRenderer';
import type { UpsellSignal } from './upsellSignals';

const usageQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  group_by: z.enum(['tenant']).optional(),
});

const breakdownQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const invoicesQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
});

// 粗利分析。任意の from/to を受けず period(YYYYMM)のみを受ける。
// 基本料・込み枠が絡む売上推計は暦月でしか意味を持たず、任意期間を許すと
// 「日割りされていない基本料 ÷ 任意期間」という無意味な粗利が出るため。
const economicsQuerySchema = z.object({
  period: z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/),
});
const economicsDetailQuerySchema = economicsQuerySchema.extend({
  /** 'stripe' のときだけ Stripe を叩いて実請求と突合する。既定は推計のみ。 */
  reconcile: z.enum(['stripe']).optional(),
});

/** tenantId をJWT（client_admin）またはクエリ（super_admin）から解決する */
function resolveTenantId(req: Request): { tenantId: string | null; isSuperAdmin: boolean } {
  const user = (req as any).user as { role: string; tenantId: string | null } | undefined;
  const isSuperAdmin = user?.role === 'super_admin';
  if (isSuperAdmin) {
    return { tenantId: (req.query.tenantId as string | undefined) ?? null, isSuperAdmin };
  }
  return { tenantId: user?.tenantId ?? null, isSuperAdmin };
}

/**
 * 課金管理APIルートを登録する。
 *
 * - GET /v1/admin/billing/usage          — テナント別使用量集計（日次・月次）
 * - GET /v1/admin/billing/cost-breakdown — feature_used 別コスト内訳
 * - GET /v1/admin/billing/invoices       — Stripe Invoice一覧
 * - GET /v1/admin/billing/quota          — 込み枠・無料枠の当月消費(UX-C)
 *
 * baseMiddleware には supabaseAuthMiddleware のみ渡すこと。
 * ロール検査（super_admin / client_admin）はこの関数内部で行う。
 */
// ── Zod スキーマ (管理操作) ────────────────────────────────────────────────
const retryInvoiceSchema = z.object({
  invoiceId: z.string().min(1),
});

const adjustSchema = z.object({
  tenantId: z.string().min(1),
  amount:   z.number().int(),   // JPY（負=割引、正=追加）
  reason:   z.string().min(1).max(500),
});

const freePeriodSchema = z.object({
  tenantId:  z.string().min(1),
  freeFrom:  z.string().datetime({ offset: true }).nullable().optional(),
  freeUntil: z.string().datetime({ offset: true }).nullable().optional(),
});

const toggleServiceSchema = z.object({
  tenantId: z.string().min(1),
  action:   z.enum(['pause', 'resume']),
});

const adjustmentsQuerySchema = z.object({
  tenantId: z.string().min(1),
});

const onboardSchema = z.object({
  tenantId: z.string().min(1),
  // 基本料の請求周期。込み枠を持つ standard/growth でのみ意味を持ち、
  // 純従量の starter に annual を指定した場合は 400 で弾く(黙って monthly に
  // 倒すと「年払いで契約したつもり」との齟齬が残るため)。
  billingCycle: z.enum(['monthly', 'annual']).default('monthly'),
});

function getStripe(secretKey: string): any {
  const Stripe = require('stripe');
  return new Stripe(secretKey, { apiVersion: '2024-06-20' });
}

// ---------------------------------------------------------------------------
// PR-5(2026-08-25収益監査): 「今月の請求額」に、原価×MARGIN_MULTIPLIER(USDセント)を
// 無変換で¥表示していた(禁止48違反)。
//
// UX-B(2026-08-26): PR-5 の是正自体が #1015(Standard/Growth を「基本料+込み枠+超過」に
// 変更)より前の実装のまま残っていた。旧実装は STRIPE_METERED_PRICE_ID という単一の
// 従量price 1本を取得し、billedQuantity(= プラン倍率で重み付け済みの数量)に掛けていた。
// #1015 で倍率は price 側(プランごとに分かれた Stripe price)に移ったため、この掛け算は
// 二重適用(Standard +25% / Growth +50%)であり、しかも基本料(¥9,800/¥29,800)・
// 込み枠・アバターの分単価を一切見ていなかった(禁止56)。
// ここでは getSubscriptionItemPrices(planPricing.ts)を唯一の出どころとして、
// プランごとに「基本料 + 込み枠を超えた分 × 実単価」を積む式に直す。
// 取得できない場合は0円ではなく null(算出不可)を返す — 0円は「今月は無料」に
// 読めてしまうため区別する(禁止20)。free_ad だけは実際に常に¥0(倍率0)なので
// 0を返す(算出不可ではない)。
// ---------------------------------------------------------------------------

const priceUnitAmountCache = new Map<string, { unitAmountJpy: number | null; fetchedAt: number }>();
const PRICE_CACHE_TTL_MS = 15 * 60 * 1000;

/** テスト専用: モジュールスコープの価格キャッシュをリセットする。 */
export function _resetPriceCacheForTest(): void {
  priceUnitAmountCache.clear();
}

/**
 * 1つの Stripe price の実単価(円)をキャッシュ付きで取得する。
 *
 * ★price ID ごとにキャッシュする★ Standard/Growth は基本料・テキスト超過・
 * アバター超過の3本、異なる price を同時に見る必要があるため、旧実装のような
 * モジュール全体で1個のキャッシュだと3本目を引いた瞬間に1本目が上書きされる。
 */
async function getPriceUnitAmountJpy(stripe: any, priceId: string): Promise<number | null> {
  const now = Date.now();
  const cached = priceUnitAmountCache.get(priceId);
  if (cached && now - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return cached.unitAmountJpy;
  }
  try {
    const price = await stripe.prices.retrieve(priceId);
    // per_unit以外(段階制など)は「数量×単価」の単純計算が成立しないため、
    // 推測せず算出不可に倒す(誤った金額を出すより「出さない」方が禁止10に沿う)。
    const unitAmount =
      price.billing_scheme === 'per_unit' && typeof price.unit_amount === 'number'
        ? price.unit_amount
        : null;
    priceUnitAmountCache.set(priceId, { unitAmountJpy: unitAmount, fetchedAt: now });
    return unitAmount;
  } catch {
    // Stripe到達不可時はキャッシュを更新せず、今回だけ算出不可を返す(次回再試行)。
    return cached?.unitAmountJpy ?? null;
  }
}

/**
 * 指定テナント・期間について、確定価格体系(.claude/rules/billing.md §7)どおりの
 * 請求見積りを円で返す。以下のいずれかに該当する場合は null(算出不可) —
 * 0円を返すと「今月は無料」に読めてしまうため区別する。
 *   - STRIPE_SECRET_KEY が未設定
 *   - テナントが存在しない
 *   - 該当プランの price 環境変数が未設定(getSubscriptionItemPrices が ok:false)
 *   - Stripe price が per_unit 以外(段階制等)
 *   - enterprise(個別契約のため自動算出しない)
 * free_ad は上記のどれにも該当せず、常に 0 を返す(倍率0で実際に無料のため)。
 */
export async function computeBillingEstimateJpy(
  db: any,
  tenantId: string,
  from: string,
  to: string,
): Promise<number | null> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) return null;

  const tenantResult = await db.query(`SELECT plan FROM tenants WHERE id = $1`, [tenantId]);
  if (tenantResult.rows.length === 0) return null;
  const plan = tenantResult.rows[0].plan as string | null;

  // free_ad は倍率0で請求が発生しない。算出不可(null)ではなく実額として0を返す。
  if (plan === 'free_ad') return 0;

  const stripe = getStripe(stripeSecretKey);

  // textUnits/avatarMinutes/adminConsults は「倍率適用前・込み枠差し引き前」の生の数量。
  // 込み枠の差し引きは生の数量に対して行う必要がある(computeQuotaOverage 参照)。
  const { textUnits, avatarMinutes, adminConsults } = await computeExpectedBilling(db, tenantId, from, to, plan);

  if (plan === 'standard' || plan === 'growth') {
    const priceResult = getSubscriptionItemPrices(plan, 'monthly');
    if (!priceResult.ok) return null;
    const { base, text: textOveragePriceId, avatarOverage: avatarOveragePriceId } = priceResult.prices;
    if (!base || !textOveragePriceId || !avatarOveragePriceId) return null;

    const overage = computeQuotaOverage(plan, textUnits, avatarMinutes, adminConsults);
    // standard/growth は必ず込み枠を持つ(PLAN_INCLUDED_QUOTASに定義済み)ので
    // null になるのは設定不整合のみ。誤った金額を出すより算出不可を返す。
    if (!overage) return null;

    const [baseAmountJpy, textOverageUnitJpy, avatarOverageUnitJpy] = await Promise.all([
      getPriceUnitAmountJpy(stripe, base),
      getPriceUnitAmountJpy(stripe, textOveragePriceId),
      getPriceUnitAmountJpy(stripe, avatarOveragePriceId),
    ]);
    if (baseAmountJpy === null || textOverageUnitJpy === null || avatarOverageUnitJpy === null) return null;

    // ★textPriceQuantity(=テキスト超過+管理AI超過)を使う★
    // Stripeへ実際に送信する数量(stripeSync.ts の _reportQuotaOverageUsage)と同じ値。
    // overage.textConversations だけを使うと、管理AIの超過分が請求見積りから漏れる。
    return (
      baseAmountJpy +
      overage.textPriceQuantity * textOverageUnitJpy +
      overage.avatarMinutes * avatarOverageUnitJpy
    );
  }

  // starter(および null/未知プランは starter として fail-safe — planMultiplier と
  // 同じ「請求漏れを避ける」向き)は基本料も込み枠も無い純従量: 会話数 × 単価のみ。
  // enterprise はここで getSubscriptionItemPrices が ok:false(plan_not_self_serve)を
  // 返すため自然に null に落ちる(個別契約を自動算出しない、という既存方針どおり)。
  const priceResult = getSubscriptionItemPrices(plan, 'monthly');
  if (!priceResult.ok || !priceResult.prices.text) return null;

  const unitAmountJpy = await getPriceUnitAmountJpy(stripe, priceResult.prices.text);
  if (unitAmountJpy === null) return null;

  return textUnits * unitAmountJpy;
}

/**
 * プランの月額基本料(円)を返す。算出不可は null。
 *
 * starter は基本料が無い純従量プランなので 0 ではなく null を返す
 * (「基本料0円」と「基本料という概念が無い」を同じ値にしない)。
 * enterprise / free_ad は getSubscriptionItemPrices が plan_not_self_serve を
 * 返すため自然に null に落ちる(個別契約を自動算出しない既存方針どおり)。
 */
async function planBaseMonthlyJpy(stripe: any, plan: string): Promise<number | null> {
  const priceResult = getSubscriptionItemPrices(plan, 'monthly');
  if (!priceResult.ok || !priceResult.prices.base) return null;
  return getPriceUnitAmountJpy(stripe, priceResult.prices.base);
}

/**
 * アップセル文面に必要な数字を組み立てる（テナント向け）。
 *
 * ★戻り値の型に原価・マージン・粗利のフィールドを足さないこと★
 * TenantUpsellFigures はテナントに描画される型で、判別子 __audience により
 * 運営向けの型と取り違えられないようにしてある(upsellRenderer.ts 参照)。
 *
 * 金額は Stripe price が唯一の出どころ。コードに単価を焼き付けない
 * (planQuota.ts の「超過単価はコードに置かない」方針を継承)。
 */
export async function buildTenantUpsellFigures(
  db: any,
  tenantId: string,
  signal: UpsellSignal,
  currentPlan: string,
  recommendedPlan: string,
): Promise<TenantUpsellFigures> {
  const { monthStart, monthEnd } = getMonthRangeJst(new Date());
  const from = monthStart.toISOString();
  const to = monthEnd.toISOString();

  const { textUnits, avatarMinutes, adminConsults } = await computeExpectedBilling(db, tenantId, from, to, currentPlan);
  const overage = computeQuotaOverage(currentPlan, textUnits, avatarMinutes, adminConsults);

  const includedNow = includedQuotaForPlan(currentPlan);
  const includedAfter = includedQuotaForPlan(recommendedPlan);

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  let currentBase: number | null = null;
  let recommendedBase: number | null = null;
  if (stripeSecretKey) {
    const stripe = getStripe(stripeSecretKey);
    // 直列にしない理由は無い(2件だけ・price はキャッシュ済みのことが多い)。
    [currentBase, recommendedBase] = await Promise.all([
      planBaseMonthlyJpy(stripe, currentPlan),
      planBaseMonthlyJpy(stripe, recommendedPlan),
    ]);
  }

  return {
    __audience: 'tenant',
    signal,
    current_plan: currentPlan,
    recommended_plan: recommendedPlan,
    current_base_monthly_jpy: currentBase,
    recommended_base_monthly_jpy: recommendedBase,
    text_included_now: includedNow?.textConversations ?? null,
    text_included_after: includedAfter?.textConversations ?? null,
    avatar_included_minutes_now: includedNow?.avatarMinutes ?? null,
    avatar_included_minutes_after: includedAfter?.avatarMinutes ?? null,
    text_overage: overage?.textConversations ?? 0,
    avatar_overage_minutes: overage?.avatarMinutes ?? 0,
    as_of: new Date().toISOString(),
  };
}

/**
 * 粗利分析へ渡す売上側のスナップショット。
 *
 * tenantEconomics.ts はこれを注入されて使う(循環 import を避けるため)。
 * ★集計SQLを書き写さない★ — 数量も金額も computeExpectedBilling /
 * computeBillingEstimateJpy という既存の唯一の出どころから取る。
 */
export async function fetchTenantBillingSnapshot(
  db: any, tenantId: string, from: string, to: string,
): Promise<TenantBillingSnapshot> {
  const tenantResult = await db.query(`SELECT plan FROM tenants WHERE id = $1`, [tenantId]);
  const plan = (tenantResult.rows[0]?.plan as string | null) ?? null;
  const [{ textUnits, avatarMinutes }, revenueEstimateJpy] = await Promise.all([
    computeExpectedBilling(db, tenantId, from, to, plan),
    computeBillingEstimateJpy(db, tenantId, from, to),
  ]);
  return { plan, textUnits, avatarMinutes, revenueEstimateJpy };
}

/**
 * 突合用に請求書だけを取る。
 *
 * fetchBillingInvoices を使い回さないのは、あちらが Billing Portal セッションを
 * 毎回作る(Stripe への書き込み)ためで、参照だけの突合で副作用を起こしたくない。
 * null は「Stripe から取得できない(未契約 / キー未設定)」、空配列は
 * 「取得できたが該当なし」。★この2つを同じ値で表現しない★
 */
export async function fetchPeriodInvoices(db: any, tenantId: string): Promise<PeriodInvoice[] | null> {
  const subResult = await db.query(
    `SELECT stripe_customer_id FROM stripe_subscriptions
      WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId],
  );
  if (subResult.rows.length === 0) return null;

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) return null;

  const stripe = getStripe(stripeSecretKey);
  const invoices = await stripe.invoices.list({ customer: subResult.rows[0].stripe_customer_id, limit: 24 });
  return invoices.data.map((inv: any) => ({
    id: inv.id,
    status: inv.status,
    amount_due: inv.amount_due,
    amount_paid: inv.amount_paid,
    currency: inv.currency,
    period_start: inv.period_start,
    period_end: inv.period_end,
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
  }));
}

// ---------------------------------------------------------------------------
// W2-7(docs/COPILOT_UI_PARITY.md §3.1 #15): GET /v1/admin/billing/{usage,cost-breakdown,
// invoices} の集計本体。HTTPレイヤ(このファイルのルート本体)とチャットエージェント
// (agent/actionExecutor.ts)の両方から同じ値を取得できるよう、認可・レスポンス整形から
// 切り離してここに置く(admin/analytics/summaryQueries.ts と同じ狙い)。
// ---------------------------------------------------------------------------

function billingWhereClause(tenantId: string | null, from?: string, to?: string): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (tenantId) {
    params.push(tenantId);
    conditions.push(`tenant_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at < $${params.length}::timestamptz`);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function fetchBillingUsage(
  db: any,
  tenantId: string | null,
  from?: string,
  to?: string,
): Promise<{
  tenantId: string;
  daily: Record<string, unknown>[];
  monthly: Record<string, unknown>[];
  /** PR-5: Stripe実単価ベースの見積り(円)。tenantId未指定(横断ビュー)や
   *  from/to未指定では算出しようがないため常にnull。 */
  billing_estimate_jpy: number | null;
}> {
  const { where, params } = billingWhereClause(tenantId, from, to);

  const dailyResult = await db.query(
    `SELECT
       DATE(created_at)                                           AS date,
       COUNT(*)::integer                                          AS total_requests,
       COUNT(*) FILTER (WHERE feature_used = 'chat')::integer    AS chat_requests,
       COUNT(*) FILTER (WHERE feature_used = 'avatar')::integer  AS avatar_requests,
       COUNT(*) FILTER (WHERE feature_used = 'voice')::integer   AS voice_requests,
       COALESCE(SUM(input_tokens),      0)::integer              AS input_tokens,
       COALESCE(SUM(output_tokens),     0)::integer              AS output_tokens,
       COALESCE(SUM(cost_llm_cents),    0)::integer              AS cost_llm_cents,
       COALESCE(SUM(cost_total_cents),  0)::integer              AS cost_total_cents,
       COALESCE(SUM(tts_text_bytes),    0)::bigint               AS tts_text_bytes,
       COALESCE(SUM(avatar_session_ms), 0)::bigint               AS avatar_session_ms
     FROM usage_logs
     ${where}
     GROUP BY DATE(created_at)
     ORDER BY DATE(created_at) ASC`,
    params,
  );

  const monthlyResult = await db.query(
    `SELECT
       TO_CHAR(created_at, 'YYYY-MM')                            AS month,
       COUNT(*)::integer                                          AS total_requests,
       COUNT(*) FILTER (WHERE feature_used = 'chat')::integer    AS chat_requests,
       COUNT(*) FILTER (WHERE feature_used = 'avatar')::integer  AS avatar_requests,
       COUNT(*) FILTER (WHERE feature_used = 'voice')::integer   AS voice_requests,
       COALESCE(SUM(input_tokens),      0)::integer              AS input_tokens,
       COALESCE(SUM(output_tokens),     0)::integer              AS output_tokens,
       COALESCE(SUM(cost_llm_cents),    0)::integer              AS cost_llm_cents,
       COALESCE(SUM(cost_total_cents),  0)::integer              AS cost_total_cents
     FROM usage_logs
     ${where}
     GROUP BY TO_CHAR(created_at, 'YYYY-MM')
     ORDER BY month DESC`,
    params,
  );

  const billingEstimateJpy =
    tenantId && from && to ? await computeBillingEstimateJpy(db, tenantId, from, to) : null;

  return {
    tenantId: tenantId ?? 'all',
    daily: dailyResult.rows,
    monthly: monthlyResult.rows,
    billing_estimate_jpy: billingEstimateJpy,
  };
}

export type BillingCostBreakdownItem = { label: string; cost_usd: number; request_count: number; percentage: number };

export async function fetchBillingCostBreakdown(
  db: any,
  tenantId: string | null,
  from?: string,
  to?: string,
): Promise<{ tenantId: string; total_usd: number; breakdown: Record<string, BillingCostBreakdownItem> }> {
  const { where, params } = billingWhereClause(tenantId, from, to);

  const result = await db.query(
    `SELECT
       feature_used,
       COUNT(*)::integer                             AS request_count,
       COALESCE(SUM(cost_llm_cents),   0)::integer  AS llm_cents,
       COALESCE(SUM(cost_total_cents), 0)::integer  AS total_cents
     FROM usage_logs
     ${where}
     GROUP BY feature_used
     ORDER BY total_cents DESC`,
    params,
  );

  // 画面に内部語(feature_used の生の文字列)を出さないための日本語ラベル。
  // 未知キーは `?? feature` で英語のまま出すフォールバックを残す。
  const LABELS: Record<string, string> = {
    chat: 'AI応答',
    avatar: 'アバター映像',
    voice: '音声合成',
    admin_agent: '管理AIへの相談',
    agent_search: '外部エージェント連携',
    anam_session: 'アバター会話',
    admin_guide: '管理AIの下準備',
    book_analysis: '書籍ナレッジの取り込み',
    book_structurize: '書籍ナレッジの取り込み',
    avatar_config_image: 'アバター画像の生成',
    avatar_config_voice: 'アバター音声の生成',
    avatar_config_prompt: 'アバター性格の生成',
    avatar_config_test: 'アバターの動作確認',
    feedback_ai: 'フィードバックAI',
    option_service: '代行サービス',
    premium_avatar_generation: 'プレミアムアバター生成',
    admin_tuning: '指示ルールの自動提案',
    admin_ai_assist: '管理AIの下書き作成',
    admin_engagement_suggest: 'エンゲージメント施策の提案',
    admin_option_estimator: '代行サービスの見積り',
    sai_agent: '設定代行エージェント',
  };

  const totalCents = result.rows.reduce(
    (s: number, r: Record<string, unknown>) => s + Number(r['total_cents']),
    0,
  );

  // PR-5: この内訳は機能別の「原価」構成比であり、USD建て(costCalculator.ts)。
  // Stripeは機能別に請求を分けないため実単価ベースには変換できない。
  // 変換なしに¥表示していたのが禁止48違反の一つだったので、正直に$のまま返す。
  //
  // ★小数第2位まで残す(整数へ丸めない)★
  // 管理系(admin_agent等)は1機能あたり数セント〜十数セントの少額が常態で、
  // 従来の Math.round(cents/100) だと全て $0 に潰れていた(是正対象)。
  // 単位は USD のまま(円に変換しない。禁止48)。
  const breakdown: Record<string, BillingCostBreakdownItem> = {};
  for (const row of result.rows) {
    const feature = row.feature_used as string;
    breakdown[feature] = {
      label: LABELS[feature] ?? feature,
      cost_usd: Math.round(Number(row.total_cents)) / 100,
      request_count: Number(row.request_count),
      percentage: totalCents > 0 ? Math.round((Number(row.total_cents) / totalCents) * 100) : 0,
    };
  }

  return { tenantId: tenantId ?? 'all', total_usd: Math.round(totalCents) / 100, breakdown };
}

export type BillingInvoicesResult =
  | {
      status: 'ok';
      tenantId: string;
      customerId: string;
      portalUrl: string;
      /** tenants.billing_sync_status に永続化された直近のプラン変更同期結果(下記コメント参照)。 */
      billingSyncStatus: string | null;
      /** 上記が対応を要する状態か。判定基準の重複を避けるため billingSyncStatusNeedsAttention を使う。 */
      billingSyncNeedsAttention: boolean;
      invoices: Array<{
        id: string;
        status: string;
        status_label: string;
        amountDue: number;
        amountPaid: number;
        currency: string;
        periodStart: number;
        periodEnd: number;
        hostedInvoiceUrl: string | null;
        invoicePdf: string | null;
        created: number;
      }>;
    }
  | { status: 'no_subscription'; tenantId: string; billingSyncStatus: string | null; billingSyncNeedsAttention: boolean }
  | { status: 'stripe_not_configured' };

const INVOICE_STATUS_LABELS: Record<string, string> = {
  paid: 'お支払い済み',
  open: '未払い',
  draft: '下書き',
  void: '無効',
};

export async function fetchBillingInvoices(db: any, tenantId: string): Promise<BillingInvoicesResult> {
  // ★リロードを跨いだ「支払い設定が未完了」の可視化(2026-08-26 レビュー是正)★
  // syncSubscriptionForTenant の結果は従来 PUT/PATCH のレスポンスにしか載らず、
  // PlanSection.tsx のコンポーネントstate(lastBillingSync)だけが保持していた。
  // 画面をリロードすると warning が跡形もなく消えていたため、tenants自身に
  // 焼き付けた直近の同期結果(billing_sync_status)をここで読み、
  // needsBillingAttention と同じ判定で「対応を要する状態か」を返す。
  // migration_billing_sync_status.sql 未適用環境でも42703をfail-openし、
  // 単に「持ち越し情報が無い(false)」として動作を継続する。
  let billingSyncStatus: string | null = null;
  let billingSyncNeedsAttention = false;
  try {
    const syncRow = await db.query(`SELECT billing_sync_status FROM tenants WHERE id = $1`, [tenantId]);
    billingSyncStatus = syncRow.rows[0]?.billing_sync_status ?? null;
    billingSyncNeedsAttention = billingSyncStatusNeedsAttention(billingSyncStatus);
  } catch {
    // migration未適用等。fail-open(不明な場合は「対応不要」扱い) — 過去のfailedを
    // 見せ損なうより、未適用環境で機能全体を止めない方を優先する。
  }

  const subResult = await db.query(
    `SELECT stripe_customer_id FROM stripe_subscriptions
     WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId],
  );

  if (subResult.rows.length === 0) {
    return { status: 'no_subscription', tenantId, billingSyncStatus, billingSyncNeedsAttention };
  }

  const stripeCustomerId = subResult.rows[0].stripe_customer_id as string;

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return { status: 'stripe_not_configured' };
  }

  const stripe = getStripe(stripeSecretKey);

  const [invoices, portalSession] = await Promise.all([
    stripe.invoices.list({ customer: stripeCustomerId, limit: 24 }),
    stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: process.env.BILLING_PORTAL_RETURN_URL ?? 'https://example.com',
    }),
  ]);

  return {
    status: 'ok',
    tenantId,
    customerId: stripeCustomerId,
    portalUrl: portalSession.url,
    billingSyncStatus,
    billingSyncNeedsAttention,
    invoices: invoices.data.map((inv: any) => ({
      id: inv.id,
      status: inv.status,
      status_label: INVOICE_STATUS_LABELS[inv.status as string] ?? inv.status,
      amountDue: inv.amount_due,
      amountPaid: inv.amount_paid,
      currency: inv.currency,
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf ?? null,
      created: inv.created,
    })),
  };
}

// ---------------------------------------------------------------------------
// UX-C(2026-08-26): 込み枠・無料枠の残量可視化。
//
// #1015でStandard/Growthを「基本料+込み枠+超過」にしたが、込み枠の消費量・残量を
// 出す画面が無かった(admin-uiを横断grepしても該当UIゼロ)。上限を設けない従量課金
// 方針([[project_usage_based_billing_no_caps]])のもとでは、「気づいたら大幅超過」を
// 防ぐ唯一の手段がこの表示。free_adの200会話上限も同様(到達すると新規会話が止まる)。
//
// ★HTTPレイヤ(このファイルのルート本体)とチャットエージェント
// (agent/actionExecutor.ts の get_billing_summary)の両方から同じ値を取得できるよう、
// fetchBillingCostBreakdown/fetchBillingInvoices と同じ理由でここに置く★
// ---------------------------------------------------------------------------

export interface BillingQuota {
  plan: string | null;
  /** 集計対象期間(JST暦月)。ISO instant文字列(UTC)。 */
  periodFrom: string;
  periodTo: string;
  text: {
    /** 当月の会話数(生の数量。込み枠差し引き前)。 */
    used: number;
    /** 込み枠(会話数)。null=このプランに込み枠という概念が無い
     *  (starter=純従量/enterprise=無制限/free_ad=別枠で管理/未知プラン)。 */
    included: number | null;
    /** 込み枠を超えた分。included が null なら常に0。 */
    overage: number;
  };
  avatar: {
    usedMinutes: number;
    includedMinutes: number | null;
    overageMinutes: number;
  };
  /** 管理AIへの相談(Copilot UI)。単位は相談件数((session_id, JST暦日)のDISTINCT)。 */
  admin: {
    /** 当月の相談件数(生の数量。込み枠差し引き前)。 */
    used: number;
    /** 込み枠(相談件数)。null=このプランに込み枠という概念が無い。 */
    included: number | null;
    /** 込み枠を超えた分。included が null なら常に0。 */
    overage: number;
  };
  /** free_ad のときだけ非null(月200会話の無料枠)。 */
  freeAd: {
    used: number;
    limit: number;
    remaining: number;
    /** free_ad の管理AI月次上限(FREE_AD_MONTHLY_ADMIN_CONSULT_LIMIT)の当月消費件数。 */
    adminUsed: number;
    /** free_ad の管理AI月次上限。 */
    adminLimit: number;
    /** 上限までの残数。 */
    adminRemaining: number;
  } | null;
}

/**
 * 指定テナントの当月(JST暦月)込み枠消費状況を返す。テナントが存在しなければ null。
 *
 * ★月中のプラン変更は日割りしない(2026-08-26 決定)★
 * 変更後プランの込み枠をJST暦月全体に適用する。アップグレード月は「日割りの
 * 基本料で1か月分の込み枠」になり得るが、意図した非対称(テナント有利側)。
 * .claude/rules/billing.md §7 / subscriptionSync.ts の proration_behavior コメント参照。
 *
 * textUnits/avatarMinutes は computeExpectedBilling(唯一の出どころ)から取る。
 * free_ad の会話数もここから取る — conversation_units の判定(session_idごとに
 * DISTINCT・message_count>=2・billable=true)は countFreeAdBillableConversations
 * (chat/route.ts、free_ad上限のホットパス判定用)と同一なので、表示専用のこの経路で
 * 二重に実装しない(禁止6)。
 */
export async function fetchBillingQuota(db: any, tenantId: string): Promise<BillingQuota | null> {
  const tenantResult = await db.query(`SELECT plan FROM tenants WHERE id = $1`, [tenantId]);
  if (tenantResult.rows.length === 0) return null;
  const plan = tenantResult.rows[0].plan as string | null;

  const { monthStart, monthEnd } = getMonthRangeJst(new Date());
  const periodFrom = monthStart.toISOString();
  const periodTo = monthEnd.toISOString();

  const { textUnits, avatarMinutes, adminConsults } =
    await computeExpectedBilling(db, tenantId, periodFrom, periodTo, plan);

  const included = includedQuotaForPlan(plan);
  const overage = computeQuotaOverage(plan, textUnits, avatarMinutes, adminConsults);

  return {
    plan,
    periodFrom,
    periodTo,
    text: {
      used: textUnits,
      included: included?.textConversations ?? null,
      overage: overage?.textConversations ?? 0,
    },
    avatar: {
      usedMinutes: avatarMinutes,
      includedMinutes: included?.avatarMinutes ?? null,
      overageMinutes: overage?.avatarMinutes ?? 0,
    },
    admin: {
      used: adminConsults,
      included: included?.adminConsults ?? null,
      overage: overage?.adminConsults ?? 0,
    },
    freeAd:
      plan === 'free_ad'
        ? {
            used: textUnits,
            limit: FREE_AD_MONTHLY_CONVERSATION_LIMIT,
            remaining: Math.max(0, FREE_AD_MONTHLY_CONVERSATION_LIMIT - textUnits),
            // free_ad は込み枠(PLAN_INCLUDED_QUOTAS)を持たないため、管理AIの残量は
            // 別枠のFREE_AD_MONTHLY_ADMIN_CONSULT_LIMITで判定する(禁止39)。
            adminUsed: adminConsults,
            adminLimit: FREE_AD_MONTHLY_ADMIN_CONSULT_LIMIT,
            adminRemaining: Math.max(0, FREE_AD_MONTHLY_ADMIN_CONSULT_LIMIT - adminConsults),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// CP-3(GID 1218086647623729): POST /v1/admin/my-tenant/billing/checkout-session の
// 本体。HTTPハンドラ(下記 registerBillingAdminRoutes 内)と start_billing_checkout
// ツール(agent/actionExecutor.ts)の両方がここを直接呼ぶ。
//
// ★冪等性チェック(既存 Customer/Subscription の確認)は必ずこの関数の中に置くこと★
// ここを外して呼び出し元(ツール側)で省略すると、チャット経由の連打・二重送信で
// Stripe Customer/Subscription が複数作られる(= 二重請求)。旧HTTPハンドラが
// 持っていた保護をそのまま移設してあるだけで、ロジックは無変更。
// ---------------------------------------------------------------------------

/** createCheckoutSessionForTenant の戻り値。呼び出し元(HTTPハンドラ)は
 *  そのまま res.status(status).json(body) すればよい形にしてある。 */
export type CheckoutSessionResult = { status: number; body: Record<string, unknown> };

// registerBillingAdminRoutes(下記)は起動時の生pino.Loggerを受け取る一方、
// start_billing_checkoutツール(agent/actionExecutor.ts)は独自ラッパー(lib/logger.ts の
// AppLogger)を渡す。両方を受け取れるよう、subscriptionSync.ts の MinimalLogger と
// 同じ最小形の構造的型にする(pino.Logger/AppLoggerのどちらも自然に満たす)。
interface MinimalLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export async function createCheckoutSessionForTenant(
  db: any,
  logger: MinimalLogger,
  tenantId: string,
  billingCycle: 'monthly' | 'annual',
): Promise<CheckoutSessionResult> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return { status: 500, body: { error: 'stripe_not_configured' } };

  try {
    const tenantRow = await db.query(
      `SELECT id, name, tenant_contact_email, plan FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (tenantRow.rows.length === 0) {
      return { status: 404, body: { error: 'tenant not found' } };
    }
    const tenant = tenantRow.rows[0] as {
      id: string; name: string; tenant_contact_email: string | null; plan: string | null;
    };

    const stripe = getStripe(stripeKey);

    // ★冪等性チェック(この関数の最重要ガード)★
    // ここが無いと、二重クリック・ネットワーク遅延中の再送・「支払い設定へ進む」
    // バナーが古いまま残っている状態での再訪問のいずれでも、テナントごとに
    // 1本のはずの Stripe Customer/Subscription が複数作られうる(= 二重請求)。
    // /billing/onboard(super_admin経路)が同じ理由で existing チェックを持つのと
    // 同じ配慮を、こちらのセルフサービス経路にも適用する。
    //
    // 既にアクティブな契約がある場合は新規 Checkout を作らず、Billing Portal
    // (支払い方法の変更・請求書確認ができる Stripe 保護下の画面)へ誘導する。
    // 呼び出し元は「Checkoutのurl」も「Portalのurl」も同じ `url` フィールドで
    // 受け取り、そのままリダイレクト/案内すればよい(呼び出し元に分岐を持たせない)。
    // is_active を問わず取得する: アクティブなら下でPortalへ誘導、非アクティブ
    // (解約済み等)でも stripe_customer_id は再契約時に使い回し、Checkoutのたびに
    // 新しい Stripe Customer を作らない(2026-08-26 レビュー是正: 別タブの古い
    // Checkoutが後で完了した場合に別Customerが作られる問題を軽減する)。
    const existing = await db.query(
      `SELECT stripe_customer_id, is_active FROM stripe_subscriptions
        WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    const existingCustomerId = existing.rows[0]?.stripe_customer_id as string | undefined;
    if (existing.rows[0]?.is_active === true) {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: existingCustomerId!,
        return_url: process.env.BILLING_PORTAL_RETURN_URL ?? 'https://example.com',
      });
      logger.info(
        { tenantId, plan: tenant.plan },
        '[billingApi] checkout-session: 既にアクティブな契約があるためPortalへ誘導した(新規Checkoutは作らない)'
      );
      return { status: 200, body: { ok: true, url: portalSession.url, alreadyOnboarded: true } };
    }

    // プラン→price は planPricing.ts が唯一の出どころ(禁止6)。
    // オンボード(super_admin)経路と同じ関数を通す。
    const priceResult = getSubscriptionItemPrices(tenant.plan, billingCycle);
    if (!priceResult.ok) {
      if (priceResult.reason === 'plan_not_self_serve') {
        return {
          status: 400,
          body: {
            error: 'plan_not_self_serve',
            detail: tenant.plan === 'enterprise'
              ? 'Enterprise は個別契約です。担当までお問い合わせください。'
              : 'Free(広告表示)プランは請求が発生しないため、お支払い登録は不要です。',
          },
        };
      }
      if (priceResult.reason === 'billing_cycle_not_supported') {
        return {
          status: 400,
          body: {
            error: 'billing_cycle_not_supported',
            detail: tenant.plan === 'starter'
              ? 'Starter は基本料の無い純従量プランのため、年払いを選択できません。'
              : '年払いは現在準備中です。月払いをご利用ください。',
          },
        };
      }
      logger.error(
        { tenantId, plan: tenant.plan, billingCycle, missing: priceResult.missing },
        '[billingApi] checkout-session: price env not configured'
      );
      return { status: 500, body: { error: 'stripe_price_not_configured', missing: priceResult.missing } };
    }

    const returnBase = process.env.BILLING_PORTAL_RETURN_URL ?? 'https://example.com';

    // ★base(基本料・licensed)には quantity:1 を明示、text/avatarOverage(metered)には
    // quantity を付けない★ Stripe Checkout は metered price に quantity を渡すと
    // 拒否する。ここは priceResult.prices の構造(base=licensed、それ以外=metered)を
    // 直接知っているので、toSubscriptionItems() は使わず組み立てる。
    const lineItems = [
      priceResult.prices.base ? { price: priceResult.prices.base, quantity: 1 } : null,
      priceResult.prices.text ? { price: priceResult.prices.text } : null,
      priceResult.prices.avatarOverage ? { price: priceResult.prices.avatarOverage } : null,
    ].filter((item): item is { price: string; quantity?: number } => item !== null);

    // ★冪等キー — 上の existing チェックの TOCTOU を Stripe 側で塞ぐ★
    // existing チェック(SELECT)と本 create の間にロックが無いため、ほぼ同時に
    // 2リクエストが来ると両方が「既存契約なし」を見て、Customer/Subscription が
    // 2本作られうる(= 二重請求)。DBロックで直そうとすると Stripe API 呼び出しを
    // トランザクション内に抱えることになり、Stripe が遅いときに接続を占有する。
    // 「同じ意図のリクエストが複数届く」問題は Stripe の冪等キーが本来の解。
    //
    // ★キーに分単位の時刻を含める理由★
    // テナント固定キーにすると Stripe 側で24時間同じレスポンスが返るため、
    // 「一度Checkoutを離脱して、後で気が変わってやり直す」が丸一日ブロックされる。
    // 分で丸めることで、連打・二重送信(数百ms〜数秒)は同一キーに畳みつつ、
    // 正当なやり直しは次の分から通る。
    const idempotencyWindow = Math.floor(Date.now() / 60_000);
    // Stripe は customer と customer_email の同時指定を拒否するため排他にする。
    // 既知の Customer があれば使い回し(上のコメント参照)、無ければメールから
    // Stripe に解決させる(新規テナントの初回Checkout)。
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : { customer_email: tenant.tenant_contact_email ?? undefined }),
      line_items: lineItems,
      success_url: `${returnBase}?checkout=success`,
      cancel_url: `${returnBase}?checkout=cancelled`,
      metadata: { tenant_id: tenantId, plan: tenant.plan ?? '', billing_cycle: billingCycle },
      subscription_data: {
        metadata: { tenant_id: tenantId, plan: tenant.plan ?? '', billing_cycle: billingCycle },
      },
    }, {
      idempotencyKey: `billing:checkout:${tenantId}:${tenant.plan ?? ''}:${billingCycle}:${idempotencyWindow}`,
    });

    logger.info(
      { tenantId, plan: tenant.plan, billingCycle, sessionId: session.id },
      '[billingApi] tenant created a Checkout session for self-serve billing'
    );
    return { status: 200, body: { ok: true, url: session.url } };
  } catch (err: any) {
    logger.error({ err, tenantId }, '[billingApi] checkout-session creation failed');
    return { status: 500, body: { error: 'Checkoutセッションの作成に失敗しました', detail: String(err?.message ?? err) } };
  }
}

export function registerBillingAdminRoutes(
  app: Application,
  db: any,
  logger: pino.Logger,
  baseMiddleware: RequestHandler[]
): void {
  const mw   = [...baseMiddleware, roleAuthMiddleware, requireRole('super_admin', 'client_admin')];
  const saMw = [...baseMiddleware, roleAuthMiddleware, requireRole('super_admin')];

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/usage
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/usage',
    ...mw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = usageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      const { from, to, group_by } = parsed.data;
      const { tenantId, isSuperAdmin } = resolveTenantId(req);

      if (!isSuperAdmin && !tenantId) {
        res.status(403).json({ error: 'forbidden', message: 'テナント情報が取得できません' });
        return;
      }

      try {
        // Super Admin: テナント横断サマリー
        if (group_by === 'tenant' && isSuperAdmin) {
          const { where, params } = billingWhereClause(tenantId, from, to);
          const result = await db.query(
            `SELECT
               tenant_id,
               COUNT(*)::integer                             AS total_requests,
               COALESCE(SUM(cost_total_cents), 0)::integer  AS cost_total_cents
             FROM usage_logs
             ${where}
             GROUP BY tenant_id
             ORDER BY cost_total_cents DESC`,
            params
          );
          res.json({ group_by: 'tenant', tenants: result.rows });
          return;
        }

        // summaryQueries.ts の fetchAnalyticsTrend と同じ狙いで fetchBillingUsage に集約する。
        const response = await fetchBillingUsage(db, tenantId, from, to);
        res.json(response);
      } catch (err) {
        logger.error({ err, tenantId }, '[billingApi] usage query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/cost-breakdown
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/cost-breakdown',
    ...mw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = breakdownQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      const { from, to } = parsed.data;
      const { tenantId, isSuperAdmin } = resolveTenantId(req);

      if (!isSuperAdmin && !tenantId) {
        res.status(403).json({ error: 'forbidden', message: 'テナント情報が取得できません' });
        return;
      }

      try {
        const response = await fetchBillingCostBreakdown(db, tenantId, from, to);
        res.json(response);
      } catch (err) {
        logger.error({ err, tenantId }, '[billingApi] cost-breakdown query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/economics?period=YYYYMM
  //   テナント横断の採算一覧(売上推計 − API原価)。★super_admin 限定★
  //   原価とマージン倍率が同時に見えるため、テナントには絶対に出さない。
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/economics',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = economicsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      try {
        const response = await fetchTenantEconomics(db, parsed.data.period, fetchTenantBillingSnapshot);
        res.json(response);
      } catch (err) {
        logger.error({ err, period: parsed.data.period }, '[billingApi] economics query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/economics/:tenantId?period=YYYYMM&reconcile=stripe
  //   1テナントの内訳。reconcile=stripe のときだけ実請求と突合する
  //   (一覧では叩かない — テナント数ぶん Stripe を往復することになるため)。
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/economics/:tenantId',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = economicsDetailQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const tenantId = req.params.tenantId;
      if (!tenantId) {
        res.status(400).json({ error: 'invalid_request', message: 'tenantId required' });
        return;
      }
      try {
        const response = await fetchTenantEconomicsDetail(
          db, tenantId, parsed.data.period, fetchTenantBillingSnapshot,
          parsed.data.reconcile === 'stripe' ? fetchPeriodInvoices : null,
        );
        if (!response) {
          res.status(404).json({ error: 'tenant_not_found' });
          return;
        }
        res.json(response);
      } catch (err) {
        logger.error({ err, tenantId }, '[billingApi] economics detail query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/invoices
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/invoices',
    ...mw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = invoicesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      const { tenantId, isSuperAdmin } = resolveTenantId(req);

      if (!isSuperAdmin && !tenantId) {
        res.status(403).json({ error: 'forbidden', message: 'テナント情報が取得できません' });
        return;
      }

      const resolvedTenantId = tenantId ?? '';

      if (!resolvedTenantId) {
        res.json({ tenantId: 'all', status: 'no_subscription', customerId: null, portalUrl: null, invoices: [] });
        return;
      }

      try {
        const result = await fetchBillingInvoices(db, resolvedTenantId);
        if (result.status === 'no_subscription') {
          // PR-7(2026-08-25収益監査): 従来はここで status を落としており、
          // クライアントは portalUrl===null からしか「未登録」を推測できなかった
          // (「未登録」と「登録済みだが偶然0件」を同じ値で表現しない — CLAUDE.md 禁止20)。
          // admin-ui はこの status を見て「支払い方法を登録する」導線(onboard呼び出し)を出す。
          res.json({
            tenantId: resolvedTenantId,
            status: 'no_subscription',
            customerId: null,
            portalUrl: null,
            invoices: [],
            billingSyncStatus: result.billingSyncStatus,
            billingSyncNeedsAttention: result.billingSyncNeedsAttention,
          });
          return;
        }
        if (result.status === 'stripe_not_configured') {
          res.status(500).json({ error: 'stripe_not_configured' });
          return;
        }
        res.json({
          tenantId: result.tenantId,
          status: 'ok',
          customerId: result.customerId,
          portalUrl: result.portalUrl,
          invoices: result.invoices,
          billingSyncStatus: result.billingSyncStatus,
          billingSyncNeedsAttention: result.billingSyncNeedsAttention,
        });
      } catch (err) {
        logger.error({ err, tenantId: resolvedTenantId }, '[billingApi] invoices query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/quota  (UX-C: 込み枠・無料枠の残量可視化)
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/quota',
    ...mw,
    async (req: Request, res: Response): Promise<void> => {
      const { tenantId, isSuperAdmin } = resolveTenantId(req);

      // 込み枠は「1テナントの当月消費」という単位でしか意味を持たない
      // (横断ビューという概念が無い)。super_admin もテナント未指定なら400。
      if (!tenantId) {
        res.status(isSuperAdmin ? 400 : 403).json({
          error: isSuperAdmin ? 'tenantId_required' : 'forbidden',
          message: isSuperAdmin ? 'tenantId を指定してください' : 'テナント情報が取得できません',
        });
        return;
      }

      try {
        const quota = await fetchBillingQuota(db, tenantId);
        if (!quota) {
          res.status(404).json({ error: 'tenant_not_found' });
          return;
        }
        res.json({ tenantId, ...quota });
      } catch (err) {
        logger.error({ err, tenantId }, '[billingApi] quota query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // POST /v1/admin/my-tenant/billing/checkout-session  (client_admin)
  //
  // UX-A(2026-08-26 UI/UX棚卸し): テナント自身が有料プランへ変更しても、
  // カード登録の導線が存在しなかった(super_admin限定の /billing/onboard しか無い)。
  // 基本料ありのプラン(Standard/Growth)は subscriptions.create が即座に課金を試みるため、
  // カード未登録のまま作ると subscription が incomplete で止まる。Stripe Checkout
  // (mode: subscription)ならカード入力と3DS認証をStripe側に丸ごと任せられる。
  //
  // ★このエンドポイントは Customer/Subscription を作らない★
  // Checkout セッションを作って戻り先の URL を返すだけ。実際の顧客・サブスク作成は
  // Stripe が Checkout 完了時に行い、stripeWebhook.ts の checkout.session.completed
  // で記録する(セッション作成レスポンスの時点ではまだカード入力前で確定していない)。
  //
  // 認可(super_admin除外)・Zodパースはここに残し、本体は createCheckoutSessionForTenant
  // (このファイル内、下記でexport)に切り出してある。CP-3(GID 1218086647623729)の
  // start_billing_checkout ツール(agent/actionExecutor.ts)もこの関数を直接呼ぶ
  // (HTTPで自分自身のエンドポイントを叩かない。冪等性チェックを2箇所に書き写さない)。
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/v1/admin/my-tenant/billing/checkout-session',
    ...mw,
    async (req: Request, res: Response): Promise<void> => {
      const { tenantId, isSuperAdmin } = resolveTenantId(req);
      // super_admin は集約ビューで特定テナントに紐付かないため対象外。
      // 個別テナントのカード登録を代行したい場合は /billing/onboard を使う。
      if (isSuperAdmin || !tenantId) {
        res.status(403).json({ error: 'forbidden', message: 'この操作はテナント管理者のみ実行できます' });
        return;
      }

      const parsed = onboardSchema.pick({ billingCycle: true }).safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { billingCycle } = parsed.data;

      const result = await createCheckoutSessionForTenant(db, logger, tenantId, billingCycle);
      res.status(result.status).json(result.body);
    }
  );

  // ──────────────────────────────────────────────────────────────
  // POST /v1/admin/billing/onboard  (super_admin)
  //
  // PR-7(2026-08-25収益監査): リポジトリ全体に customers.create / subscriptions.create /
  // checkout.sessions が1件も存在せず、stripe_subscriptions は手動投入の2行のみだった。
  // サブスク行が無いテナントはポータルボタンすら表示されず、決済手段登録に到達不能だった
  // (CLAUDE.md 禁止44「押せるのに何も起きないUIを置く」の一段手前=導線自体が無い状態)。
  // ここでは Customer + metered Subscription を作成し stripe_subscriptions へ記録する。
  // テナント自身によるセルフサービス化は本エンドポイントのスコープ外(super_admin限定)。
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/v1/admin/billing/onboard',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = onboardSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { tenantId, billingCycle } = parsed.data;

      try {
        // 冪等性: 既にアクティブなサブスクがあれば新しい Customer/Subscription を
        // Stripe側に重複作成しない(DB側のON CONFLICTだけでは「Stripe APIを呼ばない」
        // ことまでは守れないため、ここで明示的に先にチェックする)。
        const existing = await db.query(
          `SELECT stripe_subscription_id, stripe_customer_id FROM stripe_subscriptions
           WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId]
        );
        if (existing.rows.length > 0) {
          res.json({
            ok: true,
            alreadyOnboarded: true,
            subscriptionId: existing.rows[0].stripe_subscription_id,
            customerId: existing.rows[0].stripe_customer_id,
          });
          return;
        }

        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) { res.status(500).json({ error: 'stripe_not_configured' }); return; }

        // プランは items 構成を決めるために必要(基本料の有無・込み枠の有無・
        // 超過単価がプランごとに別の price として実在する)。
        const tenantRow = await db.query(
          `SELECT id, name, tenant_contact_email, plan FROM tenants WHERE id = $1`,
          [tenantId]
        );
        if (tenantRow.rows.length === 0) {
          res.status(404).json({ error: 'tenant not found' });
          return;
        }
        const tenant = tenantRow.rows[0] as {
          id: string; name: string; tenant_contact_email: string | null; plan: string | null;
        };

        // プラン→price の対応は planPricing.ts が唯一の出どころ。ここと stripeSync.ts に
        // 別々に書くと「作った item と使用量の送り先が食い違う」事故になる(禁止6)。
        const priceResult = getSubscriptionItemPrices(tenant.plan, billingCycle);
        if (!priceResult.ok) {
          if (priceResult.reason === 'plan_not_self_serve') {
            // free_ad は倍率0で請求が発生しない。enterprise は個別交渉のため
            // Stripe ダッシュボードで人が組む(自動化すると交渉内容と食い違ったまま請求が走る)。
            res.status(400).json({
              error: 'plan_not_self_serve',
              detail: tenant.plan === 'enterprise'
                ? 'Enterprise は個別契約です。Stripe ダッシュボードで手動でサブスクリプションを作成してください。'
                : 'Free(広告表示)プランは請求が発生しないため、Stripeへの登録は不要です。',
            });
            return;
          }
          if (priceResult.reason === 'billing_cycle_not_supported') {
            res.status(400).json({
              error: 'billing_cycle_not_supported',
              detail: tenant.plan === 'starter'
                ? 'Starter は基本料の無い純従量プランのため、年払いを選択できません。'
                : '年払いは現在準備中です。月払いをご利用ください。',
            });
            return;
          }
          logger.error(
            { tenantId, plan: tenant.plan, billingCycle, missing: priceResult.missing },
            '[billingApi] price env not configured — オンボーディングを中止した'
          );
          res.status(500).json({ error: 'stripe_price_not_configured', missing: priceResult.missing });
          return;
        }
        const prices = priceResult.prices;

        // 旧 STRIPE_METERED_PRICE_ID は全プラン共通の ¥10 プレースホルダ price。
        // Starter 専用 price が未設定だとそこへフォールバックするため、
        // 「確定価格 ¥20/会話 ではない単価で請求が始まる」ことを黙って通さない。
        if (!process.env.STRIPE_PRICE_STARTER_TEXT && prices.text === process.env.STRIPE_METERED_PRICE_ID) {
          logger.error(
            { tenantId, plan: tenant.plan },
            '[billingApi] STRIPE_PRICE_STARTER_TEXT が未設定のため旧 STRIPE_METERED_PRICE_ID で作成した — ' +
            '確定価格(¥20/会話)ではない単価で請求される。至急 env を設定して作り直すこと'
          );
        }

        const stripe = getStripe(stripeKey);
        const customer = await stripe.customers.create({
          name: tenant.name,
          email: tenant.tenant_contact_email ?? undefined,
          metadata: { tenant_id: tenantId },
        });

        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: toSubscriptionItems(prices),
          metadata: { tenant_id: tenantId, plan: tenant.plan ?? '', billing_cycle: billingCycle },
        });

        // ★stripe_price_id は単数列のまま、基本料(無ければテキスト従量)の price を入れる★
        // standard/growth は3 item 構成になるが、この列を読む側(fetchBillingInvoices 等)は
        // item 単位の粒度を必要としておらず、「そのテナントのプランを代表する price」が
        // 分かれば足りる。item 一覧を持つ子テーブルを足すのは、この列の実際の読まれ方に対して
        // 過剰な機構になるため本PRでは作らない。真の item 構成は Stripe 側が保持しており、
        // stripeSync.ts は subscription を retrieve して price→item を引き直す
        // (DBのキャッシュを信じないので、ここが単数でも請求の宛先は取り違えない)。
        const representativePriceId = prices.base ?? prices.text;

        // tenant_id が PRIMARY KEY のため、過去に解約済み(is_active=false)の行が
        // 残っているケースの再オンボーディングも ON CONFLICT で受ける。
        // 解約と再オンボーディングの間に tenants.plan が変わっていても、items は
        // 上で「現在の」プランから引き直しているので、古いプランの構成を引き継がない。
        await db.query(
          `INSERT INTO stripe_subscriptions
             (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, is_active)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (tenant_id) DO UPDATE SET
             stripe_customer_id     = EXCLUDED.stripe_customer_id,
             stripe_subscription_id = EXCLUDED.stripe_subscription_id,
             stripe_price_id        = EXCLUDED.stripe_price_id,
             is_active               = true,
             updated_at              = NOW()`,
          [tenantId, customer.id, subscription.id, representativePriceId]
        );

        logger.info(
          { tenantId, plan: tenant.plan, billingCycle, subscriptionId: subscription.id,
            customerId: customer.id, itemCount: toSubscriptionItems(prices).length },
          '[billingApi] tenant onboarded to Stripe'
        );
        res.json({ ok: true, alreadyOnboarded: false, subscriptionId: subscription.id, customerId: customer.id });
      } catch (err: any) {
        logger.error({ err, tenantId }, '[billingApi] onboard failed');
        res.status(500).json({ error: 'Stripeオンボーディングに失敗しました', detail: String(err?.message ?? err) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // POST /v1/admin/billing/retry-invoice  (super_admin)
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/v1/admin/billing/retry-invoice',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = retryInvoiceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { invoiceId } = parsed.data;
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) { res.status(500).json({ error: 'stripe_not_configured' }); return; }
      try {
        const stripe = getStripe(stripeKey);
        const invoice = await stripe.invoices.pay(invoiceId) as unknown;
        res.json({ ok: true, invoice });
      } catch (err: any) {
        logger.warn({ err, invoiceId }, '[billingApi] retry-invoice failed');
        res.status(400).json({ error: 'Re-payment failed', detail: String(err?.message ?? err) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // POST /v1/admin/billing/adjust  (super_admin)
  // ──────────────────────────────────────────────────────────────
  app.post(
    '/v1/admin/billing/adjust',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = adjustSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { tenantId, amount, reason } = parsed.data;

      try {
        const subResult = await db.query(
          `SELECT stripe_customer_id FROM stripe_subscriptions
           WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId]
        );
        if (subResult.rows.length === 0) {
          res.status(404).json({ error: 'アクティブなサブスクリプションが見つかりません' });
          return;
        }
        const customerId = subResult.rows[0].stripe_customer_id as string;

        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) { res.status(500).json({ error: 'stripe_not_configured' }); return; }

        const stripe = getStripe(stripeKey);
        // JPY は最小単位が1円なのでそのまま渡す
        await stripe.invoiceItems.create({
          customer:    customerId,
          amount,
          currency:    'jpy',
          description: reason,
        });

        const user = (req as any).user as { email?: string; tenantId?: string } | undefined;
        const adjustedBy = user?.email ?? user?.tenantId ?? 'admin';

        await db.query(
          `INSERT INTO billing_adjustments (tenant_id, amount, reason, adjusted_by)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, amount, reason, adjustedBy]
        );

        res.json({ ok: true });
      } catch (err: any) {
        logger.warn({ err, tenantId }, '[billingApi] adjust failed');
        res.status(500).json({ error: '金額調整に失敗しました', detail: String(err?.message ?? err) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // PUT /v1/admin/billing/free-period  (super_admin)
  // ──────────────────────────────────────────────────────────────
  app.put(
    '/v1/admin/billing/free-period',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = freePeriodSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { tenantId, freeFrom, freeUntil } = parsed.data;
      try {
        await db.query(
          `UPDATE tenants SET billing_free_from = $1, billing_free_until = $2, updated_at = NOW()
           WHERE id = $3`,
          [freeFrom ?? null, freeUntil ?? null, tenantId]
        );
        res.json({ ok: true });
      } catch (err) {
        logger.warn({ err, tenantId }, '[billingApi] free-period update failed');
        res.status(500).json({ error: '無料期間の設定に失敗しました' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // PUT /v1/admin/billing/toggle-service  (super_admin)
  // ──────────────────────────────────────────────────────────────
  app.put(
    '/v1/admin/billing/toggle-service',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = toggleServiceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { tenantId, action } = parsed.data;
      const isActive = action === 'resume';

      try {
        await db.query(
          `UPDATE tenants SET is_active = $1, updated_at = NOW() WHERE id = $2`,
          [isActive, tenantId]
        );

        // Stripe サブスクリプションの一時停止/再開
        const subResult = await db.query(
          `SELECT stripe_subscription_id FROM stripe_subscriptions
           WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId]
        );

        if (subResult.rows.length > 0) {
          const stripeKey = process.env.STRIPE_SECRET_KEY;
          if (stripeKey) {
            const stripe = getStripe(stripeKey);
            const subId = subResult.rows[0].stripe_subscription_id as string;
            if (action === 'pause') {
              await stripe.subscriptions.update(subId, {
                pause_collection: { behavior: 'void' },
              });
            } else {
              // resume: pause_collection を解除
              await stripe.subscriptions.update(subId, {
                pause_collection: '' as any,
              });
            }
          }
        }

        res.json({ ok: true, is_active: isActive });
      } catch (err) {
        logger.warn({ err, tenantId, action }, '[billingApi] toggle-service failed');
        res.status(500).json({ error: 'サービスの停止/再開に失敗しました' });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/adjustments  (super_admin)
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/adjustments',
    ...saMw,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = adjustmentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }
      const { tenantId } = parsed.data;
      try {
        const result = await db.query(
          `SELECT id, amount, reason, adjusted_by, created_at
           FROM billing_adjustments
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 50`,
          [tenantId]
        );
        res.json({ items: result.rows, total: result.rows.length });
      } catch (err) {
        logger.warn({ err, tenantId }, '[billingApi] adjustments query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );
}
