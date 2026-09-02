// src/api/admin/feedback/routes.ts

// Phase43: admin_feedback テーブル CRUD API
// チケットスタイルのフィードバック管理（feedback_messages チャット系とは別テーブル）

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { createNotification } from "../../../lib/notifications";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist
// ---------------------------------------------------------------------------

const ALLOWED_FEEDBACK_MGMT_ROLES = ["super_admin", "client_admin"] as const;
type AllowedFeedbackMgmtRole = typeof ALLOWED_FEEDBACK_MGMT_ROLES[number];
function isAllowedFeedbackMgmtRole(role: unknown): role is AllowedFeedbackMgmtRole {
  return typeof role === "string" &&
         (ALLOWED_FEEDBACK_MGMT_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role = su?.app_metadata?.role;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
  const isSuperAdmin: boolean = role === "super_admin";
  const email: string = su?.email ?? "";
  return { su, role, tenantId, isSuperAdmin, email };
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const createSchema = z.object({
  message: z.string().min(1).max(4000),
  ai_response: z.string().optional(),
  ai_answered: z.boolean().optional(),
  category: z
    .enum(["operation_guide", "feature_request", "bug_report", "knowledge_gap", "other"])
    .optional()
    .default("other"),
  priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
  /** 「まだ解決しません」で作られる続きの相談。親を1件だけ持つ */
  parent_feedback_id: z.string().uuid().optional(),
});

const updateSchema = z.object({
  status: z
    .enum(["new", "reviewed", "needs_improvement", "resolved"])
    .optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  admin_notes: z.string().max(4000).optional(),
  linked_knowledge_gap_id: z.string().uuid().nullable().optional(),
});

const replySchema = z.object({
  reply_body: z.string().min(1).max(4000),
});

/** client_admin に返すフィールドのホワイトリスト（admin_notes/priority/status等の内部情報を除外） */
const CLIENT_ADMIN_FEEDBACK_FIELDS = [
  "id",
  "message",
  "ai_response",
  "reply_body",
  "replied_at",
  "reply_read_at",
  "parent_feedback_id",
  "created_at",
] as const;

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerAdminFeedbackManagementRoutes(app: Express): void {
  // supabaseAuthMiddleware を先頭に適用

  // -----------------------------------------------------------------------
  // GET /v1/admin/feedback
  // 一覧（Super Admin: 全テナント / Client Admin: 自テナントのみ）
  // クエリ: status, category, tenant_id(super admin用), sort_by, limit, offset
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/feedback",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, tenantId, isSuperAdmin } = extractAuth(req);
      if (!isAllowedFeedbackMgmtRole(role)) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_FEEDBACK_MGMT_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
        }, "feedback_mgmt access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }

      if (!isSuperAdmin && !tenantId) {
        return res.status(403).json({ error: "テナント情報が取得できません" });
      }

      const filterTenantId = isSuperAdmin
        ? (req.query["tenant_id"] as string | undefined) || undefined
        : tenantId || undefined;

      const status = req.query["status"] as string | undefined;
      const category = req.query["category"] as string | undefined;
      const hasReply = req.query["has_reply"] as string | undefined;
      const unreadReply = req.query["unread"] as string | undefined;
      const sortBy = (req.query["sort_by"] as string | undefined) ?? "created_at";
      const sortDir = sortBy === "priority" ? "DESC" : "DESC";
      const limit = Math.min(parseInt((req.query["limit"] as string) ?? "50", 10), 200);
      const offset = parseInt((req.query["offset"] as string) ?? "0", 10);

      // sort_by のホワイトリスト
      const allowedSorts: Record<string, string> = {
        created_at: "created_at",
        updated_at: "updated_at",
        priority: "priority",
        status: "status",
      };
      const sortColumn = allowedSorts[sortBy] ?? "created_at";

      try {
        const pool = getPool();
        const conditions: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (filterTenantId) {
          conditions.push(`tenant_id = $${idx++}`);
          values.push(filterTenantId);
        }
        if (status) {
          conditions.push(`status = $${idx++}`);
          values.push(status);
        }
        if (category) {
          conditions.push(`category = $${idx++}`);
          values.push(category);
        }
        if (hasReply === "true") {
          conditions.push(`reply_body IS NOT NULL`);
        }
        if (unreadReply === "true") {
          conditions.push(`reply_body IS NOT NULL AND reply_read_at IS NULL`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const countResult = await pool.query(
          `SELECT COUNT(*) FROM admin_feedback ${where}`,
          values
        );
        const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

        values.push(limit, offset);
        const result = await pool.query(
          `SELECT * FROM admin_feedback ${where}
           ORDER BY ${sortColumn} ${sortDir}
           LIMIT $${idx++} OFFSET $${idx++}`,
          values
        );

        // client_admin には内部トリアージ情報(status/priority/admin_notes等)を渡さない
        const items = isSuperAdmin
          ? result.rows
          : result.rows.map((row) =>
              Object.fromEntries(CLIENT_ADMIN_FEEDBACK_FIELDS.map((f) => [f, row[f]]))
            );

        return res.json({ items, total, limit, offset });
      } catch (err: any) {
        // admin_feedback テーブル未作成の場合
        if (err?.code === "42P01") {
          return res.json({ items: [], total: 0, limit, offset });
        }
        logger.warn("[GET /v1/admin/feedback]", err);
        return res.status(500).json({ error: "フィードバック一覧の取得に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/feedback
  // フィードバック投稿（tenant_id / user_email は JWT から取得）
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/feedback",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, tenantId, email } = extractAuth(req);
      if (!isAllowedFeedbackMgmtRole(role)) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_FEEDBACK_MGMT_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
        }, "feedback_mgmt access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }

      if (!tenantId) {
        return res.status(403).json({ error: "テナント情報が取得できません" });
      }

      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { message, ai_response, ai_answered, category, priority, parent_feedback_id } = parsed.data;

      try {
        const pool = getPool();

        // parent_feedback_id を指定する場合、自テナントの行であることを確認する
        // （他テナントの行IDへ紐付けて存在を詮索されるのを防ぐ）
        let safeParentId: string | null = null;
        if (parent_feedback_id) {
          const parentCheck = await pool.query(
            `SELECT id FROM admin_feedback WHERE id = $1 AND tenant_id = $2`,
            [parent_feedback_id, tenantId]
          );
          if (parentCheck.rows.length > 0) {
            safeParentId = parent_feedback_id;
          }
        }

        const result = await pool.query(
          `INSERT INTO admin_feedback
             (tenant_id, user_email, message, ai_response, ai_answered, category, priority, parent_feedback_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            tenantId,
            email || null,
            message,
            ai_response ?? null,
            ai_answered ?? false,
            category,
            priority,
            safeParentId,
          ]
        );
        // Phase52h: Trigger 4 — フィードバック受信通知
        void createNotification({
          recipientRole: 'super_admin',
          type: 'feedback_received',
          title: '新しいお客様の声が届きました',
          message: `カテゴリ「${category}」のフィードバックが届きました`,
          link: '/admin/feedback',
          metadata: { feedbackId: result.rows[0]?.id, tenantId, category },
        });
        return res.status(201).json(result.rows[0]);
      } catch (err) {
        logger.warn("[POST /v1/admin/feedback]", err);
        return res.status(500).json({ error: "フィードバックの投稿に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/feedback/:id — Super Admin のみ
  // status / priority / admin_notes / linked_knowledge_gap_id を更新
  // -----------------------------------------------------------------------
  app.patch(
    "/v1/admin/feedback/:id",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, isSuperAdmin } = extractAuth(req);
      if (!isAllowedFeedbackMgmtRole(role)) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_FEEDBACK_MGMT_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
        }, "feedback_mgmt access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }
      if (!isSuperAdmin) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'insufficient_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ['super_admin'],
        }, "feedback_mgmt access denied: super_admin required");
        return res.status(403).json({ error: "super_admin のみアクセス可能です", code: 'AUTHZ_ROLE_DENIED' });
      }

      const id = req.params["id"];
      if (!id) {
        return res.status(400).json({ error: "id が必要です" });
      }

      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const data = parsed.data;
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (data.status !== undefined) {
        setClauses.push(`status = $${idx++}`);
        values.push(data.status);
      }
      if (data.priority !== undefined) {
        setClauses.push(`priority = $${idx++}`);
        values.push(data.priority);
      }
      if (data.admin_notes !== undefined) {
        setClauses.push(`admin_notes = $${idx++}`);
        values.push(data.admin_notes);
      }
      if (data.linked_knowledge_gap_id !== undefined) {
        setClauses.push(`linked_knowledge_gap_id = $${idx++}`);
        values.push(data.linked_knowledge_gap_id);
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: "更新するフィールドがありません" });
      }

      values.push(id);
      try {
        const pool = getPool();
        const result = await pool.query(
          `UPDATE admin_feedback SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
          values
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "フィードバックが見つかりません" });
        }
        return res.json(result.rows[0]);
      } catch (err) {
        logger.warn("[PATCH /v1/admin/feedback/:id]", err);
        return res.status(500).json({ error: "フィードバックの更新に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/feedback/:id/reply — Super Admin のみ
  // テナントへの返信を書く。内部メモ(admin_notes)とは別フィールド
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/feedback/:id/reply",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, isSuperAdmin, email } = extractAuth(req);
      if (!isAllowedFeedbackMgmtRole(role)) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_FEEDBACK_MGMT_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
        }, "feedback_mgmt access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }
      if (!isSuperAdmin) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'insufficient_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ['super_admin'],
        }, "feedback_mgmt access denied: super_admin required");
        return res.status(403).json({ error: "super_admin のみアクセス可能です", code: 'AUTHZ_ROLE_DENIED' });
      }

      const id = req.params["id"];
      if (!id) {
        return res.status(400).json({ error: "id が必要です" });
      }

      const parsed = replySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      try {
        const pool = getPool();
        // reply_read_at を NULL に戻す: 過去に既読でも新しい返信は未読として通知する
        const result = await pool.query(
          `UPDATE admin_feedback
             SET reply_body = $1, replied_at = NOW(), replied_by_email = $2, reply_read_at = NULL
           WHERE id = $3
           RETURNING *`,
          [parsed.data.reply_body, email || null, id]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "フィードバックが見つかりません" });
        }
        const updated = result.rows[0] as { tenant_id: string; id: string };
        void createNotification({
          recipientRole: 'client_admin',
          recipientTenantId: updated.tenant_id,
          type: 'feedback_replied',
          title: '担当者からお返事が届きました',
          message: 'ご相談内容にお返事しました。ご確認ください。',
          link: '/admin',
          metadata: { feedbackId: updated.id },
        });
        return res.json(updated);
      } catch (err) {
        logger.warn("[POST /v1/admin/feedback/:id/reply]", err);
        return res.status(500).json({ error: "返信の送信に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/feedback/:id/read
  // 返信の既読化。client_admin は自テナントの行のみ操作可能
  // -----------------------------------------------------------------------
  app.patch(
    "/v1/admin/feedback/:id/read",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, tenantId, isSuperAdmin } = extractAuth(req);
      if (!isAllowedFeedbackMgmtRole(role)) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_FEEDBACK_MGMT_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
        }, "feedback_mgmt access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }
      if (!isSuperAdmin && !tenantId) {
        return res.status(403).json({ error: "テナント情報が取得できません" });
      }

      const id = req.params["id"];
      if (!id) {
        return res.status(400).json({ error: "id が必要です" });
      }

      try {
        const pool = getPool();
        // client_admin は tenant_id 一致を SQL 側で必須化（他テナントの行を既読化できないようにする）
        const result = isSuperAdmin
          ? await pool.query(
              `UPDATE admin_feedback SET reply_read_at = NOW() WHERE id = $1 RETURNING id, reply_read_at`,
              [id]
            )
          : await pool.query(
              `UPDATE admin_feedback SET reply_read_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id, reply_read_at`,
              [id, tenantId]
            );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "フィードバックが見つかりません" });
        }
        return res.json(result.rows[0]);
      } catch (err) {
        logger.warn("[PATCH /v1/admin/feedback/:id/read]", err);
        return res.status(500).json({ error: "既読の更新に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/feedback/:id — Super Admin のみ
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/feedback/:id",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, isSuperAdmin } = extractAuth(req);
      if (!isAllowedFeedbackMgmtRole(role)) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_FEEDBACK_MGMT_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
        }, "feedback_mgmt access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }
      if (!isSuperAdmin) {
        logger.warn({
          event: 'feedback_mgmt_access_denied',
          reason: 'insufficient_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ['super_admin'],
        }, "feedback_mgmt access denied: super_admin required");
        return res.status(403).json({ error: "super_admin のみアクセス可能です", code: 'AUTHZ_ROLE_DENIED' });
      }

      const id = req.params["id"];
      if (!id) {
        return res.status(400).json({ error: "id が必要です" });
      }

      try {
        const pool = getPool();
        const result = await pool.query(
          "DELETE FROM admin_feedback WHERE id = $1 RETURNING id",
          [id]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "フィードバックが見つかりません" });
        }
        return res.json({ ok: true, id });
      } catch (err) {
        logger.warn("[DELETE /v1/admin/feedback/:id]", err);
        return res.status(500).json({ error: "フィードバックの削除に失敗しました" });
      }
    }
  );
}
