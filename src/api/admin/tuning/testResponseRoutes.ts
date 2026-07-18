// src/api/admin/tuning/testResponseRoutes.ts
// Phase6-B: チューニングルール LLMテスト返答生成API

import { GROQ_VERSATILE_70B } from '../../../config/groqModels';
import type { Express, Request, Response } from "express";
import type { AuthedReq } from "../../middleware/roleAuth";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { logger } from "../../../lib/logger";

const GROQ_MODEL_70B = GROQ_VERSATILE_70B;

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist
// ---------------------------------------------------------------------------

const ALLOWED_TEST_RESPONSE_ROLES = ["super_admin", "client_admin"] as const;
type AllowedTestResponseRole = typeof ALLOWED_TEST_RESPONSE_ROLES[number];
function isAllowedTestResponseRole(role: unknown): role is AllowedTestResponseRole {
  return typeof role === "string" &&
         (ALLOWED_TEST_RESPONSE_ROLES as readonly string[]).includes(role);
}

export interface TestResponse {
  style: string;
  text: string;
}

export type GenerateTestResponsesOutcome =
  | { ok: true; responses: TestResponse[] }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'no_api_key' | 'llm_error' | 'invalid_output' };

/**
 * ルールに合ったテスト返答をGroq 70bで3パターン生成する。
 * ルート(POST /v1/admin/tuning-rules/:id/test-responses)とactionExecutor(チャットツール)の
 * 両方から呼ばれる共通ロジック。
 */
export async function generateTestResponses(
  id: number,
  jwtTenantId: string,
  isSuperAdmin: boolean,
): Promise<GenerateTestResponsesOutcome> {
  const pool = getPool();

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
    return { ok: false, reason: 'not_found' };
  }
  const rule = ruleRes.rows[0]!;

  // テナントアクセス制限
  if (!isSuperAdmin && rule.tenant_id !== jwtTenantId) {
    return { ok: false, reason: 'forbidden' };
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
    return { ok: false, reason: 'no_api_key' };
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
    logger.warn("[generateTestResponses] Groq error", groqRes.status);
    return { ok: false, reason: 'llm_error' };
  }

  const groqData = await groqRes.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = groqData.choices?.[0]?.message?.content?.trim() ?? "";

  // JSON配列を抽出（markdown code block 対応）
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn("[generateTestResponses] LLM output not JSON array", raw.slice(0, 200));
    return { ok: false, reason: 'invalid_output' };
  }

  const responses = JSON.parse(jsonMatch[0]) as TestResponse[];
  return { ok: true, responses };
}

export function registerTestResponseRoutes(app: Express): void {
  // supabaseAuthMiddleware を先行登録（スコープを限定するため :id も含む）
  app.use("/v1/admin/tuning-rules/:id/test-responses", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning-rules/:id/test-responses
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/tuning-rules/:id/test-responses",
    async (req: Request, res: Response) => {
      const su = (req as AuthedReq).supabaseUser;
      const role = su?.app_metadata?.role;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean = role === "super_admin";
      if (!isAllowedTestResponseRole(role)) {
        logger.warn({
          event: 'tuning_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_TEST_RESPONSE_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!(su as any)?.user_metadata?.role,
        }, "tuning test-response access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }

      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "idが不正です" });
      }

      try {
        const result = await generateTestResponses(id, jwtTenantId, isSuperAdmin);
        if (!result.ok) {
          switch (result.reason) {
            case 'not_found':
              return res.status(404).json({ error: "ルールが見つかりません" });
            case 'forbidden':
              return res.status(403).json({ error: "アクセス権限がありません" });
            case 'no_api_key':
              return res.status(503).json({ error: "GROQ_API_KEY が設定されていません" });
            case 'llm_error':
              return res.status(502).json({ error: "LLMとの通信に失敗しました" });
            case 'invalid_output':
              return res.status(502).json({ error: "LLMの出力形式が不正です" });
          }
        }
        return res.json({ responses: result.responses });
      } catch (err) {
        logger.warn("[POST test-responses]", err);
        return res.status(500).json({ error: "テスト返答の生成に失敗しました" });
      }
    },
  );
}
