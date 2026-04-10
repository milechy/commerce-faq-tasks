// src/api/conversion/abTestRoutes.ts
// Phase58: A/Bテスト CRUD API + 結果集計
//
// GET    /v1/admin/ab/experiments
// POST   /v1/admin/ab/experiments
// PUT    /v1/admin/ab/experiments/:id
// PATCH  /v1/admin/ab/experiments/:id/status
// GET    /v1/admin/ab/experiments/:id/results

import type { Express, Request, Response } from 'express';
// @ts-ignore
import type { Pool } from 'pg';
import { z } from 'zod';
import { supabaseAuthMiddleware } from '../../admin/http/supabaseAuthMiddleware';
import { roleAuthMiddleware, requireRole } from '../middleware/roleAuth';
import type { AuthenticatedUser, AuthedReq } from '../middleware/roleAuth';

const ExperimentSchema = z.object({
  name: z.string().min(1).max(200),
  variant_a: z.record(z.string(), z.unknown()),
  variant_b: z.record(z.string(), z.unknown()),
  traffic_split: z.number().min(0.1).max(0.9).optional().default(0.5),
  min_sample_size: z.number().int().min(10).max(10000).optional().default(100),
  tenant_id: z.string().min(1).optional(),
});

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['running', 'cancelled'],
  running: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const ADMIN_AUTH = [supabaseAuthMiddleware, roleAuthMiddleware, requireRole('super_admin', 'client_admin')];

/** visitor_idの決定的なvariant割り当て（同一IDは常に同じvariant） */
export function assignVariant(visitorId: string, trafficSplit: number): 'a' | 'b' {
  let hash = 0;
  for (let i = 0; i < visitorId.length; i++) {
    hash = (hash * 31 + visitorId.charCodeAt(i)) >>> 0;
  }
  return (hash % 100) / 100 < trafficSplit ? 'a' : 'b';
}

export function registerAbTestRoutes(app: Express, db: Pool | null): void {
  app.use('/v1/admin/ab', ...ADMIN_AUTH);

  // GET /v1/admin/ab/experiments
  app.get('/v1/admin/ab/experiments', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const queryTenantId = req.query['tenant_id'] as string | undefined;

    if (user.role === 'client_admin' && queryTenantId && queryTenantId !== user.tenantId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const tenantId = user.role === 'super_admin' ? (queryTenantId ?? null) : user.tenantId;

    try {
      const params: unknown[] = [];
      const where = tenantId ? `WHERE tenant_id = $${params.push(tenantId)}` : '';
      const result = await db.query(
        `SELECT id, tenant_id, name, variant_a, variant_b, traffic_split, status, min_sample_size, created_at
         FROM ab_experiments ${where}
         ORDER BY created_at DESC`,
        params,
      );
      return res.json({ experiments: result.rows });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // POST /v1/admin/ab/experiments
  app.post('/v1/admin/ab/experiments', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const parsed = ExperimentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    const tenantId = user.role === 'super_admin'
      ? (parsed.data.tenant_id ?? user.tenantId)
      : user.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenant_id_required' });

    if (user.role === 'client_admin' && parsed.data.tenant_id && parsed.data.tenant_id !== user.tenantId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { name, variant_a, variant_b, traffic_split, min_sample_size } = parsed.data;
    try {
      const result = await db.query(
        `INSERT INTO ab_experiments (tenant_id, name, variant_a, variant_b, traffic_split, min_sample_size)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tenantId, name, JSON.stringify(variant_a), JSON.stringify(variant_b), traffic_split, min_sample_size],
      );
      return res.status(201).json({ experiment: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // PUT /v1/admin/ab/experiments/:id
  app.put('/v1/admin/ab/experiments/:id', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

    const parsed = ExperimentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    try {
      const existing = await db.query('SELECT tenant_id, status FROM ab_experiments WHERE id=$1', [id]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (existing.rows[0].status !== 'draft') {
        return res.status(400).json({ error: 'only_draft_editable' });
      }

      const { name, variant_a, variant_b, traffic_split, min_sample_size } = parsed.data;
      const result = await db.query(
        `UPDATE ab_experiments SET name=$1, variant_a=$2, variant_b=$3, traffic_split=$4, min_sample_size=$5
         WHERE id=$6 RETURNING *`,
        [name, JSON.stringify(variant_a), JSON.stringify(variant_b), traffic_split, min_sample_size, id],
      );
      return res.json({ experiment: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // PATCH /v1/admin/ab/experiments/:id/status
  app.patch('/v1/admin/ab/experiments/:id/status', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

    const newStatus = req.body?.status as string | undefined;
    if (!newStatus) return res.status(400).json({ error: 'status_required' });

    try {
      const existing = await db.query('SELECT tenant_id, status FROM ab_experiments WHERE id=$1', [id]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const currentStatus: string = existing.rows[0].status;
      const allowed = STATUS_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(newStatus)) {
        return res.status(400).json({ error: 'invalid_status_transition', from: currentStatus, to: newStatus });
      }

      const result = await db.query(
        'UPDATE ab_experiments SET status=$1 WHERE id=$2 RETURNING *',
        [newStatus, id],
      );
      return res.json({ experiment: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /v1/admin/ab/experiments/:id/results
  app.get('/v1/admin/ab/experiments/:id/results', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

    try {
      const existing = await db.query('SELECT tenant_id FROM ab_experiments WHERE id=$1', [id]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const result = await db.query(
        `SELECT
           variant,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE converted) AS converted,
           ROUND(AVG(judge_score)::numeric, 1) AS avg_judge_score
         FROM ab_results
         WHERE experiment_id = $1
         GROUP BY variant`,
        [id],
      );

      const byVariant: Record<string, { total: number; converted: number; conversion_rate: number; avg_judge_score: number | null }> = {};
      for (const row of result.rows) {
        const total = Number(row.total);
        const converted = Number(row.converted);
        byVariant[row.variant] = {
          total,
          converted,
          conversion_rate: total > 0 ? Math.round((converted / total) * 1000) / 10 : 0,
          avg_judge_score: row.avg_judge_score !== null ? Number(row.avg_judge_score) : null,
        };
      }

      return res.json({ experiment_id: id, variants: byVariant });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
