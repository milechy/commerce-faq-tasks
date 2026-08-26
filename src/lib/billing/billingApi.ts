// src/lib/billing/billingApi.ts
// Phase32 + Phase54: 課金管理API

import type pino from 'pino';
import type { Application, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { roleAuthMiddleware, requireRole } from '../../api/middleware/roleAuth';
import { computeExpectedBilling } from './stripeSync';
import { getSubscriptionItemPrices, toSubscriptionItems } from './planPricing';

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
// 無変換で¥表示していた(禁止48違反 — 原価と請求額は別の数式で、実際にStripeへ
// 請求されるのは billedQuantity(件数×プラン倍率) × Stripe price の実単価)。
// ここでは実単価をキャッシュ付きで取得し、billedQuantity と掛けて「Stripeが
// 実際に計算する金額と同じ数式」の見積りを返す。取得できない場合は0円ではなく
// null(算出不可)を返す — 0円は「今月は無料」に読めてしまうため。
// ---------------------------------------------------------------------------

let meteredPriceCache: { unitAmountJpy: number | null; fetchedAt: number } | null = null;
const METERED_PRICE_CACHE_TTL_MS = 15 * 60 * 1000;

/** テスト専用: モジュールスコープの価格キャッシュをリセットする。 */
export function _resetMeteredPriceCacheForTest(): void {
  meteredPriceCache = null;
}

async function getMeteredUnitPriceJpy(stripe: any): Promise<number | null> {
  const now = Date.now();
  if (meteredPriceCache && now - meteredPriceCache.fetchedAt < METERED_PRICE_CACHE_TTL_MS) {
    return meteredPriceCache.unitAmountJpy;
  }
  const priceId = process.env.STRIPE_METERED_PRICE_ID;
  if (!priceId) {
    meteredPriceCache = { unitAmountJpy: null, fetchedAt: now };
    return null;
  }
  try {
    const price = await stripe.prices.retrieve(priceId);
    // per_unit以外(段階制など)は「件数×単価」の単純計算が成立しないため、
    // 推測せず算出不可に倒す(誤った金額を出すより「出さない」方が禁止10に沿う)。
    const unitAmount =
      price.billing_scheme === 'per_unit' && typeof price.unit_amount === 'number'
        ? price.unit_amount
        : null;
    meteredPriceCache = { unitAmountJpy: unitAmount, fetchedAt: now };
    return unitAmount;
  } catch {
    // Stripe到達不可時はキャッシュを更新せず、今回だけ算出不可を返す(次回再試行)。
    return meteredPriceCache?.unitAmountJpy ?? null;
  }
}

/**
 * 指定テナント・期間について、Stripeが実際に計算する請求額と同じ数式
 * (billedQuantity × 実単価)で見積りを円で返す。以下のいずれかに該当する場合は
 * null(算出不可) — 0円を返すと「今月は無料」に読めてしまうため区別する。
 *   - STRIPE_SECRET_KEY / STRIPE_METERED_PRICE_ID が未設定
 *   - テナントが存在しない
 *   - Stripe price が per_unit 以外(段階制等)
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
  const currentPlan = tenantResult.rows[0].plan as string | null;

  const stripe = getStripe(stripeSecretKey);
  const unitAmountJpy = await getMeteredUnitPriceJpy(stripe);
  if (unitAmountJpy === null) return null;

  const { billedQuantity } = await computeExpectedBilling(db, tenantId, from, to, currentPlan);
  return billedQuantity * unitAmountJpy;
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

  const LABELS: Record<string, string> = {
    chat: 'AI応答',
    avatar: 'アバター映像',
    voice: '音声合成',
  };

  const totalCents = result.rows.reduce(
    (s: number, r: Record<string, unknown>) => s + Number(r['total_cents']),
    0,
  );

  // PR-5: この内訳は機能別の「原価」構成比であり、USD建て(costCalculator.ts)。
  // Stripeは機能別に請求を分けないため実単価ベースには変換できない。
  // 変換なしに¥表示していたのが禁止48違反の一つだったので、正直に$のまま返す。
  const breakdown: Record<string, BillingCostBreakdownItem> = {};
  for (const row of result.rows) {
    const feature = row.feature_used as string;
    breakdown[feature] = {
      label: LABELS[feature] ?? feature,
      cost_usd: Math.round(Number(row.total_cents) / 100),
      request_count: Number(row.request_count),
      percentage: totalCents > 0 ? Math.round((Number(row.total_cents) / totalCents) * 100) : 0,
    };
  }

  return { tenantId: tenantId ?? 'all', total_usd: Math.round(totalCents / 100), breakdown };
}

export type BillingInvoicesResult =
  | {
      status: 'ok';
      tenantId: string;
      customerId: string;
      portalUrl: string;
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
  | { status: 'no_subscription'; tenantId: string }
  | { status: 'stripe_not_configured' };

const INVOICE_STATUS_LABELS: Record<string, string> = {
  paid: 'お支払い済み',
  open: '未払い',
  draft: '下書き',
  void: '無効',
};

export async function fetchBillingInvoices(db: any, tenantId: string): Promise<BillingInvoicesResult> {
  const subResult = await db.query(
    `SELECT stripe_customer_id FROM stripe_subscriptions
     WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId],
  );

  if (subResult.rows.length === 0) {
    return { status: 'no_subscription', tenantId };
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
          res.json({ tenantId: resolvedTenantId, status: 'no_subscription', customerId: null, portalUrl: null, invoices: [] });
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
        });
      } catch (err) {
        logger.error({ err, tenantId: resolvedTenantId }, '[billingApi] invoices query failed');
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

      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) { res.status(500).json({ error: 'stripe_not_configured' }); return; }

      try {
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

        const stripe = getStripe(stripeKey);

        // ★冪等性チェック(このブロックが本エンドポイントの最重要ガード)★
        // ここが無いと、二重クリック・ネットワーク遅延中の再送・「支払い設定へ進む」
        // バナーが古いまま残っている状態での再訪問のいずれでも、テナントごとに
        // 1本のはずの Stripe Customer/Subscription が複数作られうる(= 二重請求)。
        // /billing/onboard(super_admin経路)が同じ理由で existing チェックを持つのと
        // 同じ配慮を、こちらのセルフサービス経路にも適用する。
        //
        // 既にアクティブな契約がある場合は新規 Checkout を作らず、Billing Portal
        // (支払い方法の変更・請求書確認ができる Stripe 保護下の画面)へ誘導する。
        // フロント側は「Checkoutのurl」も「Portalのurl」も同じ `url` フィールドで
        // 受け取り、そのままリダイレクトするだけでよい(呼び出し元に分岐を持たせない)。
        const existing = await db.query(
          `SELECT stripe_customer_id FROM stripe_subscriptions
            WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId]
        );
        if (existing.rows.length > 0) {
          const stripeCustomerId = existing.rows[0].stripe_customer_id as string;
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: process.env.BILLING_PORTAL_RETURN_URL ?? 'https://example.com',
          });
          logger.info(
            { tenantId, plan: tenant.plan },
            '[billingApi] checkout-session: 既にアクティブな契約があるためPortalへ誘導した(新規Checkoutは作らない)'
          );
          res.json({ ok: true, url: portalSession.url, alreadyOnboarded: true });
          return;
        }

        // プラン→price は planPricing.ts が唯一の出どころ(禁止6)。
        // オンボード(super_admin)経路と同じ関数を通す。
        const priceResult = getSubscriptionItemPrices(tenant.plan, billingCycle);
        if (!priceResult.ok) {
          if (priceResult.reason === 'plan_not_self_serve') {
            res.status(400).json({
              error: 'plan_not_self_serve',
              detail: tenant.plan === 'enterprise'
                ? 'Enterprise は個別契約です。担当までお問い合わせください。'
                : 'Free(広告表示)プランは請求が発生しないため、お支払い登録は不要です。',
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
            '[billingApi] checkout-session: price env not configured'
          );
          res.status(500).json({ error: 'stripe_price_not_configured', missing: priceResult.missing });
          return;
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

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer_email: tenant.tenant_contact_email ?? undefined,
          line_items: lineItems,
          success_url: `${returnBase}?checkout=success`,
          cancel_url: `${returnBase}?checkout=cancelled`,
          metadata: { tenant_id: tenantId, plan: tenant.plan ?? '', billing_cycle: billingCycle },
          subscription_data: {
            metadata: { tenant_id: tenantId, plan: tenant.plan ?? '', billing_cycle: billingCycle },
          },
        });

        logger.info(
          { tenantId, plan: tenant.plan, billingCycle, sessionId: session.id },
          '[billingApi] tenant created a Checkout session for self-serve billing'
        );
        res.json({ ok: true, url: session.url });
      } catch (err: any) {
        logger.error({ err, tenantId }, '[billingApi] checkout-session creation failed');
        res.status(500).json({ error: 'Checkoutセッションの作成に失敗しました', detail: String(err?.message ?? err) });
      }
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
