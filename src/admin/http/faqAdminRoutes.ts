// src/admin/http/faqAdminRoutes.ts
import express, { type Express, type Request, type Response } from "express";
import { Pool } from "pg";
import { embedText } from "../../agent/llm/openaiEmbeddingClient";
import { supabaseAuthMiddleware } from "./supabaseAuthMiddleware";

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
    })
  : null;

type FaqRow = {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  es_doc_id: string | null;
  tags: string[] | null;
  is_published: boolean;
  created_at: string;
  updated_at: string;
};

function requireDb() {
  if (!pool) {
    throw new Error("DATABASE_URL is not set or pg pool is not initialized");
  }
  return pool;
}

function resolveTenantId(req: Request): string | null {
  // 優先順位: 明示的なクエリパラメータ -> ヘッダー -> ボディ
  const fromQuery = (req.query.tenantId || req.query.tenant_id) as
    | string
    | undefined;
  const fromHeader =
    (req.headers["x-tenant-id"] as string | undefined) ?? undefined;
  const fromBody = (req.body?.tenantId || req.body?.tenant_id) as
    | string
    | undefined;

  return fromQuery || fromHeader || fromBody || null;
}

async function updateEsFaqDocument(row: FaqRow) {
  try {
    const esUrl = process.env.ES_URL;
    const esFaqIndex = process.env.ES_FAQ_INDEX || "faqs";

    if (!esUrl) {
      console.warn("[updateEsFaqDocument] ES_URL is not set");
      return;
    }
    if (!row.es_doc_id) {
      console.warn(
        "[updateEsFaqDocument] es_doc_id is not set for FAQ id",
        row.id
      );
      return;
    }

    const url = `${esUrl.replace(
      /\/$/,
      ""
    )}/${esFaqIndex}/_doc/${encodeURIComponent(row.es_doc_id)}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: row.tenant_id,
        question: row.question,
        answer: row.answer,
        category: row.category,
        tags: row.tags,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(
        `[updateEsFaqDocument] Failed to update ES document ${row.es_doc_id}: status ${response.status}, response: ${text}`
      );
    }
  } catch (err) {
    console.warn("[updateEsFaqDocument] error", err);
  }
}

export function registerFaqAdminRoutes(app: Express) {
  if (!databaseUrl || !pool) {
    console.warn(
      "[faqAdminRoutes] DATABASE_URL is not set. Admin FAQ API will be disabled."
    );
    return;
  }

  app.use(express.json());

  const db = requireDb();

  // 🔐 Supabase Auth ミドルウェアを /admin/faqs 配下に適用
  app.use("/admin/faqs", supabaseAuthMiddleware);

  // 🔐 将来的に Supabase Auth ミドルウェアをここに噛ませる想定
  // 例: app.use("/admin/faqs", supabaseAuthMiddleware);

  /**
   * GET /admin/faqs
   * テナントごとの FAQ 一覧取得
   * 例: /admin/faqs?tenantId=demo
   */
  app.get("/admin/faqs", async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }

    const limit = Math.min(
      parseInt((req.query.limit as string) || "50", 10) || 50,
      200
    );
    const offset = parseInt((req.query.offset as string) || "0", 10) || 0;

    try {
      const result = await db.query<FaqRow>(
        `
        SELECT
          id,
          tenant_id,
          question,
          answer,
          category,
          es_doc_id,
          tags,
          is_published,
          created_at,
          updated_at
        FROM faq_docs
        WHERE tenant_id = $1
        ORDER BY id DESC
        LIMIT $2 OFFSET $3
        `,
        [tenantId, limit, offset]
      );

      return res.json({
        items: result.rows,
        pagination: { limit, offset, count: result.rows.length },
      });
    } catch (err) {
      console.error("[GET /admin/faqs] error", err);
      return res
        .status(500)
        .json({ error: "Failed to fetch FAQs", detail: String(err) });
    }
  });

  /**
   * GET /admin/faqs/:id
   * 単一 FAQ 取得
   */
  app.get("/admin/faqs/:id", async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const id = Number(req.params.id);

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }

    try {
      const result = await db.query<FaqRow>(
        `
        SELECT
          id,
          tenant_id,
          question,
          answer,
          category,
          es_doc_id,
          tags,
          is_published,
          created_at,
          updated_at
        FROM faq_docs
        WHERE id = $1 AND tenant_id = $2
        `,
        [id, tenantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "FAQ not found" });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      console.error("[GET /admin/faqs/:id] error", err);
      return res
        .status(500)
        .json({ error: "Failed to fetch FAQ", detail: String(err) });
    }
  });

  /**
   * POST /admin/faqs
   * FAQ 作成
   * body: { tenantId?, question, answer, category?, tags?, isPublished? }
   */
  app.post("/admin/faqs", async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const { question, answer, category, tags, isPublished } = req.body || {};

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }
    if (!question || !answer) {
      return res
        .status(400)
        .json({ error: "question and answer are required" });
    }

    try {
      const result = await db.query<FaqRow>(
        `
        INSERT INTO faq_docs (
          tenant_id,
          question,
          answer,
          category,
          tags,
          is_published,
          es_doc_id
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), NULL)
        RETURNING
          id,
          tenant_id,
          question,
          answer,
          category,
          es_doc_id,
          tags,
          is_published,
          created_at,
          updated_at
        `,
        [
          tenantId,
          question,
          answer,
          category ?? null,
          Array.isArray(tags) ? tags : null,
          typeof isPublished === "boolean" ? isPublished : null,
        ]
      );

      const row = result.rows[0];

      try {
        const embeddingText = `${row.question}\n${row.answer}`;
        const embedding = await embedText(embeddingText);

        const embeddingLiteral = `[${embedding.join(",")}]`;

        await db.query(
          `
          INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
          VALUES ($1, $2, $3::vector, $4::jsonb)
          `,
          [
            row.tenant_id,
            embeddingText,
            embeddingLiteral,
            JSON.stringify({ source: "faq", faq_id: row.id }),
          ]
        );
      } catch (err) {
        console.warn("[POST /admin/faqs] failed to insert embedding", err);
      }

      return res.status(201).json(row);
    } catch (err) {
      console.error("[POST /admin/faqs] error", err);
      return res
        .status(500)
        .json({ error: "Failed to create FAQ", detail: String(err) });
    }
  });

  /**
   * PUT /admin/faqs/:id
   * FAQ 更新（部分更新）
   */
  app.put("/admin/faqs/:id", async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const id = Number(req.params.id);
    const { question, answer, category, tags, isPublished } = req.body || {};

    console.log("[PUT] body =", req.body);

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }

    try {
      const result = await db.query<FaqRow>(
        `
        UPDATE faq_docs
        SET
          question = COALESCE($2, question),
          answer = COALESCE($3, answer),
          category = COALESCE($4, category),
          es_doc_id = es_doc_id,
          tags = COALESCE($5, tags),
          is_published = COALESCE($6, is_published),
          updated_at = NOW()
        WHERE id = $1 AND tenant_id = $7
        RETURNING
          id,
          tenant_id,
          question,
          answer,
          category,
          es_doc_id,
          tags,
          is_published,
          created_at,
          updated_at
        `,
        [
          id,
          question ?? null,
          answer ?? null,
          category ?? null,
          Array.isArray(tags) ? tags : null,
          typeof isPublished === "boolean" ? isPublished : null,
          tenantId,
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "FAQ not found" });
      }

      const row = result.rows[0];

      try {
        await updateEsFaqDocument(row);
      } catch (err) {
        console.warn("[PUT /admin/faqs/:id] failed to update ES", err);
      }

      try {
        const embeddingText = `${row.question}\n${row.answer}`;
        const embedding = await embedText(embeddingText);
        const embeddingLiteral = `[${embedding.join(",")}]`;

        // 既存のこの FAQ 用のベクトルを削除してから再登録
        await db.query(
          `
          DELETE FROM faq_embeddings
          WHERE tenant_id = $1
            AND metadata->>'faq_id' IS NOT NULL
            AND (metadata->>'faq_id')::bigint = $2
          `,
          [row.tenant_id, row.id]
        );

        await db.query(
          `
          INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
          VALUES ($1, $2, $3::vector, $4::jsonb)
          `,
          [
            row.tenant_id,
            embeddingText,
            embeddingLiteral,
            JSON.stringify({ source: "faq", faq_id: row.id }),
          ]
        );
      } catch (err) {
        console.warn("[PUT /admin/faqs/:id] failed to upsert embedding", err);
      }

      return res.json(row);
    } catch (err) {
      console.error("[PUT /admin/faqs/:id] error", err);
      return res
        .status(500)
        .json({ error: "Failed to update FAQ", detail: String(err) });
    }
  });

  /**
   * DELETE /admin/faqs/:id
   * FAQ 削除
   */
  app.delete("/admin/faqs/:id", async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const id = Number(req.params.id);

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }

    try {
      const result = await db.query(
        `
        DELETE FROM faq_docs
        WHERE id = $1 AND tenant_id = $2
        RETURNING id
        `,
        [id, tenantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "FAQ not found" });
      }

      // embeddings 側を faq_id などで紐付けるようにしたら、ここで一緒に削除

      return res.json({ ok: true, id });
    } catch (err) {
      console.error("[DELETE /admin/faqs/:id] error", err);
      return res
        .status(500)
        .json({ error: "Failed to delete FAQ", detail: String(err) });
    }
  });

  console.log("[faqAdminRoutes] /admin/faqs routes registered");
}
