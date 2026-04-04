// src/lib/billing/billingApi.ts
// Phase32 + Phase54: 課金管理API

import type pino from 'pino';
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
function resolveTenantId(req: any): { tenantId: string | null; isSuperAdmin: boolean } {
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
export function registerBillingAdminRoutes(
  app: any,
  db: any,
  logger: pino.Logger,
  baseMiddleware: any[]
): void {
  const mw = [...baseMiddleware, roleAuthMiddleware, requireRole('super_admin', 'client_admin')];

  // ──────────────────────────────────────────────────────────────
  // GET /v1/admin/billing/usage
  // ──────────────────────────────────────────────────────────────
  app.get(
    '/v1/admin/billing/usage',
    ...mw,
    async (req: any, res: any): Promise<void> => {
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
    async (req: any, res: any): Promise<void> => {
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
          (s: number, r: any) => s + Number(r.total_cents),
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
    async (req: any, res: any): Promise<void> => {
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

        // @ts-ignore — stripe パッケージは package.json に登録済み
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
}
