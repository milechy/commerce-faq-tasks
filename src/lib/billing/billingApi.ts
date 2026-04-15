// src/lib/billing/billingApi.ts
// Phase32 + Phase54: 課金管理API

import type pino from 'pino';
import type { Application, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { roleAuthMiddleware, requireRole } from '../../api/middleware/roleAuth';

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

function getStripe(secretKey: string): any {
  const Stripe = require('stripe');
  return new Stripe(secretKey, { apiVersion: '2024-06-20' });
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

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Super Admin: テナント横断サマリー
        if (group_by === 'tenant' && isSuperAdmin) {
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

        // 日次集計
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
          params
        );

        // 月次集計
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
          params
        );

        res.json({
          tenantId: tenantId ?? 'all',
          daily:    dailyResult.rows,
          monthly:  monthlyResult.rows,
        });
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

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
          params
        );

        const LABELS: Record<string, string> = {
          chat:   'AI応答',
          avatar: 'アバター映像',
          voice:  '音声合成',
        };

        const totalCents = result.rows.reduce(
          (s: number, r: Record<string, unknown>) => s + Number(r['total_cents']),
          0
        );

        const breakdown: Record<
          string,
          { label: string; cost_yen: number; request_count: number; percentage: number }
        > = {};

        for (const row of result.rows) {
          const feature = row.feature_used as string;
          breakdown[feature] = {
            label:         LABELS[feature] ?? feature,
            cost_yen:      Math.round(Number(row.total_cents) / 100),
            request_count: Number(row.request_count),
            percentage:    totalCents > 0
              ? Math.round((Number(row.total_cents) / totalCents) * 100)
              : 0,
          };
        }

        res.json({
          tenantId:  tenantId ?? 'all',
          total_yen: Math.round(totalCents / 100),
          breakdown,
        });
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
        res.json({ tenantId: 'all', customerId: null, portalUrl: null, invoices: [] });
        return;
      }

      try {
        const subResult = await db.query(
          `SELECT stripe_customer_id FROM stripe_subscriptions
           WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [resolvedTenantId]
        );

        if (subResult.rows.length === 0) {
          res.json({ tenantId: resolvedTenantId, customerId: null, portalUrl: null, invoices: [] });
          return;
        }

        const stripeCustomerId = subResult.rows[0].stripe_customer_id as string;

        const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeSecretKey) {
          res.status(500).json({ error: 'stripe_not_configured' });
          return;
        }

        const Stripe = require('stripe');
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-06-20' });

        const [invoices, portalSession] = await Promise.all([
          stripe.invoices.list({ customer: stripeCustomerId, limit: 24 }),
          stripe.billingPortal.sessions.create({
            customer:   stripeCustomerId,
            return_url: process.env.BILLING_PORTAL_RETURN_URL ?? 'https://example.com',
          }),
        ]);

        const STATUS_LABELS: Record<string, string> = {
          paid:  'お支払い済み',
          open:  '未払い',
          draft: '下書き',
          void:  '無効',
        };

        res.json({
          tenantId:    resolvedTenantId,
          customerId:  stripeCustomerId,
          portalUrl:   portalSession.url,
          invoices:    invoices.data.map((inv: any) => ({
            id:               inv.id,
            status:           inv.status,
            status_label:     STATUS_LABELS[inv.status as string] ?? inv.status,
            amountDue:        inv.amount_due,
            amountPaid:       inv.amount_paid,
            currency:         inv.currency,
            periodStart:      inv.period_start,
            periodEnd:        inv.period_end,
            hostedInvoiceUrl: inv.hosted_invoice_url,
            invoicePdf:       inv.invoice_pdf ?? null,
            created:          inv.created,
          })),
        });
      } catch (err) {
        logger.error({ err, tenantId: resolvedTenantId }, '[billingApi] invoices query failed');
        res.status(500).json({ error: 'internal_error' });
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
