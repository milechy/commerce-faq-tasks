// src/api/admin/tuning/testResponseRoutes.ts
// Phase6-B: チューニングルール LLMテスト返答生成API

import type { Express, Request, Response } from "express";
import type { AuthedReq } from "../../middleware/roleAuth";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { logger } from "../../../lib/logger";

const GROQ_MODEL_70B = "llama-3.3-70b-versatile";

export interface TestResponse {
  style: string;
  text: string;
}

export function registerTestResponseRoutes(app: Express): void {
  // supabaseAuthMiddleware を先行登録（スコープを限定するため :id も含む）
  app.use("/v1/admin/tuning-rules/:id/test-responses", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning-rules/:id/test-responses
  // Groq 70b でルールに合ったテスト返答を3パターン生成する
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/tuning-rules/:id/test-responses",
    async (req: Request, res: Response) => {
      const su = (req as AuthedReq).supabaseUser;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "idが不正です" });
      }

      const pool = getPool();

      try {
        // ── ルール取得 ─────────────────────────────────────────────────────
        const ruleRes = await pool.query<{
          trigger_pattern: string;
          expected_behavior: string;
          tenant_id: string;
        }>(
          `SELECT trigger_pattern, expected_behavior, tenant_id
           FROM tuning_rules WHERE id = $1`,
          [id],
        );
        if (ruleRes.rows.length === 0) {
          return res.status(404).json({ error: "ルールが見つかりません" });
        }
        const rule = ruleRes.rows[0]!;

        // テナントアクセス制限
        if (!isSuperAdmin && rule.tenant_id !== jwtTenantId) {
          return res.status(403).json({ error: "アクセス権限がありません" });
        }

        // ── テナントの system_prompt を取得 ────────────────────────────────
        const tenantRes = await pool.query<{ system_prompt: string | null }>(
          `SELECT system_prompt FROM tenants WHERE id = $1`,
          [rule.tenant_id],
        );
        const systemPrompt = tenantRes.rows[0]?.system_prompt?.trim() ?? "";

        // ── Groq 70b 呼び出し ──────────────────────────────────────────────
        const apiKey = process.env.GROQ_API_KEY?.trim();
        if (!apiKey) {
          return res.status(503).json({ error: "GROQ_API_KEY が設定されていません" });
        }

        const prompt = `あなたはAI営業アシスタントです。以下のチューニングルールに従って、顧客の質問に対する返答を3パターン生成してください。

テナントのシステムプロンプト:
${systemPrompt || "(未設定)"}

チューニングルール:
トリガー: ${rule.trigger_pattern || "(常時適用)"}
期待する応答: ${rule.expected_behavior}

出力形式（JSONのみ、前後に説明不要）:
[
  {"style": "丁寧版", "text": "返答文"},
  {"style": "簡潔版", "text": "返答文"},
  {"style": "提案型", "text": "返答文"}
]`;

        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: GROQ_MODEL_70B,
              messages: [{ role: "user", content: prompt }],
              temperature: 0.7,
              max_tokens: 1200,
            }),
          },
        );

        if (!groqRes.ok) {
          logger.warn("[POST test-responses] Groq error", groqRes.status);
          return res.status(502).json({ error: "LLMとの通信に失敗しました" });
        }

        const groqData = await groqRes.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const raw = groqData.choices?.[0]?.message?.content?.trim() ?? "";

        // JSON配列を抽出（markdown code block 対応）
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          logger.warn("[POST test-responses] LLM output not JSON array", raw.slice(0, 200));
          return res.status(502).json({ error: "LLMの出力形式が不正です" });
        }

        const responses = JSON.parse(jsonMatch[0]) as TestResponse[];

        return res.json({ responses });
      } catch (err) {
        logger.warn("[POST test-responses]", err);
        return res.status(500).json({ error: "テスト返答の生成に失敗しました" });
      }
    },
  );
}
