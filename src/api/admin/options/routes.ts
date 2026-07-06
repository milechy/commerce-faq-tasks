// src/api/admin/options/routes.ts
// Phase61: オプションサービス発注 CRUD API

import type { Express, Request, Response } from 'express';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { getPool } from '../../../lib/db';
import { logger } from '../../../lib/logger';
import { chargeOneOffJpy } from '../../../lib/billing/stripeSync';
import { createNotification } from '../../../lib/notifications';
import { submitSaiTask, getSaiTask } from '../../../lib/sai/saiClient';
import { trackUsage } from '../../../lib/billing/usageTracker';

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist (Phase69-1.5 PR-C4 v2)
// ---------------------------------------------------------------------------

const ALLOWED_OPTION_ROLES = ['super_admin', 'client_admin'] as const;
type AllowedOptionRole = typeof ALLOWED_OPTION_ROLES[number];
function isAllowedOptionRole(role: unknown): role is AllowedOptionRole {
  return typeof role === 'string' &&
         (ALLOWED_OPTION_ROLES as readonly string[]).includes(role);
}

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role = su?.app_metadata?.role;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const isSuperAdmin: boolean = role === 'super_admin';
  return { su, role, tenantId, isSuperAdmin };
}

function denyRole(req: Request, res: Response, su: Record<string, any> | undefined, role: unknown, requiredRoles: readonly string[]) {
  logger.warn({
    event: 'options_access_denied',
    reason: 'invalid_role',
    errorCode: 'AUTHZ_ROLE_DENIED',
    requested_path: req.path,
    actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
    actor_role: role,
    required_roles: requiredRoles,
    hasAppMetadataRole: !!su?.['app_metadata']?.role,
    hasUserMetadataRole: !!su?.['user_metadata']?.role,
  }, 'options access denied: invalid actor role');
  return res.status(403).json({ error: 'この操作を実行する権限がありません', code: 'AUTHZ_ROLE_DENIED' });
}

function denyInsufficient(req: Request, res: Response, su: Record<string, any> | undefined, role: unknown) {
  logger.warn({
    event: 'options_access_denied',
    reason: 'insufficient_role',
    errorCode: 'AUTHZ_ROLE_DENIED',
    requested_path: req.path,
    actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
    actor_role: role,
    required_roles: ['super_admin'],
  }, 'options access denied: super_admin required');
  return res.status(403).json({ error: '権限がありません', code: 'AUTHZ_ROLE_DENIED' });
}

export function registerOptionRoutes(app: Express): void {
  app.use('/v1/admin/options', supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/options
  // super_admin: 全テナント、client_admin: 自テナントのみ
  // クエリパラメータ: status, limit, offset
  // -------------------------------------------------------------------------
  app.get('/v1/admin/options', async (req: Request, res: Response) => {
    const { su, role, tenantId, isSuperAdmin } = extractAuth(req);
    if (!isAllowedOptionRole(role)) {
      return denyRole(req, res, su, role, ALLOWED_OPTION_ROLES);
    }
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
    const { su, role, tenantId } = extractAuth(req);
    if (!isAllowedOptionRole(role)) {
      return denyRole(req, res, su, role, ALLOWED_OPTION_ROLES);
    }

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
    const { su, role, isSuperAdmin } = extractAuth(req);
    if (!isAllowedOptionRole(role)) {
      return denyRole(req, res, su, role, ALLOWED_OPTION_ROLES);
    }
    if (!isSuperAdmin) {
      return denyInsufficient(req, res, su, role);
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
  // 3. 確定金額をStripeに単発請求（reportUsageToStripeのリクエスト数課金とは別経路。
  //    GID: option_serviceがcostCalculatorのModelKeyに存在せず金額が¥0扱いになっていた不具合の修正）
  // -------------------------------------------------------------------------
  app.put('/v1/admin/options/:id/complete', async (req: Request, res: Response) => {
    const { su, role, isSuperAdmin } = extractAuth(req);
    if (!isAllowedOptionRole(role)) {
      return denyRole(req, res, su, role, ALLOWED_OPTION_ROLES);
    }
    if (!isSuperAdmin) {
      return denyInsufficient(req, res, su, role);
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

      // 3. 確定金額をStripeに単発請求
      const amount = order.final_amount ?? order.llm_estimate_amount ?? 0;
      const charged = await chargeOneOffJpy(pool, logger, {
        tenantId: order.tenant_id,
        amountJpy: amount,
        description: `代行作業: ${order.description.slice(0, 80)}`,
        idempotencyKey: `option-complete:${order.id}`,
      });
      if (charged) {
        await pool
          .query(`UPDATE option_orders SET stripe_usage_recorded = true WHERE id = $1`, [order.id])
          .catch((err: any) => logger.warn('[PUT /v1/admin/options/:id/complete] stripe_usage_recorded update failed', err));
      }

      return res.json({ item: order, ok: true, stripe_charged: charged });
    } catch (err: any) {
      logger.warn('[PUT /v1/admin/options/:id/complete]', err);
      return res.status(500).json({ error: '完了処理に失敗しました' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/options/:id/try-sai — SaiエージェントにGUI代行作業を試行させる（super_adminのみ）
  // Saiの成否自己申告は信用しない設計のため、ここでは status/final_amount 等を一切更新しない。
  // 結果はGET .../sai-task で取得し、人間が最終スクリーンショットを見て
  // 既存の /complete フローで完了させるか判断する。
  // -------------------------------------------------------------------------
  app.post('/v1/admin/options/:id/try-sai', async (req: Request, res: Response) => {
    const { su, role, isSuperAdmin } = extractAuth(req);
    if (!isAllowedOptionRole(role)) {
      return denyRole(req, res, su, role, ALLOWED_OPTION_ROLES);
    }
    if (!isSuperAdmin) {
      return denyInsufficient(req, res, su, role);
    }

    const { id } = req.params;
    const { max_steps } = req.body as { max_steps?: number };

    try {
      const pool = getPool();
      const orderResult = await pool.query(
        `SELECT id, description FROM option_orders WHERE id = $1`,
        [id],
      );
      if (orderResult.rowCount === 0) {
        return res.status(404).json({ error: '発注が見つかりません' });
      }
      const order = orderResult.rows[0] as { id: string; description: string };

      const { task_id } = await submitSaiTask({
        description: order.description,
        orderId: order.id,
        maxSteps: max_steps,
      });

      await pool
        .query(
          `UPDATE option_orders SET sai_task_id = $2, sai_outcome = NULL, sai_tried_at = NOW() WHERE id = $1`,
          [id, task_id],
        )
        .catch((err: any) => {
          if (err?.code !== '42703') throw err;
          logger.warn('[POST /v1/admin/options/:id/try-sai] sai_* columns not migrated yet');
        });

      return res.status(202).json({ task_id, status: 'queued' });
    } catch (err: any) {
      if (err?.message === 'SAI_API_KEY not set') {
        return res.status(503).json({ error: 'Saiエージェントが設定されていません' });
      }
      logger.warn('[POST /v1/admin/options/:id/try-sai]', err);
      return res.status(502).json({ error: 'Saiエージェントへの依頼に失敗しました' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/options/:id/sai-task — Sai実行結果の取得（super_adminのみ）
  // 最終スクリーンショットを含む生の実行結果を返す。完了判断は人間が行う。
  // -------------------------------------------------------------------------
  app.get('/v1/admin/options/:id/sai-task', async (req: Request, res: Response) => {
    const { su, role, isSuperAdmin } = extractAuth(req);
    if (!isAllowedOptionRole(role)) {
      return denyRole(req, res, su, role, ALLOWED_OPTION_ROLES);
    }
    if (!isSuperAdmin) {
      return denyInsufficient(req, res, su, role);
    }

    const { id } = req.params;

    try {
      const pool = getPool();
      const orderResult = await pool.query(
        `SELECT tenant_id, sai_task_id FROM option_orders WHERE id = $1`,
        [id],
      ).catch((err: any) => {
        if (err?.code === '42703') return { rowCount: 0, rows: [] } as any;
        throw err;
      });

      const orderRow = orderResult.rows[0] as { tenant_id?: string; sai_task_id?: string } | undefined;
      const saiTaskId = orderRow?.sai_task_id;
      if (!saiTaskId) {
        return res.status(404).json({ error: 'この発注はまだSaiで試行されていません' });
      }

      const task = await getSaiTask(saiTaskId);

      if (task.status === 'complete') {
        await pool
          .query(`UPDATE option_orders SET sai_outcome = $2 WHERE id = $1`, [id, task.outcome ?? 'unknown'])
          .catch((err: any) => {
            if (err?.code !== '42703') throw err;
          });

        // 社内原価集計のみ(テナント請求は既存の /complete → chargeOneOffJpy で完結)。
        // requestIdをsai_task_idで固定し、再ポーリングでも二重計上しない(ON CONFLICT DO NOTHING)。
        if (orderRow?.tenant_id) {
          trackUsage({
            tenantId: orderRow.tenant_id,
            requestId: `sai-task:${saiTaskId}`,
            model: 'agent-s',
            inputTokens: 0,
            outputTokens: 0,
            featureUsed: 'sai_agent',
            marginOverride: 1,
            saiAgentSteps: task.steps,
          });
        }
      }

      return res.json({ task });
    } catch (err: any) {
      if (err?.message === 'SAI_API_KEY not set') {
        return res.status(503).json({ error: 'Saiエージェントが設定されていません' });
      }
      logger.warn('[GET /v1/admin/options/:id/sai-task]', err);
      return res.status(502).json({ error: 'Saiエージェントの状態取得に失敗しました' });
    }
  });
}
