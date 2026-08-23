// src/api/conversion/abTestRoutes.ts
// Phase58: A/Bテスト CRUD API + 結果集計
//
// GET    /v1/admin/ab/experiments
// POST   /v1/admin/ab/experiments
// PUT    /v1/admin/ab/experiments/:id
// PATCH  /v1/admin/ab/experiments/:id/status
// GET    /v1/admin/ab/experiments/:id/results

import type { Express, Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { supabaseAuthMiddleware } from '../../admin/http/supabaseAuthMiddleware';
import { roleAuthMiddleware, requireRole } from '../middleware/roleAuth';
import type { AuthenticatedUser, AuthedReq } from '../middleware/roleAuth';
import { planHasFeature, queryTenantPlan } from '../../lib/billing/planFeatures';
import { reconcileAbResultOutcomes } from './abResultsOutcomeSync';

/**
 * GID: LP料金表(Growth〜: CV計測)に基づくplan制限。
 * client_adminのみ対象（super_adminの集約/横断ビューは対象外）。
 * db可用性チェックの後に呼ぶこと（DB障害時に503を403で覆い隠さないため）。
 * 許可されなければ403を返し、呼び出し元は即returnすること。
 */
async function checkAbTestPlanAccess(
  db: Pool,
  res: Response,
  user: AuthenticatedUser,
): Promise<boolean> {
  if (user.role === 'super_admin') return true;
  const plan = await queryTenantPlan(db, user.tenantId ?? "");
  if (planHasFeature(plan, "conversion")) return true;
  res.status(403).json({
    error: "plan_upgrade_required",
    message: "CV計測はGrowthプラン以上でご利用いただけます",
  });
  return false;
}

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
    if (!(await checkAbTestPlanAccess(db, res, user))) return;
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
      const existing = await db.query(
        'SELECT tenant_id, min_sample_size FROM ab_experiments WHERE id=$1',
        [id],
      );
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const minSampleSize = Number(existing.rows[0].min_sample_size);

      // GID 1216978855735482: 成果(継続率/CV)をchat_sessionsと突合して反映してから集計する。
      // best-effort — 突合が失敗しても、その時点のab_results状態で集計は続行する。
      try {
        await reconcileAbResultOutcomes(db, id, existing.rows[0].tenant_id);
      } catch {
        // noop — 集計は続行
      }

      const result = await db.query(
        `SELECT
           variant,
           COUNT(*) AS exposed,
           COUNT(*) FILTER (WHERE reached_two_plus_exchanges) AS reached_two_plus,
           COUNT(*) FILTER (WHERE converted) AS converted,
           ROUND(AVG(judge_score)::numeric, 1) AS avg_judge_score
         FROM ab_results
         WHERE experiment_id = $1
         GROUP BY variant`,
        [id],
      );

      const byVariant: Record<string, {
        exposed: number;
        // GID 1216978855735482: 主要指標。2往復以上に進んだセッションの割合。
        reached_two_plus: number;
        reached_two_plus_rate: number;
        // 副次指標（記録のみ・判定には使わない）
        converted: number;
        conversion_rate: number;
        avg_judge_score: number | null;
      }> = {};
      let totalExposed = 0;
      for (const row of result.rows) {
        const exposed = Number(row.exposed);
        const reachedTwoPlus = Number(row.reached_two_plus);
        const converted = Number(row.converted);
        totalExposed += exposed;
        byVariant[row.variant] = {
          exposed,
          reached_two_plus: reachedTwoPlus,
          reached_two_plus_rate: exposed > 0 ? Math.round((reachedTwoPlus / exposed) * 1000) / 10 : 0,
          converted,
          conversion_rate: exposed > 0 ? Math.round((converted / exposed) * 1000) / 10 : 0,
          avg_judge_score: row.avg_judge_score !== null ? Number(row.avg_judge_score) : null,
        };
      }

      // GID 1216978855735482: peeking(覗き見)によるfalse positive防止。
      // min_sample_size未到達の間は reliable=false とし、意思決定に使わないよう警告する。
      // 生の件数自体は隠さない（テナント自身のデータであり透明性を優先する）。
      const reliable = totalExposed >= minSampleSize;

      return res.json({
        experiment_id: id,
        min_sample_size: minSampleSize,
        total_exposed: totalExposed,
        reliable,
        ...(reliable
          ? {}
          : {
              warning:
                `サンプルサイズが min_sample_size(${minSampleSize}) に未到達です` +
                `（現在 ${totalExposed} 件）。この結果を意思決定に使わないでください。`,
            }),
        variants: byVariant,
      });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
