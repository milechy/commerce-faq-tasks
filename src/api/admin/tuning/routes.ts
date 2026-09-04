// src/api/admin/tuning/routes.ts

// Phase38 Step4-BE: チューニングルール CRUD API

import { GPT_OSS_120B, groqReasoningParams } from '../../../config/groqModels';
import type { Express, Request, Response } from "express";
import type { AuthedReq } from "../../middleware/roleAuth";
import { roleAuthMiddleware } from "../../middleware/roleAuth";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} from "./tuningRulesRepository";
import { logger } from '../../../lib/logger';
import {
  searchKnowledgeForSuggestion,
  formatKnowledgeContext,
} from '../../../lib/knowledgeSearchUtil';
import {
  getCrossTenantContext,
  formatCrossTenantContext,
} from '../../../lib/crossTenantContext';
import { getResearchProvider } from '../../../lib/research';
import { isDeepResearchEnabled } from '../../../lib/research/featureCheck';
import { buildResearchQuery } from '../../../lib/research/queryBuilder';
import { trackUsage } from '../../../lib/billing/usageTracker';
import { approveTuningRule, rejectTuningRule } from "../evaluations/evaluationsRepository";
import { notifyTenantOfApprovedUpsell } from "../evaluations/routes";
import { buildSuperAdminUpsellFigures } from "../../../lib/billing/billingApi";
import { renderUpsellForSuperAdmin } from "../../../lib/billing/upsellRenderer";
import { isValidUpsellSignal } from "../../../lib/billing/upsellSignals";
import { currentJstPeriodYyyyMm } from "../../../lib/billing/tenantEconomics";
import { getPool } from "../../../lib/db";

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist
// ---------------------------------------------------------------------------

const ALLOWED_TUNING_ROLES = ["super_admin", "client_admin"] as const;
type AllowedTuningRole = typeof ALLOWED_TUNING_ROLES[number];
function isAllowedTuningRole(role: unknown): role is AllowedTuningRole {
  return typeof role === "string" &&
         (ALLOWED_TUNING_ROLES as readonly string[]).includes(role);
}

/**
 * GET /v1/admin/upsell-proposals が1リクエストで文面をレンダリングする
 * pending 提案の上限。tenantEconomics.ts の MAX_TENANTS_PER_ECONOMICS_REQUEST
 * と同じ考え方(1件あたり DB 2回 + Stripe 2回を直列で叩くため、上限が無いと
 * レスポンスタイムが件数に比例して伸び続ける)。超過分は truncated:true で
 * 切り損なった旨を返す(黙って一部だけ返さない)。
 */
const MAX_UPSELL_PROPOSALS_PER_REQUEST = 50;

// ---------------------------------------------------------------------------
// Groq 8b: ルール提案
// ---------------------------------------------------------------------------

export interface SuggestRuleResponse {
  trigger_pattern: string;
  instruction: string;
  priority: number;
  reason: string;
}

export async function callGroq8bSuggest(
  userMsg: string,
  aiMsg: string,
  knowledgeSection: string = '',
  existingRulesSection: string = '',
  crossTenantSection: string = '',
  researchSection: string = '',
): Promise<SuggestRuleResponse> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
  }

  const knowledgePart = knowledgeSection
    ? `\n## 参考ナレッジ（心理学原則・FAQ）\n${knowledgeSection}\n`
    : '';
  const rulesPart = existingRulesSection
    ? `\n## 既存チューニングルール（重複しないルールを提案すること）\n${existingRulesSection}\n`
    : '';
  const crossTenantPart = crossTenantSection
    ? `\n${crossTenantSection}\n`
    : '';
  const researchPart = researchSection
    ? `\n${researchSection}\n`
    : '';

  const prompt = `以下のAIチャットの会話を分析して、AIの応答を改善するためのチューニングルールを1つ提案してください。

【顧客の質問】
${userMsg.slice(0, 500)}

【AIの回答】
${aiMsg.slice(0, 500)}
${knowledgePart}${rulesPart}${crossTenantPart}${researchPart}
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
        model: process.env.GROQ_MODEL_8B ?? GPT_OSS_120B,
        // gpt-oss は推論トークンが max_tokens を食う（groqModels.ts 参照）
        ...groqReasoningParams(process.env.GROQ_MODEL_8B ?? GPT_OSS_120B),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
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

// GID 1216275447729242: 自然言語からのチューニングルール自動生成
// 会話ペア(顧客の質問+AIの回答)ではなく、店舗管理者が書いた自然文の指示から
// トリガー条件と対応指示を構造化して抽出する。
export async function callGroq8bSuggestFromText(
  freeText: string,
  knowledgeSection: string = '',
  existingRulesSection: string = '',
  crossTenantSection: string = '',
): Promise<SuggestRuleResponse> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
  }

  const knowledgePart = knowledgeSection
    ? `\n## 参考ナレッジ（心理学原則・FAQ）\n${knowledgeSection}\n`
    : '';
  const rulesPart = existingRulesSection
    ? `\n## 既存チューニングルール（重複しないルールを提案すること）\n${existingRulesSection}\n`
    : '';
  const crossTenantPart = crossTenantSection
    ? `\n${crossTenantSection}\n`
    : '';

  const prompt = `以下は店舗管理者が自然な言葉で書いた、AIチャットボットへの指示です。
これを解析して、チャットボットのチューニングルール（トリガー条件＋AIへの具体的な指示）として構造化してください。

【管理者の指示】
${freeText.slice(0, 1000)}
${knowledgePart}${rulesPart}${crossTenantPart}
以下のJSON形式のみで回答してください（説明不要）:
{
  "trigger_pattern": "このルールが適用されるキーワードや状況（例: 保証について聞かれた場合）",
  "instruction": "AIへの具体的な指示（管理者の意図を明確な指示文として書き直したもの）",
  "priority": 緊急度・重要度（0〜10の整数）,
  "reason": "この構造化内容にした理由（1〜2文）"
}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL_8B ?? GPT_OSS_120B,
        // gpt-oss は推論トークンが max_tokens を食う（groqModels.ts 参照）
        ...groqReasoningParams(process.env.GROQ_MODEL_8B ?? GPT_OSS_120B),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      return { trigger_pattern: "", instruction: "", priority: 0, reason: "" };
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw: string = data.choices?.[0]?.message?.content?.trim() ?? "";

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

// D5: 実際に意味を持つ値域(admin-ui/src/lib/tuningPriority.ts の3段階表示・
// judgeEvaluator/evaluationAnalyzerの生成値)はいずれも0〜10のみ。-100〜100を
// 許していたのは実態と無関係な過去の値域で、同じルールが旧UIとチャットで
// 違う段階に見えるD5の一因だった(本番データに範囲外値が無いことは移行前に確認済み)。
const createSchema = z.object({
  tenant_id: z.string().min(1).max(100),
  trigger_pattern: z.string().min(1).max(1000),
  expected_behavior: z.string().min(1).max(4000),
  priority: z.number().int().min(0).max(10).optional(),
  // D8: 未指定なら zod が黙って落とし、常に DEFAULT true になっていた
  // (作成モーダルは is_active を送っているのに受け付けていなかった)。
  is_active: z.boolean().optional(),
  source_message_id: z.number().int().positive().nullable().optional(),
});

const approvedResponseSchema = z.object({
  text: z.string().min(1).max(4000),
  style: z.string().max(50),
  reason: z.string().max(1000).optional(),
  approved_at: z.string(),
});

const updateSchema = z.object({
  trigger_pattern: z.string().min(1).max(1000).optional(),
  expected_behavior: z.string().min(1).max(4000).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  is_active: z.boolean().optional(),
  approved_responses: z.array(approvedResponseSchema).optional(),
});

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerTuningRoutes(app: Express): void {
  app.use("/v1/admin/tuning-rules", supabaseAuthMiddleware, roleAuthMiddleware);

  // ★super_admin 限定★ 原価・マージン倍率・粗利を同じ応答に含むため、
  // テナントには絶対に出さない(costCalculator.ts の原価開示方針 H-10)。
  function requireSuperAdminForUpsell(req: Request, res: Response, next: () => void): void {
    const su = (req as AuthedReq).supabaseUser;
    const role = su?.app_metadata?.role;
    if (role !== "super_admin") {
      res.status(403).json({ error: "forbidden", message: "この操作はスーパー管理者のみ実行できます" });
      return;
    }
    next();
  }

  // -----------------------------------------------------------------------
  // GET /v1/admin/upsell-proposals
  //
  // Hermes が投稿した営業提案(proposal_type='upsell', status='pending')を
  // 全テナント横断で一覧し、運営が採否を判断するための面。
  // R6/禁止31(提案の受け皿を増やさない)に従い、永続化先は既存の tuning_rules
  // のまま。ここは「一覧の取得と粗利付き文面のレンダリング」だけを担う。
  //
  // ★原価・粗利は保存済みの値ではなく、その場で計算する★
  // 保存すると価格改定・利用量の変化で数字が古くなる。
  //
  // ★直列で処理する・上限を設ける★
  // 1件あたり buildSuperAdminUpsellFigures が DB 2回 + Stripe 2回を呼ぶ。
  // かつては rows.map + Promise.all で全件を完全並列実行しており、pending
  // 提案が N件あれば最大 4N 回の外部/DB呼び出しが同時発生していた。
  // tenantEconomics.ts の fetchTenantEconomics(MAX_TENANTS_PER_ECONOMICS_REQUEST)
  // と同じ方針で、for...of による直列処理 + 上限件数に揃える。
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/upsell-proposals",
    supabaseAuthMiddleware,
    roleAuthMiddleware,
    requireSuperAdminForUpsell,
    async (_req: Request, res: Response) => {
      try {
        const rows = await listRules(undefined, { proposalType: "upsell", status: "pending" });
        const truncated = rows.length > MAX_UPSELL_PROPOSALS_PER_REQUEST;
        const target = rows.slice(0, MAX_UPSELL_PROPOSALS_PER_REQUEST);
        // ★長期pendingの陳腐化検知(REV-P2b)★
        // 提案投稿時点(evidence.upsell.period_yyyymm)のまま長期pendingで残ると、
        // 運営が開いた「今」ではなく投稿時点の古い月の粗利を見せ続けることになる。
        // ロジックは変えず(currentPlan/periodYyyyMm はそのまま buildSuperAdminUpsellFigures
        // に渡す)、事実を隠さず一覧に開示するだけに留める(Asana起票時のA案)。
        const currentPeriod = currentJstPeriodYyyyMm();

        const proposals: Array<{
          proposal_id: string;
          tenant_id: string;
          renderable: boolean;
          headline?: string;
          lines?: string[];
          period_yyyymm?: string;
          stale?: boolean;
          created_at: unknown;
        }> = [];

        for (const row of target) {
          const evidence = row.evidence as { upsell?: Record<string, unknown> } | null | undefined;
          const upsell = evidence?.upsell;
          const signal = upsell?.["signal"];
          const currentPlan = upsell?.["current_plan"];
          const recommendedPlan = upsell?.["recommended_plan"];
          const periodYyyyMm = upsell?.["period_yyyymm"];

          // evidence が壊れている行(手動編集・移行漏れ等)は、誤った文面を
          // 出すより「レンダリング不可」として素通しする(黙って落とさない)。
          if (
            !isValidUpsellSignal(signal) ||
            typeof currentPlan !== "string" ||
            typeof recommendedPlan !== "string" ||
            typeof periodYyyyMm !== "string"
          ) {
            proposals.push({
              proposal_id: String(row.id),
              tenant_id: row.tenant_id,
              renderable: false,
              created_at: row.created_at,
            });
            continue;
          }

          try {
            const pool = getPool();
            const figures = await buildSuperAdminUpsellFigures(
              pool, row.tenant_id, signal, currentPlan, recommendedPlan, periodYyyyMm,
            );
            const rendered = renderUpsellForSuperAdmin(figures);
            proposals.push({
              proposal_id: String(row.id),
              tenant_id: row.tenant_id,
              renderable: true,
              headline: rendered.headline,
              lines: rendered.lines,
              period_yyyymm: periodYyyyMm,
              stale: periodYyyyMm !== currentPeriod,
              created_at: row.created_at,
            });
          } catch (err) {
            // 1件の計算失敗(Stripe到達不可等)で一覧全体を落とさない。
            logger.warn("[GET /v1/admin/upsell-proposals] figures failed", err);
            proposals.push({
              proposal_id: String(row.id),
              tenant_id: row.tenant_id,
              renderable: false,
              period_yyyymm: periodYyyyMm,
              stale: periodYyyyMm !== currentPeriod,
              created_at: row.created_at,
            });
          }
        }

        return res.json({ proposals, truncated });
      } catch (err) {
        logger.warn("[GET /v1/admin/upsell-proposals]", err);
        return res.status(500).json({ error: "internal_error" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // PUT /v1/admin/upsell-proposals/:id/adopt
  // PUT /v1/admin/upsell-proposals/:id/dismiss
  //
  // ★既存の PUT /v1/admin/tuning/:id/approve|reject とは別エンドポイントにする★
  // 同一URLでロール/文脈による分岐を持たせると、将来フィールドが1つ増えたときに
  // 「FAQチューニングの承認」と「営業案の採否」が同じ意味だと誤解されて
  // 分岐が漏れる。URLが違えば混同事故が構造的に起きず、テストでも固定できる。
  //
  // 内部実装は既存の approveTuningRule/rejectTuningRule をそのまま呼ぶ
  // (D8-2 の is_active 制御はそちらに一本化済み。ここでロジックを複製しない)。
  // -----------------------------------------------------------------------
  app.put(
    "/v1/admin/upsell-proposals/:id/adopt",
    supabaseAuthMiddleware,
    roleAuthMiddleware,
    requireSuperAdminForUpsell,
    async (req: Request, res: Response) => {
      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "invalid_id" });
      }
      try {
        // super_admin 操作なので tenantId 制約は付けない(全テナント対象)。
        const updated = await approveTuningRule(id, undefined);
        if (!updated) {
          return res.status(404).json({ error: "not_found" });
        }
        if (updated.proposal_type !== "upsell") {
          // ★このエンドポイントは upsell 専用★ behavior 提案を誤って
          // ここから承認すると、営業案の文脈のまま本番プロンプトへ入る
          // (is_active=true になる)ため、明示的に拒否する。
          return res.status(409).json({ error: "not_an_upsell_proposal" });
        }
        await notifyTenantOfApprovedUpsell(id);
        return res.json({ ok: true });
      } catch (err) {
        logger.warn("[PUT /v1/admin/upsell-proposals/:id/adopt]", err);
        return res.status(500).json({ error: "internal_error" });
      }
    },
  );

  app.put(
    "/v1/admin/upsell-proposals/:id/dismiss",
    supabaseAuthMiddleware,
    roleAuthMiddleware,
    requireSuperAdminForUpsell,
    async (req: Request, res: Response) => {
      const id = Number(req.params["id"]);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "invalid_id" });
      }
      try {
        const updated = await rejectTuningRule(id, undefined);
        if (!updated) {
          return res.status(404).json({ error: "not_found" });
        }
        if (updated.proposal_type !== "upsell") {
          // ★このエンドポイントは upsell 専用★(adopt と対称にする)。
          return res.status(409).json({ error: "not_an_upsell_proposal" });
        }
        return res.json({ ok: true });
      } catch (err) {
        logger.warn("[PUT /v1/admin/upsell-proposals/:id/dismiss]", err);
        return res.status(500).json({ error: "internal_error" });
      }
    },
  );


  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning/suggest-rule
  // Groq 8b で会話内容からチューニングルールを提案する
  // super_admin + client_admin のみアクセス可
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/tuning/suggest-rule",
    supabaseAuthMiddleware,
    roleAuthMiddleware,
    async (req: Request, res: Response) => {
      const su = (req as AuthedReq).supabaseUser;
      if (!su) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const role = su.app_metadata?.role;
      if (!isAllowedTuningRole(role)) {
        logger.warn({
          event: 'tuning_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_TUNING_ROLES,
          hasAppMetadataRole: !!su.app_metadata?.role,
          hasUserMetadataRole: !!(su as any).user_metadata?.role,
        }, "tuning access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }

      // GID 1216275447729242: {freeText} (自然文の指示) または
      // {userMessage, aiMessage} (会話ペアからの提案・既存) のどちらかを受け付ける
      const { userMessage, aiMessage, freeText } = (req.body ?? {}) as Record<string, unknown>;
      const isFreeTextMode = typeof freeText === "string";

      if (isFreeTextMode) {
        if (!(freeText as string).trim()) {
          return res.status(400).json({ error: "freeText must not be empty" });
        }
      } else {
        if (typeof userMessage !== "string" || typeof aiMessage !== "string") {
          return res.status(400).json({ error: "userMessage and aiMessage are required strings" });
        }
        if (!userMessage.trim() || !aiMessage.trim()) {
          return res.status(400).json({ error: "userMessage and aiMessage must not be empty" });
        }
      }

      const anchorText = isFreeTextMode ? (freeText as string).trim() : (userMessage as string).trim();
      const tenantId: string = su?.app_metadata?.tenant_id ?? ""; // トップレベルclaimは信用しない（P1-2: 越境）

      // deep_researchフラグ確認（DB失敗時はfalse）
      const deepResearchEnabled = await isDeepResearchEnabled(tenantId);

      // ナレッジ検索・既存ルール取得・クロステナント統計・外部リサーチを並行実行
      const [knowledgeCtx, existingRules, crossTenantCtx, researchResult] = await Promise.all([
        tenantId
          ? searchKnowledgeForSuggestion(tenantId, anchorText).catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] }),
        tenantId
          ? listRules(tenantId).catch(() => [])
          : Promise.resolve([]),
        getCrossTenantContext().catch(() => ({ avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [], effectiveRulePatterns: [], totalTenants: 0, dataAsOf: new Date().toISOString() })),
        deepResearchEnabled
          ? (getResearchProvider()?.search(
              buildResearchQuery({ userMessage: anchorText }),
              'ja',
              // PR-1(2026-08-25収益監査): billingContext を渡していなかったため
              // perplexityProvider.ts:83 の trackUsage が呼ばれず、Perplexity($3/$15 per 1M token、
              // 単価表で最高値)の計上が完全に漏れていた。gapRecommender.ts / ai-assist/routes.ts の
              // 既存パターンに合わせる。
              tenantId ? { tenantId, requestId: `admin-tuning-research:${tenantId}:${Date.now()}` } : undefined,
            ) ?? Promise.resolve(null)).catch(() => null)
          : Promise.resolve(null),
      ]);

      const knowledgeSection = formatKnowledgeContext(knowledgeCtx);
      const existingRulesSection = existingRules
        .filter((r) => r.is_active)
        .map((r) => `- [${r.trigger_pattern}] ${r.expected_behavior}`)
        .join('\n');
      const crossTenantSection = formatCrossTenantContext(crossTenantCtx);
      const researchSection = researchResult
        ? `## 外部リサーチ（最新の市場動向・学術知見）\n${researchResult.summary}${researchResult.citations.length > 0 ? '\n参照: ' + researchResult.citations.slice(0, 3).join(', ') : ''}`
        : '';

      const suggestion = isFreeTextMode
        ? await callGroq8bSuggestFromText(
            anchorText,
            knowledgeSection,
            existingRulesSection,
            crossTenantSection,
          )
        : await callGroq8bSuggest(
            anchorText,
            (aiMessage as string).trim(),
            knowledgeSection,
            existingRulesSection,
            crossTenantSection,
            researchSection,
          );

      // GID 1216944003337186: callGroq8bSuggest/FromTextはactionExecutor.tsからも
      // 共有呼び出しされる純粋関数のためtenantIdを持たない。Groqは実トークン数を返すが、
      // ここでは呼び出し元(このハンドラ)でのみ計測し、文字数からの概算トークン数を使う。
      // featureUsed='admin_tuning'はNON_BILLABLE_FEATURESのためStripe請求数量には含まれない
      // （原価可視化のみ）。
      if (tenantId) {
        const promptChars = anchorText.length + knowledgeSection.length + existingRulesSection.length;
        const outputChars = JSON.stringify(suggestion).length;
        trackUsage({
          tenantId,
          requestId: `admin-tuning-suggest:${Date.now()}`,
          model: process.env.GROQ_MODEL_8B ?? GPT_OSS_120B,
          inputTokens: Math.ceil(promptChars / 4),
          outputTokens: Math.ceil(outputChars / 4),
          featureUsed: 'admin_tuning',
        });
      }

      return res.json(suggestion);
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/tuning-rules
  // -----------------------------------------------------------------------
  app.get("/v1/admin/tuning-rules", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const role = su?.app_metadata?.role;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? ""; // トップレベルclaimは信用しない（P1-2: 越境）
    const isSuperAdmin: boolean = role === "super_admin";
    if (!isAllowedTuningRole(role)) {
      logger.warn({
        event: 'tuning_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        requested_path: req.path,
        actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
        actor_role: role,
        required_roles: ALLOWED_TUNING_ROLES,
        hasAppMetadataRole: !!su?.app_metadata?.role,
        hasUserMetadataRole: !!su?.user_metadata?.role,
      }, "tuning access denied: invalid actor role");
      return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
    }

    // super_admin: ?tenant= で絞り込み可（未指定 = 全テナント）
    // client_admin: 自テナント固有 + global のみ
    const tenantFilter: string | undefined = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || undefined)
      : jwtTenantId || undefined;
    // R6: Judge/Hermes提案を同一一覧に出すため、カンマ区切りで複数指定できる
    // (例: source=judge,hermes)。単一値のときは従来通り文字列のまま渡す。
    const rawSource = req.query["source"] as string | undefined;
    const sourceValues = rawSource ? rawSource.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const sourceFilter: string | string[] | undefined =
      sourceValues.length > 1 ? sourceValues : sourceValues[0];
    const statusFilter = (req.query["status"] as string | undefined) || undefined;
    // D8-2: 提案の種別。未指定なら listRules 側が 'behavior' に絞る
    // (営業提案を FAQ チューニング一覧に混ぜない)。
    // 未知の値は既定へ倒す — 任意文字列をそのまま SQL の等値比較に渡さない。
    const rawProposalType = req.query["proposal_type"] as string | undefined;
    const proposalType =
      rawProposalType === "upsell" || rawProposalType === "all" || rawProposalType === "behavior"
        ? rawProposalType
        : undefined;

    try {
      const rules = await listRules(tenantFilter, {
        source: sourceFilter, status: statusFilter, proposalType,
      });
      return res.json({ rules, total: rules.length });
    } catch (err) {
      logger.warn("[GET /v1/admin/tuning-rules]", err);
      return res.status(500).json({ error: "ルール一覧の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /v1/admin/tuning-rules
  // -----------------------------------------------------------------------
  app.post("/v1/admin/tuning-rules", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const role = su?.app_metadata?.role;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? ""; // トップレベルclaimは信用しない（P1-2: 越境）
    const isSuperAdmin: boolean = role === "super_admin";
    const jwtEmail: string = su?.email ?? "";
    if (!isAllowedTuningRole(role)) {
      logger.warn({
        event: 'tuning_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        requested_path: req.path,
        actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
        actor_role: role,
        required_roles: ALLOWED_TUNING_ROLES,
        hasAppMetadataRole: !!su?.app_metadata?.role,
        hasUserMetadataRole: !!su?.user_metadata?.role,
      }, "tuning access denied: invalid actor role");
      return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
    }

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { tenant_id, trigger_pattern, expected_behavior, priority, is_active, source_message_id } =
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
        is_active,
        created_by: jwtEmail || undefined,
        source_message_id: source_message_id ?? null,
      });
      return res.status(201).json(rule);
    } catch (err) {
      logger.warn("[POST /v1/admin/tuning-rules]", err);
      return res.status(500).json({ error: "ルールの作成に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /v1/admin/tuning-rules/:id
  // -----------------------------------------------------------------------
  app.put(
    "/v1/admin/tuning-rules/:id",
    async (req: Request, res: Response) => {
      const su = (req as AuthedReq).supabaseUser;
      const role = su?.app_metadata?.role;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? ""; // トップレベルclaimは信用しない（P1-2: 越境）
      const isSuperAdmin: boolean = role === "super_admin";
      if (!isAllowedTuningRole(role)) {
        logger.warn({
          event: 'tuning_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_TUNING_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!(su as any)?.user_metadata?.role,
        }, "tuning access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }

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
        logger.warn("[PUT /v1/admin/tuning-rules/:id]", err);
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
      const su = (req as AuthedReq).supabaseUser;
      const role = su?.app_metadata?.role;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? ""; // トップレベルclaimは信用しない（P1-2: 越境）
      const isSuperAdmin: boolean = role === "super_admin";
      if (!isAllowedTuningRole(role)) {
        logger.warn({
          event: 'tuning_access_denied',
          reason: 'invalid_role',
          errorCode: 'AUTHZ_ROLE_DENIED',
          requested_path: req.path,
          actor_email: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          actor_role: role,
          required_roles: ALLOWED_TUNING_ROLES,
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!(su as any)?.user_metadata?.role,
        }, "tuning access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTHZ_ROLE_DENIED' });
      }

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
        logger.warn("[DELETE /v1/admin/tuning-rules/:id]", err);
        return res.status(500).json({ error: "ルールの削除に失敗しました" });
      }
    },
  );
}
