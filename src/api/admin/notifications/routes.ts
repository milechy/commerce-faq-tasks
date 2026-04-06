// src/api/admin/notifications/routes.ts

// Phase52h: In-App通知センター API

import type { Express, Request, Response } from 'express';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { getPool } from '../../../lib/db';
import { logger } from '../../../lib/logger';

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const isSuperAdmin: boolean =
    (su?.app_metadata?.role ?? su?.user_metadata?.role ?? '') === 'super_admin';
  return { tenantId, isSuperAdmin };
}

export function registerNotificationRoutes(app: Express): void {
  app.use('/v1/admin/notifications', supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // GET /v1/admin/notifications
  // Super Admin: 自分宛(super_admin) OR recipient_tenant_id IS NULL
  // Client Admin: client_admin AND (自テナント OR recipient_tenant_id IS NULL)
  // -----------------------------------------------------------------------
  app.get('/v1/admin/notifications', async (req: Request, res: Response) => {
    const { tenantId, isSuperAdmin } = extractAuth(req);
    const isReadParam = req.query['is_read'] as string | undefined;
    const limit = Math.min(parseInt((req.query['limit'] as string) ?? '20', 10), 100);
    const offset = Math.max(0, parseInt((req.query['offset'] as string) ?? '0', 10));

    try {
      const pool = getPool();

      let roleClause: string;
      const baseValues: unknown[] = [];

      if (isSuperAdmin) {
        roleClause = `(recipient_role = 'super_admin' OR recipient_tenant_id IS NULL)`;
      } else {
        roleClause = `(recipient_role = 'client_admin' AND (recipient_tenant_id = $1 OR recipient_tenant_id IS NULL))`;
        baseValues.push(tenantId);
      }

      // Unread count (role-filtered only, no is_read filter)
      const unreadResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM notifications WHERE ${roleClause} AND is_read = false`,
        baseValues,
      );
      const unread_count = parseInt(unreadResult.rows[0]?.cnt ?? '0', 10);

      // is_read フィルタ
      let isReadClause = '';
      if (isReadParam === 'false') isReadClause = ' AND is_read = false';
      else if (isReadParam === 'true') isReadClause = ' AND is_read = true';

      // Total
      const countResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM notifications WHERE ${roleClause}${isReadClause}`,
        baseValues,
      );
      const total = parseInt(countResult.rows[0]?.cnt ?? '0', 10);

      const queryValues = [...baseValues, limit, offset];
      const limIdx = queryValues.length - 1; // limit の $n
      const offIdx = queryValues.length;     // offset の $n

      const itemsResult = await pool.query(
        `SELECT * FROM notifications
         WHERE ${roleClause}${isReadClause}
         ORDER BY created_at DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        queryValues,
      );

      return res.json({ items: itemsResult.rows, unread_count, total });
    } catch (err: any) {
      if (err?.code === '42P01') {
        return res.json({ items: [], unread_count: 0, total: 0 });
      }
      logger.warn('[GET /v1/admin/notifications]', err);
      return res.status(500).json({ error: '通知の取得に失敗しました' });
    }
  });

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/notifications/read-all — 全未読を既読に
  // ※ /:id/read より前に登録する必要はないが安全のため先に登録
  // -----------------------------------------------------------------------
  app.patch('/v1/admin/notifications/read-all', async (req: Request, res: Response) => {
    const { tenantId, isSuperAdmin } = extractAuth(req);

    try {
      const pool = getPool();

      if (isSuperAdmin) {
        await pool.query(
          `UPDATE notifications SET is_read = true
           WHERE (recipient_role = 'super_admin' OR recipient_tenant_id IS NULL)
             AND is_read = false`,
        );
      } else {
        await pool.query(
          `UPDATE notifications SET is_read = true
           WHERE recipient_role = 'client_admin'
             AND (recipient_tenant_id = $1 OR recipient_tenant_id IS NULL)
             AND is_read = false`,
          [tenantId],
        );
      }

      return res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === '42P01') return res.json({ ok: true });
      logger.warn('[PATCH /v1/admin/notifications/read-all]', err);
      return res.status(500).json({ error: '既読処理に失敗しました' });
    }
  });

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/notifications/:id/read — 個別既読
  // -----------------------------------------------------------------------
  app.patch('/v1/admin/notifications/:id/read', async (req: Request, res: Response) => {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'id が不正です' });
    }

    const { tenantId, isSuperAdmin } = extractAuth(req);

    try {
      const pool = getPool();

      if (isSuperAdmin) {
        await pool.query(
          `UPDATE notifications SET is_read = true WHERE id = $1`,
          [id],
        );
      } else {
        await pool.query(
          `UPDATE notifications SET is_read = true
           WHERE id = $1
             AND recipient_role = 'client_admin'
             AND (recipient_tenant_id = $2 OR recipient_tenant_id IS NULL)`,
          [id, tenantId],
        );
      }

      return res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === '42P01') return res.json({ ok: true });
      logger.warn('[PATCH /v1/admin/notifications/:id/read]', err);
      return res.status(500).json({ error: '既読処理に失敗しました' });
    }
  });
}
