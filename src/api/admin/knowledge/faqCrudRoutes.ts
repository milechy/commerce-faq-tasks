// src/api/admin/knowledge/faqCrudRoutes.ts
// Phase30: FAQ CRUD API (Stream A)
import type { Express, Request, Response } from "express";
// @ts-ignore
import { Pool } from "pg";
import { z } from "zod";
import { embedText } from "../../../agent/llm/openaiEmbeddingClient";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { roleAuthMiddleware, requireRole, requireOwnTenant } from "../../middleware/roleAuth";

const CATEGORIES = ["inventory", "campaign", "coupon", "store_info"] as const;

/** query/header からテナントIDを解決（bodyから取得禁止 — CLAUDE.md） */
function resolveTenantId(req: Request): string | null {
  const fromQuery = (req.query.tenant || req.query.tenant_id) as string | undefined;
  const fromHeader = req.headers["x-tenant-id"] as string | undefined;
  return fromQuery || fromHeader || null;
}

/** ESインデックスからドキュメントを削除（best-effort） */
async function deleteFromEs(esDocId: string): Promise<void> {
  const esUrl = process.env.ES_URL;
  const index = process.env.ES_FAQ_INDEX || "faqs";
  if (!esUrl || !esDocId) return;
  const url = `${esUrl.replace(/\/$/, "")}/${index}/_doc/${encodeURIComponent(esDocId)}`;
  await fetch(url, { method: "DELETE" }).catch(() => {});
}

/** embedding を非同期で挿入（fire-and-forget） */
function insertEmbeddingAsync(
  db: Pool,
  tenantId: string,
  text: string,
  faqId: number,
  meta: Record<string, unknown>
): void {
  embedText(text)
    .then((vec) =>
      db.query(
        "INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata) VALUES ($1, $2, $3::vector, $4::jsonb)",
        [tenantId, text, `[${vec.join(",")}]`, JSON.stringify(meta)]
      )
    )
    .catch((e) => console.warn("[faqCrud] embedding insert failed", e));
}

/** ESにドキュメントをupsert（fire-and-forget） */
function upsertToEsAsync(
  tenantId: string,
  faqId: number,
  question: string,
  answer: string
): void {
  const esUrl = process.env.ES_URL;
  const index = process.env.ES_FAQ_INDEX || "faqs";
  if (!esUrl) return;
  const doc = { tenant_id: tenantId, question, answer, faq_id: faqId };
  const url = `${esUrl.replace(/\/$/, "")}/${index}/_doc/${faqId}_${tenantId}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  }).catch((e) => console.warn("[faqCrud] ES upsert failed", e));
}

const createSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(2000),
  category: z.enum(CATEGORIES).optional(),
  tags: z.array(z.string()).optional().default([]),
  is_published: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(2000),
  category: z.enum(CATEGORIES).optional(),
  tags: z.array(z.string()).optional(),
  is_published: z.boolean().optional(),
});

export function registerFaqCrudRoutes(app: Express, db: Pool): void {
  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge/faq
  // FAQ一覧（ページネーション対応）
  // -------------------------------------------------------------------------
  app.get("/v1/admin/knowledge/faq", supabaseAuthMiddleware, roleAuthMiddleware, requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const category = req.query.category as string | undefined;
    const isPublishedRaw = req.query.is_published as string | undefined;
    const limitRaw = Number(req.query.limit ?? 50);
    const offsetRaw = Number(req.query.offset ?? 0);

    const limit = Math.min(isNaN(limitRaw) ? 50 : Math.max(1, limitRaw), 200);
    const offset = isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

    try {
      const params: unknown[] = [tenantId];
      let whereClause = "WHERE tenant_id = $1";

      if (category) {
        params.push(category);
        whereClause += ` AND category = $${params.length}`;
      }

      if (isPublishedRaw === "true" || isPublishedRaw === "false") {
        params.push(isPublishedRaw === "true");
        whereClause += ` AND is_published = $${params.length}`;
      }

      const countResult = await db.query(
        `SELECT COUNT(*)::int AS total FROM faq_docs ${whereClause}`,
        params
      );
      const total = countResult.rows[0].total as number;

      params.push(limit);
      params.push(offset);
      const itemsResult = await db.query(
        `SELECT id, tenant_id, question, answer, category, tags, is_published, created_at, updated_at
         FROM faq_docs
         ${whereClause}
         ORDER BY id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      return res.json({ items: itemsResult.rows, total, limit, offset });
    } catch (err) {
      console.warn("[GET /v1/admin/knowledge/faq]", err);
      return res.status(500).json({ error: "一覧の取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge/faq/:id
  // FAQ単体取得
  // -------------------------------------------------------------------------
  app.get("/v1/admin/knowledge/faq/:id", supabaseAuthMiddleware, roleAuthMiddleware, requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "idが不正です" });
    }

    try {
      const result = await db.query(
        `SELECT id, tenant_id, question, answer, category, tags, is_published, created_at, updated_at
         FROM faq_docs
         WHERE id = $1`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "FAQが見つかりません" });
      }

      const row = result.rows[0] as { tenant_id: string };
      if (row.tenant_id !== tenantId) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      return res.json(row);
    } catch (err) {
      console.warn("[GET /v1/admin/knowledge/faq/:id]", err);
      return res.status(500).json({ error: "取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/faq
  // FAQ新規作成
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/faq", supabaseAuthMiddleware, roleAuthMiddleware, requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { question, answer, category, tags, is_published } = parsed.data;

    try {
      const result = await db.query(
        `INSERT INTO faq_docs (tenant_id, question, answer, category, tags, is_published)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [tenantId, question, answer, category ?? null, tags, is_published]
      );

      const row = result.rows[0] as { id: number; question: string; answer: string };
      const faqId = row.id;
      const embText = `${row.question}\n${row.answer}`;

      insertEmbeddingAsync(db, tenantId, embText, faqId, { source: "faq_crud", faq_id: faqId });
      upsertToEsAsync(tenantId, faqId, row.question, row.answer);

      return res.status(201).json(row);
    } catch (err) {
      console.warn("[POST /v1/admin/knowledge/faq]", err);
      return res.status(500).json({ error: "作成に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/knowledge/faq/:id
  // FAQ更新
  // -------------------------------------------------------------------------
  app.put("/v1/admin/knowledge/faq/:id", supabaseAuthMiddleware, roleAuthMiddleware, requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { question, answer, category, tags, is_published } = parsed.data;

    try {
      // 存在チェック + テナント確認
      const check = await db.query(
        `SELECT id, tenant_id FROM faq_docs WHERE id = $1`,
        [id]
      );

      if (check.rowCount === 0) {
        return res.status(404).json({ error: "FAQが見つかりません" });
      }

      const existing = check.rows[0] as { tenant_id: string };
      if (existing.tenant_id !== tenantId) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      const updateResult = await db.query(
        `UPDATE faq_docs
         SET question = $1,
             answer = $2,
             category = $3,
             tags = COALESCE($4, tags),
             is_published = COALESCE($5, is_published),
             updated_at = NOW()
         WHERE id = $6 AND tenant_id = $7
         RETURNING *`,
        [
          question,
          answer,
          category ?? null,
          tags !== undefined ? tags : null,
          is_published !== undefined ? is_published : null,
          id,
          tenantId,
        ]
      );

      const updated = updateResult.rows[0] as { id: number; question: string; answer: string };

      // 古い embedding を削除し再挿入
      try {
        await db.query(
          `DELETE FROM faq_embeddings
           WHERE tenant_id = $1
             AND (metadata->>'faq_id')::bigint = $2`,
          [tenantId, id]
        );
      } catch (syncErr) {
        console.warn("[faqCrud] embedding delete failed", syncErr);
      }

      const embText = `${updated.question}\n${updated.answer}`;
      insertEmbeddingAsync(db, tenantId, embText, updated.id, {
        source: "faq_crud",
        faq_id: updated.id,
      });
      upsertToEsAsync(tenantId, updated.id, updated.question, updated.answer);

      return res.json(updated);
    } catch (err) {
      console.warn("[PUT /v1/admin/knowledge/faq/:id]", err);
      return res.status(500).json({ error: "更新に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/admin/knowledge/faq/:id
  // FAQ削除
  // -------------------------------------------------------------------------
  app.delete("/v1/admin/knowledge/faq/:id", supabaseAuthMiddleware, roleAuthMiddleware, requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "idが不正です" });
    }

    try {
      // 存在チェック + テナント確認
      const check = await db.query(
        `SELECT id, tenant_id FROM faq_docs WHERE id = $1`,
        [id]
      );

      if (check.rowCount === 0) {
        return res.status(404).json({ error: "FAQが見つかりません" });
      }

      const existing = check.rows[0] as { tenant_id: string };
      if (existing.tenant_id !== tenantId) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      // faq_embeddings 削除
      await db.query(
        `DELETE FROM faq_embeddings
         WHERE tenant_id = $1
           AND (metadata->>'faq_id')::bigint = $2`,
        [tenantId, id]
      );

      // faq_docs 削除
      await db.query(
        "DELETE FROM faq_docs WHERE id = $1 AND tenant_id = $2",
        [id, tenantId]
      );

      // ES 削除（best-effort）
      await deleteFromEs(`${id}_${tenantId}`);

      return res.json({ ok: true, id });
    } catch (err) {
      console.warn("[DELETE /v1/admin/knowledge/faq/:id]", err);
      return res.status(500).json({ error: "削除に失敗しました" });
    }
  });
}
