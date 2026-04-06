// src/api/admin/feedback/routes.ts

// Phase43: admin_feedback テーブル CRUD API
// チケットスタイルのフィードバック管理（既存のチャット系 feedbackRoutes.ts とは別）

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { createNotification } from "../../../lib/notifications";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
  const isSuperAdmin: boolean =
    (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";
  const email: string = su?.email ?? "";
  return { tenantId, isSuperAdmin, email };
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
});

const updateSchema = z.object({
  status: z
    .enum(["new", "reviewed", "needs_improvement", "resolved"])
    .optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  admin_notes: z.string().max(4000).optional(),
  linked_knowledge_gap_id: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerAdminFeedbackManagementRoutes(app: Express): void {
  // supabaseAuthMiddleware を先頭に適用
  // NOTE: /v1/admin/feedback/* は既存の feedbackRoutes.ts とパスを共有するが、
  //       このファイルのルートを index.ts で先に登録することで GET/POST は上書き。
  //       /threads, /unread-count, /read, /:id/flag は feedbackRoutes.ts が処理。

  // -----------------------------------------------------------------------
  // GET /v1/admin/feedback
  // 一覧（Super Admin: 全テナント / Client Admin: 自テナントのみ）
  // クエリ: status, category, tenant_id(super admin用), sort_by, limit, offset
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/feedback",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { tenantId, isSuperAdmin } = extractAuth(req);

      const filterTenantId = isSuperAdmin
        ? (req.query["tenant_id"] as string | undefined) || undefined
        : tenantId || undefined;

      const status = req.query["status"] as string | undefined;
      const category = req.query["category"] as string | undefined;
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
        const values: any[] = [];
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

        return res.json({ items: result.rows, total, limit, offset });
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
      const { tenantId, email } = extractAuth(req);

      if (!tenantId) {
        return res.status(403).json({ error: "テナント情報が取得できません" });
      }

      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { message, ai_response, ai_answered, category, priority } = parsed.data;

      try {
        const pool = getPool();
        const result = await pool.query(
          `INSERT INTO admin_feedback
             (tenant_id, user_email, message, ai_response, ai_answered, category, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            tenantId,
            email || null,
            message,
            ai_response ?? null,
            ai_answered ?? false,
            category,
            priority,
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
      const { isSuperAdmin } = extractAuth(req);

      if (!isSuperAdmin) {
        return res.status(403).json({ error: "super_admin のみアクセス可能です" });
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
      const values: any[] = [];
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
  // DELETE /v1/admin/feedback/:id — Super Admin のみ
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/feedback/:id",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { isSuperAdmin } = extractAuth(req);

      if (!isSuperAdmin) {
        return res.status(403).json({ error: "super_admin のみアクセス可能です" });
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
