// src/lib/billing/billingApi.ts
// Phase32: 課金管理API

import type pino from 'pino';
import { z } from 'zod';

const usageQuerySchema = z.object({
  tenantId: z.string().min(1),
  from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const invoicesQuerySchema = z.object({
  tenantId: z.string().min(1),
});

/**
 * 課金管理APIルートを登録する。
 *
 * - GET /v1/admin/billing/usage   — テナント別使用量集計
 * - GET /v1/admin/billing/invoices — Stripe Invoice一覧
 */
export function registerBillingAdminRoutes(
  app: any,
  db: any,
  logger: pino.Logger,
  adminMiddleware: any[]
): void {
  // GET /v1/admin/billing/usage?tenantId=xxx&from=2026-03-01&to=2026-03-31
  app.get(
    '/v1/admin/billing/usage',
    ...adminMiddleware,
    async (req: any, res: any): Promise<void> => {
      const parsed = usageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      const { tenantId, from, to } = parsed.data;

      try {
        // 日次集計
        const dailyResult = await db.query(
          `SELECT
             DATE(created_at)                              AS date,
             COUNT(*)::integer                             AS total_requests,
             COUNT(*) FILTER (WHERE feature_used = 'chat')::integer   AS dialog_requests,
             COUNT(*) FILTER (WHERE feature_used = 'voice')::integer  AS search_requests,
             COALESCE(SUM(cost_llm_cents),   0)::integer  AS cost_llm_cents,
             COALESCE(SUM(cost_total_cents), 0)::integer  AS cost_total_cents,
             billing_status
           FROM usage_logs
           WHERE tenant_id = $1
             ${from ? 'AND created_at >= $2' : ''}
             ${to   ? `AND created_at <  $${from ? 3 : 2}` : ''}
           GROUP BY DATE(created_at), billing_status
           ORDER BY DATE(created_at) DESC`,
          [tenantId, ...(from ? [from] : []), ...(to ? [to] : [])]
        );

        // 月次集計
        const monthlyResult = await db.query(
          `SELECT
             TO_CHAR(created_at, 'YYYY-MM')               AS month,
             COUNT(*)::integer                             AS total_requests,
             COUNT(*) FILTER (WHERE feature_used = 'chat')::integer   AS dialog_requests,
             COUNT(*) FILTER (WHERE feature_used = 'voice')::integer  AS search_requests,
             COALESCE(SUM(cost_llm_cents),   0)::integer  AS cost_llm_cents,
             COALESCE(SUM(cost_total_cents), 0)::integer  AS cost_total_cents
           FROM usage_logs
           WHERE tenant_id = $1
             ${from ? 'AND created_at >= $2' : ''}
             ${to   ? `AND created_at <  $${from ? 3 : 2}` : ''}
           GROUP BY TO_CHAR(created_at, 'YYYY-MM')
           ORDER BY month DESC`,
          [tenantId, ...(from ? [from] : []), ...(to ? [to] : [])]
        );

        res.json({
          tenantId,
          daily:   dailyResult.rows,
          monthly: monthlyResult.rows,
        });
      } catch (err) {
        logger.error({ err, tenantId }, '[billingApi] usage query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // GET /v1/admin/billing/invoices?tenantId=xxx
  app.get(
    '/v1/admin/billing/invoices',
    ...adminMiddleware,
    async (req: any, res: any): Promise<void> => {
      const parsed = invoicesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      const { tenantId } = parsed.data;

      try {
        // stripe_customer_id を取得
        const subResult = await db.query(
          `SELECT stripe_customer_id FROM stripe_subscriptions
           WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId]
        );

        if (subResult.rows.length === 0) {
          res.status(404).json({ error: 'no_active_subscription', tenantId });
          return;
        }

        const stripeCustomerId = subResult.rows[0].stripe_customer_id as string;

        const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeSecretKey) {
          res.status(500).json({ error: 'stripe_not_configured' });
          return;
        }

        // @ts-ignore — stripe パッケージは backend_deps.md で申請済み
        const Stripe = require('stripe');
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-06-20' });

        const [invoices, portalSession] = await Promise.all([
          stripe.invoices.list({ customer: stripeCustomerId, limit: 24 }),
          stripe.billingPortal.sessions.create({
            customer:   stripeCustomerId,
            return_url: process.env.BILLING_PORTAL_RETURN_URL ?? 'https://example.com',
          }),
        ]);

        res.json({
          tenantId,
          customerId:      stripeCustomerId,
          portalUrl:       portalSession.url,
          invoices:        invoices.data.map((inv: any) => ({
            id:            inv.id,
            status:        inv.status,
            amountDue:     inv.amount_due,
            amountPaid:    inv.amount_paid,
            currency:      inv.currency,
            periodStart:   inv.period_start,
            periodEnd:     inv.period_end,
            hostedInvoiceUrl: inv.hosted_invoice_url,
            created:       inv.created,
          })),
        });
      } catch (err) {
        logger.error({ err, tenantId }, '[billingApi] invoices query failed');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );
}
