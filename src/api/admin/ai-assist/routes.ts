// src/api/admin/ai-assist/routes.ts
// Phase43 P1: 管理画面サポートAI チャットAPI
// POST /v1/admin/ai-assist/chat

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
// @ts-ignore
import { Pool } from "pg";
import { ADMIN_AI_SYSTEM_PROMPT, isUnanswered } from "./systemPrompt";

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
// Groq LLM 呼び出し（llama-3.1-8b-instant）
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
// admin_feedback テーブルに記録
// ---------------------------------------------------------------------------

async function recordFeedback(params: {
  tenantId: string;
  email: string;
  message: string;
  aiResponse: string;
  aiAnswered: boolean;
}): Promise<string | null> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO admin_feedback
         (tenant_id, user_email, message, ai_response, ai_answered, category)
       VALUES ($1, $2, $3, $4, $5, 'operation_guide')
       RETURNING id`,
      [
        params.tenantId,
        params.email || null,
        params.message,
        params.aiResponse,
        params.aiAnswered,
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (err: any) {
    // admin_feedback テーブル未作成の場合は無視
    if (err?.code !== "42P01") {
      console.warn("[ai-assist] feedback recording failed:", err?.message);
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
        // 1. Groq 8b で回答生成
        const answer = await callGroq8b(message);

        if (!answer) {
          return res.status(500).json({ error: "AI応答の生成に失敗しました" });
        }

        // 2. 回答できたか判定
        const aiAnswered = !isUnanswered(answer);

        // 3. admin_feedback テーブルに記録（tenantId がある場合のみ）
        const feedbackId = tenantId
          ? await recordFeedback({ tenantId, email, message, aiResponse: answer, aiAnswered })
          : null;

        return res.json({
          answer,
          ai_answered: aiAnswered,
          feedback_id: feedbackId,
        });
      } catch (err) {
        console.warn("[POST /v1/admin/ai-assist/chat]", err);
        return res.status(500).json({ error: "AI応答の生成に失敗しました" });
      }
    }
  );
}
