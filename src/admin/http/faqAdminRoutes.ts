// src/admin/http/faqAdminRoutes.ts
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { embedText } from "../../agent/llm/openaiEmbeddingClient";
import { pool } from "../../lib/db";
import { supabaseAuthMiddleware } from "./supabaseAuthMiddleware";
import { logger } from '../../lib/logger';
import { upsertFaqToEs, deleteFaqFromEs } from "../../lib/knowledge/faqIndexSync";

// es_doc_id 列は使用しない: 非NULL値を書き込む箇所がコードベース全体に無く、
// 索引同期は src/lib/knowledge/faqIndexSync.ts の `${faqId}_${tenantId}` 規約に
// 一本化されている（faqCrudRoutes.ts / actionExecutor.ts / faqImport.ts と共通）。
// 列自体はDBに残るが、2026-08-25(ナレッジ配線是正P4)時点でSQL文字列からも
// 参照を外した(DROP migrationは別途用意し適用は運用作業とする)。

type FaqRow = {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  is_published: boolean;
  is_excluded_from_search?: boolean | null;
  created_at: string;
  updated_at: string;
};

function requireDb() {
  if (!pool) {
    throw new Error("DATABASE_URL is not set or pg pool is not initialized");
  }
  return pool;
}

type FaqSupabaseUser = {
  app_metadata?: { role?: string; tenant_id?: string };
};

function resolveTenantId(req: Request): string | null {
  // CLAUDE.md: tenantId は body から取得禁止
  // JWT 優先 (defense-in-depth):
  //   super_admin: fromJwt = undefined → query/header の previewMode 経路が有効
  //   client_admin: fromJwt = tenant_id → query/header 注入を無効化
  const su = (req as any).supabaseUser as FaqSupabaseUser | undefined;
  const fromJwt = su?.app_metadata?.tenant_id ?? undefined;
  const fromQuery = (req.query.tenantId || req.query.tenant_id) as string | undefined;
  const fromHeader = (req.headers["x-tenant-id"] as string | undefined) ?? undefined;
  return fromJwt || fromQuery || fromHeader || null;
}

// super_admin / client_admin のみ通過。anonymous JWT は 403。
function requireFaqRole(req: Request, res: Response, next: NextFunction): void {
  const su = (req as any).supabaseUser as FaqSupabaseUser | undefined;
  const role = su?.app_metadata?.role ?? "anonymous";
  if (role !== "super_admin" && role !== "client_admin") {
    res.status(403).json({ error: "forbidden", message: "この操作を実行する権限がありません" });
    return;
  }
  next();
}

// super_admin: 全テナント通過（previewMode 経路）
// client_admin: JWT tenantId と異なるテナント指定 → 403 / 未指定 → JWT で補完
function requireFaqTenant(req: Request, res: Response, next: NextFunction): void {
  const su = (req as any).supabaseUser as FaqSupabaseUser | undefined;
  const role = su?.app_metadata?.role ?? "anonymous";
  if (role === "super_admin") { next(); return; }

  const requestedTenant =
    (req.query.tenantId as string | undefined) ||
    (req.query.tenant_id as string | undefined) ||
    (req.headers["x-tenant-id"] as string | undefined);
  const jwtTenantId = su?.app_metadata?.tenant_id;

  if (requestedTenant && jwtTenantId && requestedTenant !== jwtTenantId) {
    res.status(403).json({ error: "forbidden", message: "他のテナントのデータにはアクセスできません" });
    return;
  }
  if (!requestedTenant && jwtTenantId) {
    req.query.tenantId = jwtTenantId;
  }
  next();
}

export function registerFaqAdminRoutes(app: Express) {
  if (!pool) {
    logger.warn(
      "[faqAdminRoutes] DATABASE_URL is not set. Admin FAQ API will be disabled."
    );
    return;
  }

  app.use(express.json());

  const db = requireDb();

  // 認証 + ロール + テナント分離の3層を /admin/faqs 全ルートに適用
  app.use("/admin/faqs", supabaseAuthMiddleware, requireFaqRole, requireFaqTenant);

  /**
   * GET /admin/faqs
   * テナントごとの FAQ 一覧取得
   * 例: /admin/faqs?tenantId=demo
   */
  app.get("/admin/faqs", async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const su = (req as any).supabaseUser as FaqSupabaseUser | undefined;
    const role = su?.app_metadata?.role ?? "anonymous";

    if (!tenantId && role !== "super_admin") {
      return res.status(400).json({ error: "tenantId is required" });
    }

    const limit = Math.min(
      parseInt((req.query.limit as string) || "50", 10) || 50,
      200
    );
    const offset = parseInt((req.query.offset as string) || "0", 10) || 0;

    try {
      const result = tenantId
        ? await db.query<FaqRow>(
            `
            SELECT id, tenant_id, question, answer, category,
                   tags, is_published, created_at, updated_at
            FROM faq_docs
            WHERE tenant_id = $1
            ORDER BY id DESC
            LIMIT $2 OFFSET $3
            `,
            [tenantId, limit, offset]
          )
        : await db.query<FaqRow>(
            `
            SELECT id, tenant_id, question, answer, category,
                   tags, is_published, created_at, updated_at
            FROM faq_docs
            ORDER BY id DESC
            LIMIT $1 OFFSET $2
            `,
            [limit, offset]
          );

      return res.json({
        items: result.rows,
        pagination: { limit, offset, count: result.rows.length },
      });
    } catch (err) {
      logger.error("[GET /admin/faqs] error", err);
      return res
        .status(500)
        .json({ error: "internal_error", message: "FAQ一覧の取得に失敗しました。時間をおいて再度お試しください。" });
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
      logger.error("[GET /admin/faqs/:id] error", err);
      return res
        .status(500)
        .json({ error: "internal_error", message: "FAQの取得に失敗しました。時間をおいて再度お試しください。" });
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
          is_published
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, true))
        RETURNING
          id,
          tenant_id,
          question,
          answer,
          category,
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
        // PR-2(2026-08-25収益監査): tenantId をスコープに持ちながら渡し忘れており、
        // unknown計上され続けていた。billable:false は課金対象化の方針が未確定なため。
        const embedding = await embedText(embeddingText, { tenantId: row.tenant_id, billable: false });

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
        logger.warn("[POST /admin/faqs] failed to insert embedding", err);
      }

      upsertFaqToEs(row.tenant_id, row.id, row.question, row.answer, row.is_published);

      return res.status(201).json(row);
    } catch (err) {
      logger.error("[POST /admin/faqs] error", err);
      return res
        .status(500)
        .json({ error: "internal_error", message: "FAQの登録に失敗しました。時間をおいて再度お試しください。" });
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
          tags,
          is_published,
          is_excluded_from_search,
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

      // is_excluded_from_search を引き継がずに5引数で呼ぶと、質問/回答を編集する
      // だけの通常の更新でも ES 側の検索除外フラグが黙って false に巻き戻る
      // (2026-08-25 是正。actionExecutor.ts:1091 で先に見つかった同一バグの残存側)。
      upsertFaqToEs(row.tenant_id, row.id, row.question, row.answer, row.is_published, row.is_excluded_from_search ?? false);

      try {
        const embeddingText = `${row.question}\n${row.answer}`;
        // PR-2(2026-08-25収益監査): tenantId をスコープに持ちながら渡し忘れており、
        // unknown計上され続けていた。billable:false は課金対象化の方針が未確定なため。
        const embedding = await embedText(embeddingText, { tenantId: row.tenant_id, billable: false });
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
        logger.warn("[PUT /admin/faqs/:id] failed to upsert embedding", err);
      }

      return res.json(row);
    } catch (err) {
      logger.error("[PUT /admin/faqs/:id] error", err);
      return res
        .status(500)
        .json({ error: "internal_error", message: "FAQの更新に失敗しました。時間をおいて再度お試しください。" });
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

      // F1(HIGH): faq_docs 削除に連鎖して faq_embeddings も削除する。
      // faq_embeddings は物理 FK を持たず metadata->>'faq_id' で faq_docs を参照するため
      // ON DELETE CASCADE が効かない (phase69_2d_faq_embedding_orphan_cleanup.sql 参照)。
      // PUT /admin/faqs/:id の再 embed 経路と同じ WHERE で連鎖削除し orphan 量産を防ぐ。
      await db.query(
        `
        DELETE FROM faq_embeddings
        WHERE tenant_id = $1
          AND metadata->>'faq_id' IS NOT NULL
          AND (metadata->>'faq_id')::bigint = $2
        `,
        [tenantId, id]
      );

      await deleteFaqFromEs(tenantId, id);

      return res.json({ ok: true, id });
    } catch (err) {
      logger.error("[DELETE /admin/faqs/:id] error", err);
      return res
        .status(500)
        .json({ error: "internal_error", message: "FAQの削除に失敗しました。時間をおいて再度お試しください。" });
    }
  });

  logger.info("[faqAdminRoutes] /admin/faqs routes registered");
}
