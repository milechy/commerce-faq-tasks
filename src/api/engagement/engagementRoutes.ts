// src/api/engagement/engagementRoutes.ts
// Phase56: プロアクティブエンゲージメント CRUD API + Widget向けAPI
//
// Admin CRUD (JWT認証):
//   GET    /v1/admin/engagement/rules
//   POST   /v1/admin/engagement/rules
//   PUT    /v1/admin/engagement/rules/:id
//   DELETE /v1/admin/engagement/rules/:id
//   PATCH  /v1/admin/engagement/rules/:id/toggle
//
// Widget向け (x-api-key認証):
//   GET /api/engagement/rules

import type { Express, Request, Response, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { supabaseAuthMiddleware } from '../../admin/http/supabaseAuthMiddleware';
import { roleAuthMiddleware, requireRole } from '../middleware/roleAuth';
import type { AuthenticatedUser, AuthedReq } from '../middleware/roleAuth';

const COMMON_FIELDS = {
  message_template: z.string().min(1).max(500),
  is_active: z.boolean().optional().default(true),
  priority: z.number().int().min(0).max(100).optional().default(0),
  tenant_id: z.string().min(1).optional(),
};

// Discriminated union: trigger_type determines which trigger_config is valid
const TriggerRuleSchema = z.discriminatedUnion('trigger_type', [
  z.object({
    trigger_type: z.literal('scroll_depth'),
    trigger_config: z.object({ threshold: z.number().int().min(1).max(100) }).strict(),
    ...COMMON_FIELDS,
  }),
  z.object({
    trigger_type: z.literal('idle_time'),
    trigger_config: z.object({ seconds: z.number().int().min(1).max(3600) }).strict(),
    ...COMMON_FIELDS,
  }),
  z.object({
    trigger_type: z.literal('exit_intent'),
    trigger_config: z.object({}).strict(),
    ...COMMON_FIELDS,
  }),
  z.object({
    trigger_type: z.literal('page_url_match'),
    trigger_config: z.object({
      pattern: z.string().min(1),
      match_type: z.enum(['glob', 'regex']).optional().default('glob'),
    }).strict(),
    ...COMMON_FIELDS,
  }),
]);

const ADMIN_AUTH = [supabaseAuthMiddleware, roleAuthMiddleware, requireRole('super_admin', 'client_admin')];

export function registerEngagementRoutes(app: Express, apiStack: RequestHandler[], db: Pool | null): void {
  // ----------------------------------------------------------------
  // Admin CRUD
  // ----------------------------------------------------------------
  app.use('/v1/admin/engagement', ...ADMIN_AUTH);

  // GET /v1/admin/engagement/rules
  app.get('/v1/admin/engagement/rules', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const queryTenantId = req.query['tenant_id'] as string | undefined;

    // client_admin は自テナントのみ
    if (user.role === 'client_admin' && queryTenantId && queryTenantId !== user.tenantId) {
      return res.status(403).json({ error: 'forbidden', message: '他のテナントのデータにはアクセスできません' });
    }

    const tenantId = user.role === 'super_admin' ? (queryTenantId ?? null) : user.tenantId;

    try {
      const params: unknown[] = [];
      const where = tenantId ? `WHERE tenant_id = $${params.push(tenantId)}` : '';
      const result = await db.query(
        `SELECT id, tenant_id, trigger_type, trigger_config, message_template, is_active, priority, created_at
         FROM trigger_rules ${where}
         ORDER BY priority DESC, created_at DESC`,
        params,
      );
      return res.json({ rules: result.rows });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // POST /v1/admin/engagement/rules
  app.post('/v1/admin/engagement/rules', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    // null tenant_id (sent when super_admin is in preview mode) → treat as undefined
    const bodyNormalized = { ...req.body, tenant_id: req.body.tenant_id ?? undefined };
    const parsed = TriggerRuleSchema.safeParse(bodyNormalized);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    const { trigger_type, trigger_config, message_template, is_active, priority } = parsed.data;
    const tenantId = user.role === 'super_admin'
      ? (parsed.data.tenant_id ?? user.tenantId)
      : user.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id_required' });
    }
    // client_admin は自テナントのみ
    if (user.role === 'client_admin' && parsed.data.tenant_id && parsed.data.tenant_id !== user.tenantId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      const result = await db.query(
        `INSERT INTO trigger_rules (tenant_id, trigger_type, trigger_config, message_template, is_active, priority)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [tenantId, trigger_type, JSON.stringify(trigger_config), message_template, is_active, priority],
      );
      return res.status(201).json({ rule: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // PUT /v1/admin/engagement/rules/:id
  app.put('/v1/admin/engagement/rules/:id', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const ruleId = Number(req.params['id']);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    const bodyNormalized = { ...req.body, tenant_id: req.body.tenant_id ?? undefined };
    const parsed = TriggerRuleSchema.safeParse(bodyNormalized);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    try {
      // 存在確認 + テナントチェック
      const existing = await db.query('SELECT tenant_id FROM trigger_rules WHERE id = $1', [ruleId]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const { trigger_type, trigger_config, message_template, is_active, priority } = parsed.data;
      const result = await db.query(
        `UPDATE trigger_rules
         SET trigger_type=$1, trigger_config=$2, message_template=$3, is_active=$4, priority=$5
         WHERE id=$6
         RETURNING *`,
        [trigger_type, JSON.stringify(trigger_config), message_template, is_active, priority, ruleId],
      );
      return res.json({ rule: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // DELETE /v1/admin/engagement/rules/:id
  app.delete('/v1/admin/engagement/rules/:id', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const ruleId = Number(req.params['id']);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    try {
      const existing = await db.query('SELECT tenant_id FROM trigger_rules WHERE id = $1', [ruleId]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }

      await db.query('DELETE FROM trigger_rules WHERE id = $1', [ruleId]);
      return res.status(204).end();
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // PATCH /v1/admin/engagement/rules/:id/toggle
  app.patch('/v1/admin/engagement/rules/:id/toggle', async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const user = (req as AuthedReq).user as AuthenticatedUser;
    const ruleId = Number(req.params['id']);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    try {
      const existing = await db.query(
        'SELECT tenant_id, is_active FROM trigger_rules WHERE id = $1', [ruleId]
      );
      if (existing.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (user.role === 'client_admin' && existing.rows[0].tenant_id !== user.tenantId) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const result = await db.query(
        'UPDATE trigger_rules SET is_active = NOT is_active WHERE id = $1 RETURNING *',
        [ruleId],
      );
      return res.json({ rule: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ----------------------------------------------------------------
  // Widget向けAPI (x-api-key認証)
  // ----------------------------------------------------------------
  app.get('/api/engagement/rules', ...apiStack, async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'database_unavailable' });

    const tenantId: string = (req as Request & { tenantId?: string }).tenantId ?? '';
    if (!tenantId) return res.status(401).json({ error: 'tenant_not_found' });

    try {
      const result = await db.query(
        `SELECT id, trigger_type, trigger_config, message_template, priority
         FROM trigger_rules
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY priority DESC`,
        [tenantId],
      );
      return res.json({ rules: result.rows });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
