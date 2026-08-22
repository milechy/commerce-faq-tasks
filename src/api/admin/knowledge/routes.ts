// src/api/admin/knowledge/routes.ts

// Phase29: カーネーション向けナレッジ管理API
import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { pool } from "../../../lib/db";
import jwt from "jsonwebtoken";
import { registerFaqCrudRoutes } from "./faqCrudRoutes";
import { registerBookPdfRoutes } from "./bookPdfRoutes";
import { logger } from '../../../lib/logger';
import { resolveFaqWriteIndex } from "../../../search/langIndex";
import type { SupabaseJwtUser } from '../../middleware/roleAuth';
import {
  generateTextFaqPreview,
  generateScrapeFaqPreview,
  commitTextFaqs,
  commitScrapeFaqs,
} from "../../../lib/knowledge/faqImport";

// textToFaqs / FaqEntry の実体は src/lib/knowledge/faqImport.ts に移動済み。
// actionExecutor.ts や agentRoutes.test.ts の既存モック(`jest.mock('../knowledge/routes', ...)`)が
// このパスからの import に依存しているため、ここから再エクスポートする形で後方互換を維持する。
export { textToFaqs, type FaqEntry } from "../../../lib/knowledge/faqImport";

type KnowledgeUser = { id: string; email: string; role: string; tenantId: string | null };
type KnowledgeReq = Request & {
  supabaseUser?: SupabaseJwtUser;
  user?: KnowledgeUser;
};

/** query/header からテナントIDを解決（bodyから取得禁止 — CLAUDE.md） */
function resolveTenantId(req: Request): string | null {
  const fromQuery = (req.query.tenant || req.query.tenant_id) as string | undefined;
  const fromHeader = req.headers["x-tenant-id"] as string | undefined;
  return fromQuery || fromHeader || null;
}

/** ESインデックスからドキュメントを削除（best-effort）
 * Phase69-2-E: write index を read path と同じ faq_${tenantId} に統一 */
async function deleteFromEs(tenantId: string, esDocId: string): Promise<void> {
  const esUrl = process.env.ES_URL;
  const index = resolveFaqWriteIndex(tenantId);
  if (!esUrl || !esDocId) return;
  const url = `${esUrl.replace(/\/$/, "")}/${index}/_doc/${encodeURIComponent(esDocId)}`;
  await fetch(url, { method: "DELETE" }).catch(() => {});
}

export function registerKnowledgeAdminRoutes(app: Express): void {
  if (!pool) {
    logger.warn("[knowledgeAdminRoutes] DATABASE_URL not set. Routes disabled.");
    return;
  }

  const db = pool;

  // ── インライン認証スタック（モジュールキャッシュ問題を回避） ─────────────────
  // JWT 検証 → req.supabaseUser / req.user をセット
  function knowledgeAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization ?? "";

    if (process.env.NODE_ENV === "development") {
      // development: 署名検証なしでデコードし req.supabaseUser をセット
      if (authHeader.startsWith("Bearer ")) {
        try {
          (req as KnowledgeReq).supabaseUser = jwt.decode(authHeader.slice(7).trim()) as SupabaseJwtUser ?? undefined;
        } catch {
          // decode 失敗は無視して通す
        }
        return setUserAndNext(req, next);
      }
      if (req.headers["x-api-key"]) return next();
      res.status(401).json({ error: "Missing X-Api-Key or Bearer token" });
      return;
    }

    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      // SECRET 未設定時はスキップ（ステージング等）
      return setUserAndNext(req, next);
    }

    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }
    const token = authHeader.slice(7).trim();
    try {
      (req as KnowledgeReq).supabaseUser = jwt.verify(token, secret) as SupabaseJwtUser;
      return setUserAndNext(req, next);
    } catch (err) {
      logger.warn("[knowledgeAuth] invalid token", err);
      res.status(401).json({ error: "Invalid token" });
    }
  }

  function setUserAndNext(req: Request, next: NextFunction): void {
    const su = (req as KnowledgeReq).supabaseUser;
    if (su) {
      (req as KnowledgeReq).user = {
        id: su.sub ?? su.id ?? "",
        email: su.email ?? "",
        role: su.app_metadata?.role ?? "anonymous",
        tenantId: su.app_metadata?.tenant_id ?? null,
      };
    } else {
      (req as KnowledgeReq).user = { id: "", email: "", role: "anonymous", tenantId: null };
    }
    next();
  }

  // role チェック（super_admin / client_admin のみ通過 — Phase69-1.5 PR-C4 v2: ALLOWED_KNOWLEDGE_ROLES 統合）
  const ALLOWED_KNOWLEDGE_ROLES = ["super_admin", "client_admin"] as const;
  function requireKnowledgeRole(req: Request, res: Response, next: NextFunction): void {
    const user = (req as KnowledgeReq).user;
    const role = user?.role ?? "";
    if (!user || !(ALLOWED_KNOWLEDGE_ROLES as readonly string[]).includes(role)) {
      const su = (req as KnowledgeReq).supabaseUser;
      logger.warn({
        event: 'knowledge_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        requested_path: req.path,
        actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
        actor_role: role,
        required_roles: ALLOWED_KNOWLEDGE_ROLES,
        hasAppMetadataRole: !!su?.app_metadata?.role,
        hasUserMetadataRole: !!(su as any)?.user_metadata?.role,
      }, 'knowledge access denied: invalid actor role');
      res.status(403).json({ error: "forbidden", message: "この操作を行う権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      return;
    }
    next();
  }

  // テナント所有チェック（super_admin は全テナントにアクセス可）
  function requireKnowledgeTenant(req: Request, res: Response, next: NextFunction): void {
    const user = (req as KnowledgeReq).user;
    if (user?.role === "super_admin") { next(); return; }

    const requestedTenant =
      (req.params.tenantId as string | undefined) ||
      (req.query.tenant as string | undefined) ||
      (req.query.tenant_id as string | undefined) ||
      (req.headers["x-tenant-id"] as string | undefined);

    if (requestedTenant && requestedTenant !== user?.tenantId) {
      res.status(403).json({ error: "forbidden", message: "他のテナントのデータにはアクセスできません" });
      return;
    }
    if (!requestedTenant && user?.tenantId) req.query.tenant = user.tenantId;
    next();
  }
  // ────────────────────────────────────────────────────────────────────────────

  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge
  // faq_docs からナレッジ一覧を返す
  // -------------------------------------------------------------------------
  app.get("/v1/admin/knowledge", knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant, async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const user = (req as KnowledgeReq).user;
    const category = req.query.category as string | undefined;
    const isGlobalParam = req.query.is_global as string | undefined;
    const isPublishedParam = req.query.is_published as string | undefined;

    if (!tenantId && user?.role !== "super_admin") {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    try {
      const params: unknown[] = [];
      let sql = `SELECT id, tenant_id, question, answer, category, tags, is_global, is_published, created_at FROM faq_docs`;
      const conditions: string[] = [];

      if (tenantId) {
        params.push(tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      if (category && category !== "all") {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      if (isGlobalParam === "true") {
        conditions.push(`is_global = true`);
      } else if (isGlobalParam === "false") {
        conditions.push(`is_global = false OR is_global IS NULL`);
      }
      if (isPublishedParam === "true") {
        conditions.push(`is_published = true`);
      } else if (isPublishedParam === "false") {
        conditions.push(`is_published = false`);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }
      sql += " ORDER BY id DESC LIMIT 200";

      const result = await db.query(sql, params);

      // faq_embeddings のチャンク数も返す（PDF OCR コンテンツを含む）
      let chunkCount = 0;
      if (tenantId) {
        const chunkRes = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM faq_embeddings WHERE tenant_id = $1`,
          [tenantId]
        );
        chunkCount = chunkRes.rows[0]?.cnt ?? 0;
      }

      return res.json({ items: result.rows, count: result.rows.length, chunkCount });
    } catch (err) {
      logger.error("[GET /v1/admin/knowledge]", err);
      return res.status(500).json({ error: "一覧の取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/admin/knowledge/:id
  // faq_docs + faq_embeddings + ES から削除（tenant_id 一致チェック必須）
  // global ナレッジは super_admin のみ削除可能
  // -------------------------------------------------------------------------
  app.delete("/v1/admin/knowledge/:id", knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant, async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const id = Number(req.params.id);

    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "idが不正です" });
    }

    try {
      // tenant_id 一致チェック + es_doc_id 取得（globalも対象に含める）
      const check = await db.query(
        "SELECT id, es_doc_id, tenant_id FROM faq_docs WHERE id = $1 AND (tenant_id = $2 OR tenant_id = 'global')",
        [id, tenantId]
      );
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "ナレッジが見つかりません" });
      }

      // global ナレッジは super_admin のみ削除可能
      const recordTenantId = check.rows[0].tenant_id as string;
      if (recordTenantId === "global") {
        const user = (req as KnowledgeReq).user;
        if (user?.role !== "super_admin") {
          return res.status(403).json({ error: "全店舗共通の知識データはSuper Adminのみ削除可能です" });
        }
      }

      const esDocId = check.rows[0].es_doc_id as string | null;

      // faq_embeddings 削除
      await db.query(
        `DELETE FROM faq_embeddings
         WHERE tenant_id = $1
           AND metadata->>'faq_id' IS NOT NULL
           AND (metadata->>'faq_id')::bigint = $2`,
        [recordTenantId, id]
      );

      // faq_docs 削除
      await db.query(
        "DELETE FROM faq_docs WHERE id = $1 AND tenant_id = $2",
        [id, recordTenantId]
      );

      // ES 削除（best-effort）
      if (esDocId) await deleteFromEs(recordTenantId, esDocId);

      return res.json({ ok: true, id });
    } catch (err) {
      logger.error("[DELETE /v1/admin/knowledge/:id]", err);
      return res.status(500).json({ error: "削除に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/text
  // テキスト → Groq でFAQ生成 → プレビュー用に返す（DB未挿入）
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/text", knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant, async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      text: z.string().min(50, "テキストは50文字以上入力してください").max(10000),
      category: z.string().optional(), // 未指定 = AIが自動判定
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { text, category } = parsed.data;

    try {
      const preview = await generateTextFaqPreview(db, tenantId, text, category || null);
      if (preview.length === 0) {
        return res.status(422).json({ error: "FAQを生成できませんでした。テキストをもう少し詳しく入力してみてください。" });
      }

      return res.json({ ok: true, preview, count: preview.length });
    } catch (err) {
      logger.error("[POST /v1/admin/knowledge/text]", err);
      return res
        .status(500)
        .json({ error: "AI変換に失敗しました。しばらく経ってから再度お試しください。" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/text/commit
  // プレビュー済みFAQをDB（faq_docs + faq_embeddings）に投入
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/text/commit", knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant, async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      faqs: z
        .array(z.object({ question: z.string(), answer: z.string(), category: z.string().optional() }))
        .min(1)
        .max(20),
      category: z.string().optional(), // 全FAQ共通の強制カテゴリ（未指定=各FAQの自動判定値を使用）
      target: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { faqs, category: categoryOverride, target: rawTarget } = parsed.data;
    const isSuperAdmin = (req as KnowledgeReq).user?.role === "super_admin";
    const target = rawTarget || tenantId;

    // "global" は super_admin のみ許可
    if (target === "global" && !isSuperAdmin) {
      return res.status(403).json({ error: "全店舗共通の知識データはSuper Adminのみ登録可能です" });
    }
    // target は body 由来のクライアント制御値。requireKnowledgeTenant は body を見ないため、
    // super_admin 以外が他テナントへの書き込みを指定できてしまう穴を防ぐ
    // （actionExecutor.ts の commit_faq_import と同じ判断基準）。
    if (target !== tenantId && !isSuperAdmin) {
      return res.status(403).json({ error: "forbidden", message: "他のテナントには登録できません" });
    }

    const result = await commitTextFaqs(db, target, faqs, categoryOverride, "text");

    return res.status(201).json({ ok: true, inserted: result.inserted, skipped: result.skipped });
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/scrape
  // URL取得 → テキスト抽出 → Groq FAQ化 → プレビューとして返す（DB未登録）
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/scrape", knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant, async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      urls: z.array(z.string().url()).min(1).max(5),
      category: z.string().optional(), // 未指定 = AIが自動判定
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { urls, category } = parsed.data;
    const results = await generateScrapeFaqPreview(db, tenantId, urls, category || null);

    return res.json({ ok: true, preview: results });
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/scrape/commit
  // プレビュー済みFAQ（スクレイプ結果）をDB登録
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/scrape/commit", knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant, async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      items: z
        .array(
          z.object({
            url: z.string().url(),
            faqs: z
              .array(z.object({ question: z.string(), answer: z.string(), category: z.string().optional() }))
              .min(1)
              .max(20),
            // Phase73: preview から引き継いだ商品メタ（省略可）
            productMeta: z.object({
              product_image_url: z.string().nullable().optional(),
              product_price: z.string().nullable().optional(),
              product_cta_url: z.string().nullable().optional(),
            }).optional(),
          })
        )
        .min(1)
        .max(5),
      category: z.string().optional(), // 全FAQ共通の強制カテゴリ（未指定=各FAQの自動判定値を使用）
      target: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { items, category: categoryOverride, target: rawTarget } = parsed.data;
    const isSuperAdmin = (req as KnowledgeReq).user?.role === "super_admin";
    const target = rawTarget || tenantId;

    // "global" は super_admin のみ許可
    if (target === "global" && !isSuperAdmin) {
      return res.status(403).json({ error: "全店舗共通の知識データはSuper Adminのみ登録可能です" });
    }
    // target は body 由来のクライアント制御値。requireKnowledgeTenant は body を見ないため、
    // super_admin 以外が他テナントへの書き込みを指定できてしまう穴を防ぐ
    // （actionExecutor.ts の commit_faq_import と同じ判断基準）。
    if (target !== tenantId && !isSuperAdmin) {
      return res.status(403).json({ error: "forbidden", message: "他のテナントには登録できません" });
    }

    const result = await commitScrapeFaqs(db, target, items, categoryOverride, "scrape");

    return res.status(201).json({ ok: true, inserted: result.inserted, skipped: result.skipped });
  });

  // ─── Phase47 Stream B: 構造化ステータス ─────────────────────────────────
  app.get(
    '/v1/admin/knowledge/structurize-status',
    knowledgeAuth,
    requireKnowledgeRole,
    requireKnowledgeTenant,
    async (req: Request, res: Response) => {
      const user = (req as KnowledgeReq).user;
      const tenantId = resolveTenantId(req);

      // client_admin はテナントIDが必須
      if (!tenantId && user?.role !== 'super_admin') {
        return res.status(403).json({ error: 'テナント情報が取得できません' });
      }

      try {
        if (tenantId) {
          // テナント指定あり（super_admin も client_admin も同じクエリ）
          const totalResult = await db.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM book_uploads WHERE tenant_id = $1`,
            [tenantId],
          );
          const total_docs = parseInt(totalResult.rows[0]?.cnt ?? '0', 10);

          // 構造化済み: book_uploads.status='embedded' かつ structured embedding が存在する
          const structResult = await db.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt
             FROM book_uploads bu
             WHERE bu.tenant_id = $1
               AND bu.status = 'embedded'
               AND EXISTS (
                 SELECT 1 FROM faq_embeddings fe
                 WHERE fe.tenant_id = $1
                   AND fe.metadata->>'source' = 'book'
                   AND fe.metadata->>'book_id' = bu.id::text
                   AND fe.metadata->>'principle' IS NOT NULL
               )`,
            [tenantId],
          );
          const structured_count = parseInt(structResult.rows[0]?.cnt ?? '0', 10);

          // 未構造化: status='embedded' だが structured embedding が存在しない（= trigger対象と同一条件）
          const unstructResult = await db.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt
             FROM book_uploads bu
             WHERE bu.tenant_id = $1
               AND bu.status = 'embedded'
               AND NOT EXISTS (
                 SELECT 1 FROM faq_embeddings fe
                 WHERE fe.tenant_id = $1
                   AND fe.metadata->>'source' = 'book'
                   AND fe.metadata->>'book_id' = bu.id::text
                   AND fe.metadata->>'principle' IS NOT NULL
               )`,
            [tenantId],
          );
          const unstructured_count = parseInt(unstructResult.rows[0]?.cnt ?? '0', 10);

          return res.json({ tenant_id: tenantId, total_docs, structured_count, unstructured_count });
        } else {
          // super_admin かつ tenant_id 未指定 → 全テナント集計
          const totalResult = await db.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM book_uploads`,
          );
          const total_docs = parseInt(totalResult.rows[0]?.cnt ?? '0', 10);

          const structResult = await db.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt
             FROM book_uploads bu
             WHERE bu.status = 'embedded'
               AND EXISTS (
                 SELECT 1 FROM faq_embeddings fe
                 WHERE fe.metadata->>'source' = 'book'
                   AND fe.metadata->>'book_id' = bu.id::text
                   AND fe.metadata->>'principle' IS NOT NULL
               )`,
          );
          const structured_count = parseInt(structResult.rows[0]?.cnt ?? '0', 10);

          const unstructResult = await db.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt
             FROM book_uploads bu
             WHERE bu.status = 'embedded'
               AND NOT EXISTS (
                 SELECT 1 FROM faq_embeddings fe
                 WHERE fe.metadata->>'source' = 'book'
                   AND fe.metadata->>'book_id' = bu.id::text
                   AND fe.metadata->>'principle' IS NOT NULL
               )`,
          );
          const unstructured_count = parseInt(unstructResult.rows[0]?.cnt ?? '0', 10);

          return res.json({ tenant_id: null, total_docs, structured_count, unstructured_count });
        }
      } catch (err: unknown) {
        logger.error('[structurize-status] error:', err instanceof Error ? err.message : String(err));
        return res.status(500).json({ error: '構造化ステータスの取得に失敗しました' });
      }
    },
  );

  // ─── Phase47 Stream B: 構造化トリガー（super_admin） ────────────────────
  app.post(
    '/v1/admin/knowledge/structurize-trigger',
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as KnowledgeReq).user;
      if (user?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super Adminのみ実行できます' });
      }

      const tenantId = resolveTenantId(req);
      if (!tenantId) return res.status(403).json({ error: 'テナント情報が取得できません' });

      try {
        // 未構造化の書籍を取得
        const booksResult = await db.query<{ id: number; storage_path: string; encryption_iv: string | null }>(
          `SELECT bu.id, bu.storage_path, bu.encryption_iv
           FROM book_uploads bu
           WHERE bu.tenant_id = $1
             AND bu.status = 'embedded'
             AND NOT EXISTS (
               SELECT 1 FROM faq_embeddings fe
               WHERE fe.tenant_id = $1
                 AND fe.metadata->>'source' = 'book'
                 AND fe.metadata->>'book_id' = bu.id::text
                 AND fe.metadata->>'principle' IS NOT NULL
             )`,
          [tenantId],
        );

        const targetCount = booksResult.rows.length;

        if (targetCount === 0) {
          return res.json({ message: '構造化対象の書籍がありません', target_count: 0 });
        }

        // fire-and-forget
        setImmediate(() => {
          import('./bookPdfRoutes').then(() =>
            import('../../../agent/knowledge/bookStructurizer').then(({ structurizeBook }) => {
              const { supabaseAdmin } = require('../../auth/supabaseClient');
              const { extractPdfText } = require('../../lib/book-pipeline/pdfExtractor');
              const processNext = async () => {
                for (const book of booksResult.rows) {
                  try {
                    if (!supabaseAdmin) continue;
                    const { pages } = await extractPdfText({ supabase: supabaseAdmin }, book.storage_path, book.encryption_iv);
                    const fullText = pages.map((p: { text: string }) => p.text).join('\n\n');
                    await structurizeBook(tenantId, book.id, fullText);
                  } catch (err) {
                    logger.warn('[structurize-trigger] book_id=%d failed:', book.id, err instanceof Error ? err.message : String(err));
                  }
                }
              };
              processNext().catch(() => {});
            })
          ).catch(() => {});
        });

        return res.json({ message: `構造化を開始しました`, target_count: targetCount });
      } catch (err: unknown) {
        logger.error('[structurize-trigger] error:', err instanceof Error ? err.message : String(err));
        return res.status(500).json({ error: '構造化トリガーに失敗しました' });
      }
    },
  );

  registerFaqCrudRoutes(app, db, knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant);
  registerBookPdfRoutes(app, db, knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant);

  logger.info("[knowledgeAdminRoutes] /v1/admin/knowledge routes registered");
}
