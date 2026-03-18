// src/api/admin/knowledge/routes.ts
// Phase29: カーネーション向けナレッジ管理API
import type { Express, NextFunction, Request, Response } from "express";
// @ts-ignore
import { Pool } from "pg";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { groqClient } from "../../../agent/llm/groqClient";
import { embedText } from "../../../agent/llm/openaiEmbeddingClient";
import { registerFaqCrudRoutes } from "./faqCrudRoutes";
import { encryptText } from "../../../lib/crypto/textEncrypt";

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const CATEGORIES = ["inventory", "campaign", "coupon", "store_info", "product_info", "pricing", "booking", "warranty", "general"] as const;
type Category = (typeof CATEGORIES)[number];

interface FaqEntry {
  question: string;
  answer: string;
  category?: string;
}

interface FaqEntryWithDuplicate extends FaqEntry {
  duplicate: {
    existingQuestion: string;
    existingAnswer: string;
  } | null;
}

/** query/header からテナントIDを解決（bodyから取得禁止 — CLAUDE.md） */
function resolveTenantId(req: Request): string | null {
  const fromQuery = (req.query.tenant || req.query.tenant_id) as string | undefined;
  const fromHeader = req.headers["x-tenant-id"] as string | undefined;
  return fromQuery || fromHeader || null;
}

/** 重複チェック用の質問正規化（句読点・空白・大文字小文字・助詞末尾を無視） */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[？?。、！!　\s]+/g, "").trim();
}

/** 文字バイグラムセットを生成 */
function bigrams(s: string): Set<string> {
  const r = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2));
  return r;
}

/**
 * バイグラム包含度による類似度（0-1）
 * 短い方の文字列のバイグラムが長い方に何割含まれるかを返す。
 * 例: "営業時間は" vs "営業時間を教えてください" → 0.75
 */
function bigramSimilarity(a: string, b: string): number {
  const na = normalizeQuestion(a);
  const nb = normalizeQuestion(b);
  if (na === nb) return 1.0;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  const [shorter, longer] = ba.size <= bb.size ? [ba, bb] : [bb, ba];
  let inter = 0;
  for (const g of shorter) if (longer.has(g)) inter++;
  // containment: shorter の bigram が longer に何割含まれるか
  return inter / shorter.size;
}

const DUPLICATE_THRESHOLD = 0.6;

/**
 * テキスト→FAQ変換。
 * categoryOverride が指定された場合は全FAQのカテゴリをその値で上書き。
 * 未指定（null/undefined）の場合はAIがカテゴリを自動判定する。
 * existingQuestions が指定された場合はプロンプトに組み込み重複生成を防止する。
 */
async function textToFaqs(
  text: string,
  categoryOverride?: string | null,
  existingQuestions?: string[]
): Promise<FaqEntry[]> {
  const model = process.env.GROQ_FAQ_GEN_MODEL ?? "llama-3.3-70b-versatile";

  const existingSection =
    existingQuestions && existingQuestions.length > 0
      ? `\n既にこのテナントに登録されているFAQの質問（重複禁止 — 以下と同じ内容は生成しないこと）:\n${existingQuestions
          .slice(0, 40)
          .map((q) => `- ${q}`)
          .join("\n")}\n`
      : "";

  const prompt = `あなたはセールス支援FAQの専門家です。
以下のテキストから、お客様がこの商品・サービスについて質問しそうなFAQを網羅的に生成してください。

重要な原則:
* テキストに含まれる全ての事実情報をFAQとしてカバーすること
* お客様の購入・利用判断に影響する情報は必ずFAQ化すること
* 1つのFAQには1つのトピックのみ（複数の情報を1つにまとめない）
* テキストに書かれていない情報は推測しないこと
* 各FAQに最も適切なカテゴリを自動で判定して付与すること

具体的にFAQ化すべき情報の例:
* 商品のスペック・仕様（各項目を個別のFAQに）
* 価格・料金
* 状態・品質に関する情報
* 付属品・オプション
* 保証・アフターサービス
* 予約・購入方法
* 店舗情報・営業時間
* キャンペーン・割引
${existingSection}
カテゴリの判定基準:
* 商品・サービスの詳細情報 → "product_info"
* 料金・価格・支払い方法 → "pricing"
* 店舗・アクセス・営業時間 → "store_info"
* キャンペーン・セール・割引 → "campaign"
* 在庫・車両情報 → "inventory"
* クーポン・割引コード → "coupon"
* 予約・申し込み方法 → "booking"
* 保証・アフターサービス → "warranty"
* よくある質問・一般 → "general"
* 上記に当てはまらない場合 → 適切なカテゴリ名を英語スネークケースで生成

テキスト:
${text.slice(0, 4000)}

出力形式: JSON配列のみ（他のテキストは含めない）
[{"question": "...", "answer": "...", "category": "..."}]`;

  const raw = await groqClient.call({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 3000,
    tag: "knowledge-text-to-faq",
  });

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("LLMがJSON形式で回答しませんでした");

  const parsed = JSON.parse(jsonMatch[0]) as unknown[];
  if (!Array.isArray(parsed)) throw new Error("JSON形式が不正です");

  const faqs = parsed.filter(
    (f): f is FaqEntry =>
      typeof (f as any).question === "string" && typeof (f as any).answer === "string"
  );

  // カテゴリ強制上書き（手動指定の場合）
  if (categoryOverride) {
    return faqs.map((f) => ({ ...f, category: categoryOverride }));
  }
  return faqs;
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

  // ── インライン認証スタック（モジュールキャッシュ問題を回避） ─────────────────
  // JWT 検証 → req.supabaseUser / req.user をセット
  function knowledgeAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization ?? "";

    if (process.env.NODE_ENV === "development") {
      // development: 署名検証なしでデコードし req.supabaseUser をセット
      if (authHeader.startsWith("Bearer ")) {
        try {
          (req as any).supabaseUser = jwt.decode(authHeader.slice(7).trim());
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
      (req as any).supabaseUser = jwt.verify(token, secret);
      return setUserAndNext(req, next);
    } catch (err) {
      console.warn("[knowledgeAuth] invalid token", err);
      res.status(401).json({ error: "Invalid token" });
    }
  }

  function setUserAndNext(req: Request, next: NextFunction): void {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    (req as any).user = su
      ? {
          id: su.sub ?? su.id ?? "",
          email: su.email ?? "",
          role: su.app_metadata?.role ?? su.user_metadata?.role ?? "anonymous",
          tenantId: su.app_metadata?.tenant_id ?? null,
        }
      : { id: "", email: "", role: "anonymous", tenantId: null };
    next();
  }

  // role チェック（super_admin / client_admin のみ通過）
  function requireKnowledgeRole(req: Request, res: Response, next: NextFunction): void {
    const user = (req as any).user as { role?: string } | undefined;
    if (!user || !["super_admin", "client_admin"].includes(user.role ?? "")) {
      res.status(403).json({ error: "forbidden", message: "この操作を行う権限がありません" });
      return;
    }
    next();
  }

  // テナント所有チェック（super_admin は全テナントにアクセス可）
  function requireKnowledgeTenant(req: Request, res: Response, next: NextFunction): void {
    const user = (req as any).user as { role?: string; tenantId?: string | null } | undefined;
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
    const user = (req as any).user as { role?: string } | undefined;
    const category = req.query.category as string | undefined;

    if (!tenantId && user?.role !== "super_admin") {
      return res.status(400).json({ error: "tenant クエリパラメータが必要です" });
    }

    try {
      const params: unknown[] = [];
      let sql = `SELECT id, tenant_id, question, answer, category, tags, created_at FROM faq_docs`;
      const conditions: string[] = [];

      if (tenantId) {
        params.push(tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      if (category && category !== "all") {
        params.push(category);
        conditions.push(`category = $${params.length}`);
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
      console.error("[GET /v1/admin/knowledge]", err);
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
        const user = (req as any).user;
        if (user?.role !== "super_admin") {
          return res.status(403).json({ error: "グローバルナレッジはSuper Adminのみ削除可能です" });
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
      // 既存FAQ質問を取得（重複防止のためプロンプトに渡す）
      let existingRows: { question: string; answer: string }[] = [];
      if (db) {
        try {
          const r = await db.query(
            "SELECT question, answer FROM faq_docs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50",
            [tenantId]
          );
          existingRows = r.rows as { question: string; answer: string }[];
        } catch { /* non-fatal */ }
      }
      const existingQuestions = existingRows.map((r) => r.question);

      const faqs = await textToFaqs(text, category || null, existingQuestions);
      if (faqs.length === 0) {
        return res.status(422).json({ error: "FAQを生成できませんでした。テキストをもう少し詳しく入力してみてください。" });
      }

      // 重複チェック: バイグラム類似度で既存FAQとのマッチを判定（同義表現も検出）
      const previewWithDuplicate: FaqEntryWithDuplicate[] = faqs.map((faq) => {
        let bestMatch: { question: string; answer: string } | null = null;
        let bestScore = 0;
        for (const row of existingRows) {
          const score = bigramSimilarity(faq.question, row.question);
          if (score > bestScore) { bestScore = score; bestMatch = row; }
        }
        return {
          ...faq,
          duplicate:
            bestMatch && bestScore >= DUPLICATE_THRESHOLD
              ? { existingQuestion: bestMatch.question, existingAnswer: bestMatch.answer }
              : null,
        };
      });

      return res.json({ ok: true, preview: previewWithDuplicate, count: previewWithDuplicate.length });
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
    const target = rawTarget || tenantId;

    // "global" は super_admin のみ許可
    if (target === "global" && (req as any).user?.role !== "super_admin") {
      return res.status(403).json({ error: "グローバルナレッジはSuper Adminのみ登録可能です" });
    }

    // コミット時の重複スキップ: バイグラム類似度が閾値以上の既存FAQはスキップ
    let existingQuestionsAtCommit: string[] = [];
    try {
      const r = await db.query("SELECT question FROM faq_docs WHERE tenant_id = $1", [target]);
      existingQuestionsAtCommit = (r.rows as { question: string }[]).map((row) => row.question);
    } catch { /* non-fatal */ }

    const inserted: number[] = [];
    let skipped = 0;

    for (const faq of faqs) {
      const isDuplicate = existingQuestionsAtCommit.some(
        (q) => bigramSimilarity(faq.question, q) >= DUPLICATE_THRESHOLD
      );
      if (isDuplicate) {
        skipped++;
        continue;
      }
      const faqCategory = categoryOverride || faq.category || "general";
      try {
        const r = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id`,
          [target, faq.question.slice(0, 500), faq.answer.slice(0, 2000), faqCategory]
        );
        const faqId = r.rows[0].id as number;
        inserted.push(faqId);

        const embText = `${faq.question}\n${faq.answer}`;
        insertEmbeddingAsync(db, target, embText, faqId, {
          source: "text",
          faq_id: faqId,
        });
      } catch (err) {
        console.error("[commit] insert failed for faq:", faq.question, err);
      }
    }

    return res.status(201).json({ ok: true, inserted: inserted.length, skipped });
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
    const results: { url: string; faqs: FaqEntryWithDuplicate[]; error?: string }[] = [];

    // 既存FAQ質問を一度だけ取得（重複防止のためプロンプトに渡す）
    let existingRows: { question: string; answer: string }[] = [];
    if (db) {
      try {
        const r = await db.query(
          "SELECT question, answer FROM faq_docs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50",
          [tenantId]
        );
        existingRows = r.rows as { question: string; answer: string }[];
      } catch { /* non-fatal */ }
    }
    const existingQuestions = existingRows.map((r) => r.question);

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

        if (text.length < 50) {
          results.push({ url, faqs: [], error: "ページからテキストを取得できませんでした" });
          continue;
        }

        const faqs = await textToFaqs(text, category || null, existingQuestions);
        const faqsWithDuplicate: FaqEntryWithDuplicate[] = faqs.map((faq) => {
          let bestMatch: { question: string; answer: string } | null = null;
          let bestScore = 0;
          for (const row of existingRows) {
            const score = bigramSimilarity(faq.question, row.question);
            if (score > bestScore) { bestScore = score; bestMatch = row; }
          }
          return {
            ...faq,
            duplicate:
              bestMatch && bestScore >= DUPLICATE_THRESHOLD
                ? { existingQuestion: bestMatch.question, existingAnswer: bestMatch.answer }
                : null,
          };
        });
        results.push({ url, faqs: faqsWithDuplicate });
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
    const target = rawTarget || tenantId;

    // "global" は super_admin のみ許可
    if (target === "global" && (req as any).user?.role !== "super_admin") {
      return res.status(403).json({ error: "グローバルナレッジはSuper Adminのみ登録可能です" });
    }

    // コミット時の重複スキップ: バイグラム類似度が閾値以上の既存FAQはスキップ
    let existingQuestionsAtScrapeCommit: string[] = [];
    try {
      const r = await db.query("SELECT question FROM faq_docs WHERE tenant_id = $1", [target]);
      existingQuestionsAtScrapeCommit = (r.rows as { question: string }[]).map((row) => row.question);
    } catch { /* non-fatal */ }

    let totalInserted = 0;
    let totalSkipped = 0;

    for (const item of items) {
      for (const faq of item.faqs) {
        const isDuplicate = existingQuestionsAtScrapeCommit.some(
          (q) => bigramSimilarity(faq.question, q) >= DUPLICATE_THRESHOLD
        );
        if (isDuplicate) {
          totalSkipped++;
          continue;
        }
        const faqCategory = categoryOverride || faq.category || "general";
        try {
          const r = await db.query(
            `INSERT INTO faq_docs (tenant_id, question, answer, category, tags, is_published)
             VALUES ($1, $2, $3, $4, $5, true)
             RETURNING id`,
            [
              target,
              faq.question.slice(0, 500),
              faq.answer.slice(0, 2000),
              faqCategory,
              [item.url],
            ]
          );
          const faqId = r.rows[0].id as number;
          totalInserted++;

          const embText = `${faq.question}\n${faq.answer}`;
          insertEmbeddingAsync(db, target, embText, faqId, {
            source: "scrape",
            faq_id: faqId,
            url: item.url,
          });
        } catch (err) {
          console.error("[scrape/commit] insert failed", err);
        }
      }
    }

    return res.status(201).json({ ok: true, inserted: totalInserted, skipped: totalSkipped });
  });

  registerFaqCrudRoutes(app, db, knowledgeAuth, requireKnowledgeRole, requireKnowledgeTenant);

  console.log("[knowledgeAdminRoutes] /v1/admin/knowledge routes registered");
}
