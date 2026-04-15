// src/api/admin/options/routes.ts
// Phase61: オプションサービス発注 CRUD API

import type { Express, Request, Response } from 'express';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { getPool } from '../../../lib/db';
import { logger } from '../../../lib/logger';
import { trackUsage } from '../../../lib/billing/usageTracker';
import { createNotification } from '../../../lib/notifications';

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const isSuperAdmin: boolean =
    (su?.app_metadata?.role ?? su?.user_metadata?.role ?? '') === 'super_admin';
  return { tenantId, isSuperAdmin };
}

export function registerOptionRoutes(app: Express): void {
  app.use('/v1/admin/options', supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/options
  // super_admin: 全テナント、client_admin: 自テナントのみ
  // クエリパラメータ: status, limit, offset
  // -------------------------------------------------------------------------
  app.get('/v1/admin/options', async (req: Request, res: Response) => {
    const { tenantId, isSuperAdmin } = extractAuth(req);
    const statusFilter = req.query['status'] as string | undefined;
    const limit = Math.min(parseInt((req.query['limit'] as string) ?? '20', 10), 100);
    const offset = Math.max(0, parseInt((req.query['offset'] as string) ?? '0', 10));

    try {
      const pool = getPool();
      const values: unknown[] = [];
      const conditions: string[] = [];

      if (!isSuperAdmin) {
        values.push(tenantId);
        conditions.push(`tenant_id = $${values.length}`);
      }

      if (statusFilter) {
        values.push(statusFilter);
        conditions.push(`status = $${values.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM option_orders ${where}`,
        values,
      );
      const total = parseInt(countResult.rows[0]?.cnt ?? '0', 10);

      const queryValues = [...values, limit, offset];
      const limIdx = queryValues.length - 1;
      const offIdx = queryValues.length;

      const itemsResult = await pool.query(
        `SELECT * FROM option_orders ${where}
         ORDER BY created_at DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        queryValues,
      );

      return res.json({ items: itemsResult.rows, total });
    } catch (err: any) {
      if (err?.code === '42P01') return res.json({ items: [], total: 0 });
      logger.warn('[GET /v1/admin/options]', err);
      return res.status(500).json({ error: 'オプション一覧の取得に失敗しました' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/options — 新規発注作成（feedbackAIから呼ばれる）
  // -------------------------------------------------------------------------
  app.post('/v1/admin/options', async (req: Request, res: Response) => {
    const { tenantId } = extractAuth(req);

    const { description, llm_estimate_amount, chat_session_id, type } = req.body as {
      description?: string;
      llm_estimate_amount?: number;
      chat_session_id?: string;
      type?: string;
    };

    if (!description || typeof description !== 'string' || description.trim() === '') {
      return res.status(400).json({ error: 'description は必須です' });
    }

    const orderType = type === 'premium_avatar' ? 'premium_avatar' : 'general';

    try {
      const pool = getPool();
      const result = await pool.query(
        `INSERT INTO option_orders (tenant_id, chat_session_id, description, llm_estimate_amount, type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          tenantId,
          chat_session_id ?? null,
          description.trim(),
          llm_estimate_amount ?? null,
          orderType,
        ],
      ).catch(async (err: any) => {
        // type カラムが未マイグレーションの場合はフォールバック
        if (err?.code === '42703') {
          const pool2 = getPool();
          return pool2.query(
            `INSERT INTO option_orders (tenant_id, chat_session_id, description, llm_estimate_amount)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [tenantId, chat_session_id ?? null, description.trim(), llm_estimate_amount ?? null],
          );
        }
        throw err;
      });

      return res.status(201).json({ item: (result as any).rows[0] });
    } catch (err: any) {
      logger.warn('[POST /v1/admin/options]', err);
      return res.status(500).json({ error: 'オプション発注の作成に失敗しました' });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/options/:id — 更新（super_adminのみ）
  // -------------------------------------------------------------------------
  app.put('/v1/admin/options/:id', async (req: Request, res: Response) => {
    const { isSuperAdmin } = extractAuth(req);
    if (!isSuperAdmin) {
      return res.status(403).json({ error: '権限がありません' });
    }

    const { id } = req.params;
    const { description, llm_estimate_amount, final_amount, status } = req.body as {
      description?: string;
      llm_estimate_amount?: number;
      final_amount?: number;
      status?: string;
    };

    if (
      status !== undefined &&
      !['pending', 'in_progress', 'completed'].includes(status)
    ) {
      return res.status(400).json({ error: 'status が不正です' });
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE option_orders
         SET
           description        = COALESCE($2, description),
           llm_estimate_amount = COALESCE($3, llm_estimate_amount),
           final_amount       = COALESCE($4, final_amount),
           status             = COALESCE($5, status),
           updated_at         = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, description ?? null, llm_estimate_amount ?? null, final_amount ?? null, status ?? null],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: '発注が見つかりません' });
      }

      return res.json({ item: result.rows[0] });
    } catch (err: any) {
      logger.warn('[PUT /v1/admin/options/:id]', err);
      return res.status(500).json({ error: '発注の更新に失敗しました' });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/options/:id/complete — 完了マーク（super_adminのみ）
  // 1. status='completed', completed_at=NOW()
  // 2. notifications テーブルに完了通知 INSERT
  // 3. trackUsage() で option_service 課金記録
  // -------------------------------------------------------------------------
  app.put('/v1/admin/options/:id/complete', async (req: Request, res: Response) => {
    const { isSuperAdmin } = extractAuth(req);
    if (!isSuperAdmin) {
      return res.status(403).json({ error: '権限がありません' });
    }

    const { id } = req.params;
    const { result_url } = req.body as { result_url?: string };

    try {
      const pool = getPool();

      // 1. status を completed に更新（result_url があれば保存）
      let result;
      try {
        result = await pool.query(
          `UPDATE option_orders
           SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
               result_url = COALESCE($2, result_url)
           WHERE id = $1 AND status != 'completed'
           RETURNING *`,
          [id, result_url ?? null],
        );
      } catch (colErr: any) {
        // result_url カラムが未マイグレーションの場合はフォールバック
        if (colErr?.code === '42703') {
          result = await pool.query(
            `UPDATE option_orders
             SET status = 'completed', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND status != 'completed'
             RETURNING *`,
            [id],
          );
        } else {
          throw colErr;
        }
      }

      if (result.rowCount === 0) {
        return res.status(404).json({ error: '発注が見つかりません（または既に完了済み）' });
      }

      const order = result.rows[0] as {
        id: string;
        tenant_id: string;
        description: string;
        type?: string;
        final_amount: number | null;
        llm_estimate_amount: number | null;
        result_url?: string | null;
      };

      const isPremiumAvatar = order.type === 'premium_avatar';

      // 2. 完了通知 INSERT
      await createNotification({
        recipientRole: 'client_admin',
        recipientTenantId: order.tenant_id,
        type: isPremiumAvatar ? 'premium_avatar_completed' : 'option_completed',
        title: isPremiumAvatar
          ? 'プレミアムアバターが完成しました'
          : 'オプションサービスが完了しました',
        message: order.description.slice(0, 100),
        link: isPremiumAvatar ? '/admin/avatar' : '/admin/options',
      });

      // 3. 課金トラッキング（fire-and-forget）
      const amount = order.final_amount ?? order.llm_estimate_amount ?? 0;
      trackUsage({
        tenantId: order.tenant_id,
        requestId: `option-${order.id}`,
        model: 'option_service',
        inputTokens: 0,
        outputTokens: amount,
        featureUsed: 'option_service',
      });

      return res.json({ item: order, ok: true });
    } catch (err: any) {
      logger.warn('[PUT /v1/admin/options/:id/complete]', err);
      return res.status(500).json({ error: '完了処理に失敗しました' });
    }
  });
}
