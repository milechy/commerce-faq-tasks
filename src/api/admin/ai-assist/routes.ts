// src/api/admin/ai-assist/routes.ts
// Phase43 P2: インテント振り分け + RAG統合
// POST /v1/admin/ai-assist/chat

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
// @ts-ignore
import { Pool } from "pg";
import { ADMIN_AI_SYSTEM_PROMPT, isUnanswered } from "./systemPrompt";
import { hybridSearch } from "../../../search/hybrid";

// ---------------------------------------------------------------------------
// DB プール
// ---------------------------------------------------------------------------

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

type Intent = "admin_guide" | "business_faq";
type FeedbackCategory = "operation_guide" | "knowledge_gap" | "other";

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
  const email: string = su?.email ?? "";
  const authenticated: boolean = !!su;
  return { tenantId, email, authenticated };
}

// ---------------------------------------------------------------------------
// インテント判定（Groq 8b — 軽量）
// ---------------------------------------------------------------------------

async function detectIntent(message: string): Promise<Intent> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return "admin_guide";

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "user",
            content: `以下のメッセージが「管理画面の操作方法の質問」か「ビジネス・商品に関する質問」か判定してください。"admin_guide" または "business_faq" のみ返答してください。\nメッセージ: ${message}`,
          },
        ],
        temperature: 0,
        max_tokens: 20,
      }),
    });

    if (!res.ok) return "admin_guide";
    const data = (await res.json()) as any;
    const raw: string = data.choices?.[0]?.message?.content?.trim() ?? "";
    return raw.includes("business_faq") ? "business_faq" : "admin_guide";
  } catch {
    return "admin_guide"; // fail-safe
  }
}

// ---------------------------------------------------------------------------
// Groq LLM 呼び出し（llama-3.1-8b-instant）— admin_guide モード
// ---------------------------------------------------------------------------

async function callGroq8b(userMessage: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: ADMIN_AI_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 300,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Groq LLM 呼び出し（llama-3.3-70b-versatile）— business_faq モード
// ---------------------------------------------------------------------------

async function callGroq70b(userMessage: string, ragContext: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const systemPrompt = ragContext
    ? `あなたはこの会社のAIアシスタントです。
以下のナレッジベースの情報を参考にして、お客様の質問に日本語で親切に回答してください。

回答ルール:
- ナレッジベースの情報を活用して、できるだけ具体的に回答してください
- ナレッジベースに直接的な回答がなくても、関連する情報があればそれを基に回答してください
- 回答は1〜3文で簡潔にしてください
- ナレッジベースに全く関連する情報がない場合のみ「申し訳ございません、その情報はまだ登録されていないようです。」と回答してください

ナレッジベース:
${ragContext}`
    : `あなたはこの会社のAIアシスタントです。「申し訳ございません、その情報はまだ登録されていないようです。」と回答してください。`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// business_faq モード: RAG検索 + 70b回答生成
// ---------------------------------------------------------------------------

async function buildBusinessFaqAnswer(
  message: string,
  tenantId: string
): Promise<{ answer: string; aiAnswered: boolean }> {
  try {
    const pool = getPool();

    // キーワード抽出（句読点除去 + 2文字以上の語）
    const keywords = message.replace(/[？?！!。、]/g, "").split(/\s+/).filter((w) => w.length > 1);

    let rows: Array<{ question: string; answer: string }> = [];

    if (keywords.length > 0) {
      // ILIKE 部分一致検索
      const likeConditions = keywords
        .map((_, i) => `(question ILIKE $${i + 2} OR answer ILIKE $${i + 2})`)
        .join(" OR ");
      const likeParams = keywords.map((k) => `%${k}%`);

      const result = await pool.query<{ question: string; answer: string }>(
        `SELECT question, answer FROM faq_docs WHERE tenant_id = $1 AND (${likeConditions}) LIMIT 5`,
        [tenantId, ...likeParams]
      );
      rows = result.rows;
    }

    // フォールバック: ヒットなしなら最新5件
    if (rows.length === 0) {
      const result = await pool.query<{ question: string; answer: string }>(
        "SELECT question, answer FROM faq_docs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 5",
        [tenantId]
      );
      rows = result.rows;
    }

    console.log(`[ai-assist] FAQ search: ${rows.length} hits for tenant=${tenantId}`);

    // RAGコンテキスト構築（各200文字以内）
    const ragContext = rows
      .map((row) => `Q: ${row.question}\nA: ${row.answer}`.slice(0, 200))
      .join("\n\n");

    console.log(`[ai-assist] ragContext length: ${ragContext.length}`);
    console.log(`[ai-assist] ragContext preview: ${ragContext.slice(0, 100)}`);

    const answer = await callGroq70b(message, ragContext);
    const aiAnswered = rows.length > 0 && !isUnanswered(answer);
    return { answer, aiAnswered };
  } catch (e) {
    console.error("[ai-assist] buildBusinessFaqAnswer error:", e);
    return {
      answer: "現在FAQの検索ができません。しばらくしてから再度お試しください。",
      aiAnswered: false,
    };
  }
}

// ---------------------------------------------------------------------------
// admin_feedback テーブルに記録
// ---------------------------------------------------------------------------

async function recordFeedback(params: {
  tenantId: string;
  email: string;
  message: string;
  aiResponse: string;
  aiAnswered: boolean;
  category: FeedbackCategory;
}): Promise<string | null> {
  // NOT NULL 制約対策: 空文字列は 'unknown' にフォールバック
  const safeTenantId = params.tenantId || "unknown";

  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO admin_feedback
         (tenant_id, user_email, message, ai_response, ai_answered, category)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        safeTenantId,
        params.email || null,
        params.message,
        params.aiResponse,
        params.aiAnswered,
        params.category,
      ]
    );
    const id = result.rows[0]?.id ?? null;
    console.log(
      `[ai-assist] feedback recorded: id=${id} tenant=${safeTenantId} category=${params.category} ai_answered=${params.aiAnswered}`
    );
    return id;
  } catch (err: any) {
    // テーブル未作成 (42P01) はスキップ、それ以外は必ずエラーログを出す
    if (err?.code === "42P01") {
      console.warn("[ai-assist] admin_feedback table not found — run migration_admin_feedback.sql");
    } else {
      console.error("[ai-assist] feedback INSERT failed:", err?.code, err?.message);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const chatSchema = z.object({
  message: z.string().min(1).max(1000),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerAdminAiAssistRoutes(app: Express): void {
  // -----------------------------------------------------------------------
  // POST /v1/admin/ai-assist/chat
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/ai-assist/chat",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { tenantId, email, authenticated } = extractAuth(req);

      // JWT 検証済みであれば通す（super_admin は tenant_id を持たないため tenantId 必須にしない）
      if (!authenticated) {
        return res.status(403).json({ error: "認証情報が取得できません" });
      }

      const parsed = chatSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      const { message } = parsed.data;

      try {
        // 1. インテント判定（tenantId がある場合のみ business_faq を試みる）
        const intent: Intent =
          tenantId ? await detectIntent(message) : "admin_guide";

        // 2. インテント別回答生成
        let answer: string;
        let aiAnswered: boolean;

        if (intent === "business_faq") {
          ({ answer, aiAnswered } = await buildBusinessFaqAnswer(message, tenantId));
        } else {
          answer = await callGroq8b(message);
          aiAnswered = answer ? !isUnanswered(answer) : false;
        }

        if (!answer) {
          return res.status(500).json({ error: "AI応答の生成に失敗しました" });
        }

        // 3. カテゴリ決定
        // admin_guide → operation_guide
        // business_faq + 回答済み → other
        // business_faq + 未回答 → knowledge_gap
        const category: FeedbackCategory =
          intent === "admin_guide"
            ? "operation_guide"
            : aiAnswered
            ? "other"
            : "knowledge_gap";

        // 4. admin_feedback テーブルに記録（tenantId がある場合のみ）
        const feedbackId = tenantId
          ? await recordFeedback({ tenantId, email, message, aiResponse: answer, aiAnswered, category })
          : null;

        return res.json({
          answer,
          ai_answered: aiAnswered,
          feedback_id: feedbackId,
          intent,
        });
      } catch (err) {
        console.warn("[POST /v1/admin/ai-assist/chat]", err);
        return res.status(500).json({ error: "AI応答の生成に失敗しました" });
      }
    }
  );
}
