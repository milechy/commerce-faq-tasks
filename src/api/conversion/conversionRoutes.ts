// src/api/conversion/conversionRoutes.ts
// Phase58: コンバージョン帰属分析API
//
// POST /api/conversion/attribute       — 帰属記録（Widget/チャット用, x-api-key）
// GET  /v1/admin/conversion/attributions — 管理一覧（JWT）
// GET  /v1/admin/conversion/effectiveness — 心理原則効果ランキング（JWT）

import type { Express, Request, Response } from 'express';
// @ts-ignore
import type { Pool } from 'pg';
import { z } from 'zod';
import { supabaseAuthMiddleware } from '../../admin/http/supabaseAuthMiddleware';
import { roleAuthMiddleware, requireRole } from '../middleware/roleAuth';
import type { AuthenticatedUser } from '../middleware/roleAuth';

const VALID_CONVERSION_TYPES = ['purchase', 'inquiry', 'reservation', 'signup', 'other'] as const;

const AttributionSchema = z.object({
  session_id: z.string().uuid().optional(),
  visitor_id: z.string().max(128).optional(),
  conversion_type: z.enum(VALID_CONVERSION_TYPES),
  conversion_value: z.number().optional(),
  psychology_principle_used: z.array(z.string()).max(10).optional().default([]),
  trigger_type: z.string().max(64).optional(),
  trigger_rule_id: z.number().int().optional(),
  temp_score_at_conversion: z.number().int().min(0).max(100).optional(),
  sales_stage_at_conversion: z.string().max(64).optional(),
  message_count: z.number().int().min(0).optional(),
  session_duration_sec: z.number().int().min(0).optional(),
});

const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

const ADMIN_AUTH = [supabaseAuthMiddleware, roleAuthMiddleware, requireRole('super_admin', 'client_admin')];

export function registerConversionRoutes(
  app: Express,
  apiStack: any[],
  db: Pool | null,
): void {
  // ----------------------------------------------------------------
  // POST /api/conversion/attribute (x-api-key認証)
  // ----------------------------------------------------------------
  app.post('/api/conversion/attribute', ...apiStack, async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const tenantId: string = (req as any).tenantId ?? '';
    if (!tenantId) return res.status(401).json({ error: 'tenant_not_found' });

    const parsed = AttributionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    const d = parsed.data;
    try {
      await db.query(
        `INSERT INTO conversion_attributions
           (tenant_id, session_id, psychology_principle_used, trigger_type, trigger_rule_id,
            temp_score_at_conversion, conversion_type, conversion_value,
            sales_stage_at_conversion, message_count, session_duration_sec)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          tenantId,
          d.session_id ?? null,
          d.psychology_principle_used,
          d.trigger_type ?? null,
          d.trigger_rule_id ?? null,
          d.temp_score_at_conversion ?? null,
          d.conversion_type,
          d.conversion_value ?? null,
          d.sales_stage_at_conversion ?? null,
          d.message_count ?? null,
          d.session_duration_sec ?? null,
        ],
      );
      return res.status(202).json({ accepted: true });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ----------------------------------------------------------------
  // Admin routes
  // ----------------------------------------------------------------
  app.use('/v1/admin/conversion', ...ADMIN_AUTH);

  // GET /v1/admin/conversion/attributions
  app.get('/v1/admin/conversion/attributions', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as any).user as AuthenticatedUser;
    const queryTenantId = req.query['tenant_id'] as string | undefined;

    if (user.role === 'client_admin' && queryTenantId && queryTenantId !== user.tenantId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const tenantId = user.role === 'super_admin' ? (queryTenantId ?? null) : user.tenantId;

    const period = (req.query['period'] as string | undefined) ?? '30d';
    const days = PERIOD_DAYS[period] ?? 30;

    try {
      const params: unknown[] = [days];
      const tenantClause = tenantId ? `AND tenant_id = $${params.push(tenantId)}` : '';

      const [listResult, summaryResult] = await Promise.all([
        db.query(
          `SELECT id, tenant_id, session_id, conversion_type, conversion_value,
                  psychology_principle_used, trigger_type, temp_score_at_conversion,
                  sales_stage_at_conversion, message_count, session_duration_sec, created_at
           FROM conversion_attributions
           WHERE created_at >= NOW() - INTERVAL '1 day' * $1 ${tenantClause}
           ORDER BY created_at DESC
           LIMIT 200`,
          params,
        ),
        db.query(
          `SELECT
             COUNT(*) AS total,
             ROUND(AVG(temp_score_at_conversion)::numeric, 1) AS avg_temp_score,
             conversion_type,
             COUNT(*) AS type_count
           FROM conversion_attributions
           WHERE created_at >= NOW() - INTERVAL '1 day' * $1 ${tenantClause}
           GROUP BY conversion_type`,
          params,
        ),
      ]);

      const byType: Record<string, number> = {};
      let total = 0;
      let avgTempScore: number | null = null;

      for (const row of summaryResult.rows) {
        byType[row.conversion_type] = Number(row.type_count);
        total += Number(row.type_count);
        if (avgTempScore === null) avgTempScore = Number(row.avg_temp_score ?? 0);
      }

      // 心理原則別集計
      const principleResult = await db.query(
        `SELECT unnest(psychology_principle_used) AS principle, COUNT(*) AS cnt
         FROM conversion_attributions
         WHERE created_at >= NOW() - INTERVAL '1 day' * $1 ${tenantClause}
           AND array_length(psychology_principle_used, 1) > 0
         GROUP BY principle
         ORDER BY cnt DESC
         LIMIT 5`,
        params,
      );
      const byPrinciple: Record<string, number> = {};
      for (const row of principleResult.rows) {
        byPrinciple[row.principle] = Number(row.cnt);
      }

      return res.json({
        attributions: listResult.rows,
        summary: {
          total,
          by_type: byType,
          by_principle: byPrinciple,
          avg_temp_score: avgTempScore ?? 0,
        },
      });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /v1/admin/conversion/effectiveness
  app.get('/v1/admin/conversion/effectiveness', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as any).user as AuthenticatedUser;
    const queryTenantId = req.query['tenant_id'] as string | undefined;

    if (user.role === 'client_admin' && queryTenantId && queryTenantId !== user.tenantId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const tenantId = user.role === 'super_admin' ? (queryTenantId ?? null) : user.tenantId;

    const period = (req.query['period'] as string | undefined) ?? '30d';
    const days = PERIOD_DAYS[period] ?? 30;

    try {
      const params: unknown[] = [days];
      const tenantClause = tenantId ? `AND tenant_id = $${params.push(tenantId)}` : '';

      const result = await db.query(
        `SELECT
           unnest(psychology_principle_used) AS principle,
           COUNT(*) AS count,
           ROUND(AVG(temp_score_at_conversion)::numeric, 1) AS avg_temp_score
         FROM conversion_attributions
         WHERE created_at >= NOW() - INTERVAL '1 day' * $1 ${tenantClause}
           AND array_length(psychology_principle_used, 1) > 0
         GROUP BY principle
         ORDER BY count DESC
         LIMIT 10`,
        params,
      );

      const rankings = result.rows.map((row: any) => ({
        principle: row.principle,
        count: Number(row.count),
        avg_temp_score: Number(row.avg_temp_score ?? 0),
      }));

      return res.json({ rankings, period, tenant_id: tenantId });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
