// src/api/admin/tuning/routes.ts
// Phase38 Step4-BE: チューニングルール CRUD API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} from "./tuningRulesRepository";

// ---------------------------------------------------------------------------
// Groq 8b: ルール提案
// ---------------------------------------------------------------------------

export interface SuggestRuleResponse {
  trigger_pattern: string;
  instruction: string;
  priority: number;
  reason: string;
}

async function callGroq8bSuggest(
  userMsg: string,
  aiMsg: string,
): Promise<SuggestRuleResponse> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
  }

  const prompt = `以下のAIチャットの会話を分析して、AIの応答を改善するためのチューニングルールを1つ提案してください。

【顧客の質問】
${userMsg.slice(0, 500)}

【AIの回答】
${aiMsg.slice(0, 500)}

以下のJSON形式のみで回答してください（説明不要）:
{
  "trigger_pattern": "このルールが適用されるキーワードや状況（例: 価格について聞かれた場合）",
  "instruction": "AIへの具体的な指示（例: 料金プランの詳細を案内し、無料トライアルを提案する）",
  "priority": 会話の改善緊急度（0〜10の整数）,
  "reason": "このルールが必要な理由（1〜2文）"
}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL_8B ?? "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
    }

    const data = (await res.json()) as any;
    const raw: string = data.choices?.[0]?.message?.content?.trim() ?? "";

    // JSON部分を抽出（markdown code block 対応）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      trigger_pattern: String(parsed["trigger_pattern"] ?? "").slice(0, 500),
      instruction: String(parsed["instruction"] ?? "").slice(0, 2000),
      priority: Math.max(0, Math.min(10, Number(parsed["priority"]) || 0)),
      reason: String(parsed["reason"] ?? "").slice(0, 500),
    };
  } catch {
    return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
  }
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const createSchema = z.object({
  tenant_id: z.string().min(1).max(100),
  trigger_pattern: z.string().min(1).max(1000),
  expected_behavior: z.string().min(1).max(4000),
  priority: z.number().int().min(-100).max(100).optional(),
  source_message_id: z.number().int().positive().nullable().optional(),
});

const updateSchema = z.object({
  trigger_pattern: z.string().min(1).max(1000).optional(),
  expected_behavior: z.string().min(1).max(4000).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerTuningRoutes(app: Express): void {
  app.use("/v1/admin/tuning-rules", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning/suggest-rule
  // Groq 8b で会話内容からチューニングルールを提案する
  // super_admin + client_admin のみアクセス可
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/tuning/suggest-rule",
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      if (!su) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const role = su.app_metadata?.role ?? su.user_metadata?.role ?? "";
      if (role !== "super_admin" && role !== "client_admin") {
        return res.status(403).json({ error: "forbidden" });
      }

      const { userMessage, aiMessage } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof userMessage !== "string" || typeof aiMessage !== "string") {
        return res.status(400).json({ error: "userMessage and aiMessage are required strings" });
      }
      if (!userMessage.trim() || !aiMessage.trim()) {
        return res.status(400).json({ error: "userMessage and aiMessage must not be empty" });
      }

      const suggestion = await callGroq8bSuggest(userMessage.trim(), aiMessage.trim());
      return res.json(suggestion);
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/tuning-rules
  // -----------------------------------------------------------------------
  app.get("/v1/admin/tuning-rules", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

    // super_admin: ?tenant= で絞り込み可（未指定 = 全テナント）
    // client_admin: 自テナント固有 + global のみ
    const tenantFilter: string | undefined = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || undefined)
      : jwtTenantId || undefined;

    try {
      const rules = await listRules(tenantFilter);
      return res.json({ rules, total: rules.length });
    } catch (err) {
      console.warn("[GET /v1/admin/tuning-rules]", err);
      return res.status(500).json({ error: "ルール一覧の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning-rules
  // -----------------------------------------------------------------------
  app.post("/v1/admin/tuning-rules", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";
    const jwtEmail: string = su?.email ?? "";

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { tenant_id, trigger_pattern, expected_behavior, priority, source_message_id } =
      parsed.data;

    // client_admin は自テナント以外 (global 含む) に作成不可
    if (!isSuperAdmin && tenant_id !== jwtTenantId) {
      return res.status(403).json({
        error: "他テナントまたはglobalルールは作成できません",
      });
    }

    try {
      const rule = await createRule({
        tenant_id,
        trigger_pattern,
        expected_behavior,
        priority,
        created_by: jwtEmail || undefined,
        source_message_id: source_message_id ?? null,
      });
      return res.status(201).json(rule);
    } catch (err) {
      console.warn("[POST /v1/admin/tuning-rules]", err);
      return res.status(500).json({ error: "ルールの作成に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /v1/admin/tuning-rules/:id
  // -----------------------------------------------------------------------
  app.put(
    "/v1/admin/tuning-rules/:id",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "idが不正です" });
      }

      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_request", details: parsed.error.issues });
      }

      // super_admin はテナント制限なし
      const ownerFilter = isSuperAdmin ? undefined : jwtTenantId;

      try {
        const updated = await updateRule(id, parsed.data, ownerFilter);
        if (!updated) {
          return res
            .status(404)
            .json({ error: "ルールが見つからないかアクセス権限がありません" });
        }
        return res.json(updated);
      } catch (err) {
        console.warn("[PUT /v1/admin/tuning-rules/:id]", err);
        return res.status(500).json({ error: "ルールの更新に失敗しました" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/tuning-rules/:id
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/tuning-rules/:id",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "idが不正です" });
      }

      // super_admin はテナント制限なし、client_admin は自テナントのみ
      const ownerFilter = isSuperAdmin ? undefined : jwtTenantId;

      try {
        const deleted = await deleteRule(id, ownerFilter);
        if (!deleted) {
          return res
            .status(404)
            .json({ error: "ルールが見つからないかアクセス権限がありません" });
        }
        return res.json({ ok: true, id });
      } catch (err) {
        console.warn("[DELETE /v1/admin/tuning-rules/:id]", err);
        return res.status(500).json({ error: "ルールの削除に失敗しました" });
      }
    },
  );
}
