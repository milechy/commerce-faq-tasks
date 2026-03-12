// src/api/admin/knowledge/routes.ts
// Phase29: カーネーション向けナレッジ管理API
import type { Express, Request, Response } from "express";
// @ts-ignore
import { Pool } from "pg";
import { z } from "zod";
import { groqClient } from "../../../agent/llm/groqClient";
import { embedText } from "../../../agent/llm/openaiEmbeddingClient";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { roleAuthMiddleware, requireRole, requireOwnTenant } from "../../middleware/roleAuth";
import { registerFaqCrudRoutes } from "./faqCrudRoutes";
import { encryptText } from "../../../lib/crypto/textEncrypt";

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const CATEGORIES = ["inventory", "campaign", "coupon", "store_info"] as const;
type Category = (typeof CATEGORIES)[number];

interface FaqEntry {
  question: string;
  answer: string;
}

/** query/header からテナントIDを解決（bodyから取得禁止 — CLAUDE.md） */
function resolveTenantId(req: Request): string | null {
  const fromQuery = (req.query.tenant || req.query.tenant_id) as string | undefined;
  const fromHeader = req.headers["x-tenant-id"] as string | undefined;
  return fromQuery || fromHeader || null;
}

/** テキスト→FAQ変換（Groq llama-3.1-8b-instant） */
async function textToFaqs(text: string, category: Category): Promise<FaqEntry[]> {
  const categoryLabel: Record<Category, string> = {
    inventory: "在庫・車両情報",
    campaign: "キャンペーン・セール",
    coupon: "クーポン・割引",
    store_info: "店舗情報・アクセス",
  };

  const prompt = `あなたは中古車販売店のFAQ作成の専門家です。
以下のテキストを読んで、お客様がよく聞きそうな質問とその回答を5〜10個生成してください。
カテゴリ: ${categoryLabel[category]}

テキスト:
${text.slice(0, 3000)}

以下のJSON配列のみを出力してください（説明文・コードブロック記号は不要）:
[
  {"question": "質問1", "answer": "回答1"},
  {"question": "質問2", "answer": "回答2"}
]`;

  const raw = await groqClient.call({
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    maxTokens: 2000,
    tag: "knowledge-text-to-faq",
  });

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("LLMがJSON形式で回答しませんでした");

  const parsed = JSON.parse(jsonMatch[0]) as unknown[];
  if (!Array.isArray(parsed)) throw new Error("JSON形式が不正です");

  return parsed.filter(
    (f): f is FaqEntry =>
      typeof (f as any).question === "string" && typeof (f as any).answer === "string"
  );
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
        [tenantId, encryptText(text), `[${vec.join(",")}]`, JSON.stringify(meta)]
      )
    )
    .catch((e) => console.warn("[knowledge] embedding insert failed", e));
}

export function registerKnowledgeAdminRoutes(app: Express): void {
  if (!pool) {
    console.warn("[knowledgeAdminRoutes] DATABASE_URL not set. Routes disabled.");
    return;
  }

  const db = pool;

  // Supabase JWT 認証 + ロール付与を /v1/admin/knowledge 配下に適用
  app.use("/v1/admin/knowledge", supabaseAuthMiddleware, roleAuthMiddleware);

  // FAQ CRUD: super_admin と client_admin がアクセス可能（自テナント制限付き）
  app.use(
    "/v1/admin/knowledge/faq",
    requireRole("super_admin", "client_admin"),
    requireOwnTenant()
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge
  // faq_docs からナレッジ一覧を返す
  // -------------------------------------------------------------------------
  app.get("/v1/admin/knowledge", requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const category = req.query.category as string | undefined;

    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    try {
      const params: unknown[] = [tenantId];
      let sql = `
        SELECT id, tenant_id, question, answer, category, tags, created_at
        FROM faq_docs
        WHERE tenant_id = $1
      `;
      if (category && category !== "all") {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }
      sql += " ORDER BY id DESC LIMIT 200";

      const result = await db.query(sql, params);
      return res.json({ items: result.rows, count: result.rows.length });
    } catch (err) {
      console.error("[GET /v1/admin/knowledge]", err);
      return res.status(500).json({ error: "一覧の取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/admin/knowledge/:id
  // faq_docs + faq_embeddings + ES から削除（tenant_id 一致チェック必須）
  // -------------------------------------------------------------------------
  app.delete("/v1/admin/knowledge/:id", requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    const id = Number(req.params.id);

    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "idが不正です" });
    }

    try {
      // tenant_id 一致チェック + es_doc_id 取得
      const check = await db.query(
        "SELECT id, es_doc_id FROM faq_docs WHERE id = $1 AND tenant_id = $2",
        [id, tenantId]
      );
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "ナレッジが見つかりません" });
      }

      const esDocId = check.rows[0].es_doc_id as string | null;

      // faq_embeddings 削除
      await db.query(
        `DELETE FROM faq_embeddings
         WHERE tenant_id = $1
           AND metadata->>'faq_id' IS NOT NULL
           AND (metadata->>'faq_id')::bigint = $2`,
        [tenantId, id]
      );

      // faq_docs 削除
      await db.query(
        "DELETE FROM faq_docs WHERE id = $1 AND tenant_id = $2",
        [id, tenantId]
      );

      // ES 削除（best-effort）
      if (esDocId) await deleteFromEs(esDocId);

      return res.json({ ok: true, id });
    } catch (err) {
      console.error("[DELETE /v1/admin/knowledge/:id]", err);
      return res.status(500).json({ error: "削除に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/text
  // テキスト → Groq でFAQ生成 → プレビュー用に返す（DB未挿入）
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/text", requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      text: z.string().min(10).max(10000),
      category: z.enum(CATEGORIES),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { text, category } = parsed.data;

    try {
      const faqs = await textToFaqs(text, category);
      if (faqs.length === 0) {
        return res.status(422).json({ error: "FAQを生成できませんでした。テキストをもう少し詳しく入力してみてください。" });
      }
      return res.json({ ok: true, preview: faqs, count: faqs.length });
    } catch (err) {
      console.error("[POST /v1/admin/knowledge/text]", err);
      return res
        .status(500)
        .json({ error: "AI変換に失敗しました。しばらく経ってから再度お試しください。" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/text/commit
  // プレビュー済みFAQをDB（faq_docs + faq_embeddings）に投入
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/text/commit", requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      faqs: z
        .array(z.object({ question: z.string(), answer: z.string() }))
        .min(1)
        .max(20),
      category: z.enum(CATEGORIES),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { faqs, category } = parsed.data;
    const inserted: number[] = [];

    for (const faq of faqs) {
      try {
        const r = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id`,
          [tenantId, faq.question.slice(0, 500), faq.answer.slice(0, 2000), category]
        );
        const faqId = r.rows[0].id as number;
        inserted.push(faqId);

        const embText = `${faq.question}\n${faq.answer}`;
        insertEmbeddingAsync(db, tenantId, embText, faqId, {
          source: "text",
          faq_id: faqId,
        });
      } catch (err) {
        console.error("[commit] insert failed for faq:", faq.question, err);
      }
    }

    return res.status(201).json({ ok: true, inserted: inserted.length });
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/scrape
  // URL取得 → テキスト抽出 → Groq FAQ化 → プレビューとして返す（DB未登録）
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/scrape", requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    const schema = z.object({
      urls: z.array(z.string().url()).min(1).max(5),
      category: z.enum(CATEGORIES).default("store_info"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { urls, category } = parsed.data;
    const results: { url: string; faqs: FaqEntry[]; error?: string }[] = [];

    for (const url of urls) {
      try {
        const html = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; RAJIUCE/1.0)" },
          signal: AbortSignal.timeout(10_000),
        }).then((r) => r.text());

        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 5000);

        const faqs = await textToFaqs(text, category);
        results.push({ url, faqs });
      } catch (err) {
        results.push({ url, faqs: [], error: String(err).slice(0, 200) });
      }
    }

    return res.json({ ok: true, preview: results });
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge/scrape/commit
  // プレビュー済みFAQ（スクレイプ結果）をDB登録
  // -------------------------------------------------------------------------
  app.post("/v1/admin/knowledge/scrape/commit", requireRole("super_admin", "client_admin"), requireOwnTenant(), async (req: Request, res: Response) => {
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
              .array(z.object({ question: z.string(), answer: z.string() }))
              .min(1)
              .max(20),
          })
        )
        .min(1)
        .max(5),
      category: z.enum(CATEGORIES).default("store_info"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { items, category } = parsed.data;
    let totalInserted = 0;

    for (const item of items) {
      for (const faq of item.faqs) {
        try {
          const r = await db.query(
            `INSERT INTO faq_docs (tenant_id, question, answer, category, tags, is_published)
             VALUES ($1, $2, $3, $4, $5, true)
             RETURNING id`,
            [
              tenantId,
              faq.question.slice(0, 500),
              faq.answer.slice(0, 2000),
              category,
              [item.url],
            ]
          );
          const faqId = r.rows[0].id as number;
          totalInserted++;

          const embText = `${faq.question}\n${faq.answer}`;
          insertEmbeddingAsync(db, tenantId, embText, faqId, {
            source: "scrape",
            faq_id: faqId,
            url: item.url,
          });
        } catch (err) {
          console.error("[scrape/commit] insert failed", err);
        }
      }
    }

    return res.status(201).json({ ok: true, inserted: totalInserted });
  });

  registerFaqCrudRoutes(app, db);

  console.log("[knowledgeAdminRoutes] /v1/admin/knowledge routes registered");
}
