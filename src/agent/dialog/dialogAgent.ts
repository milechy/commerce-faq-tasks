// src/agent/dialog/dialogAgent.ts

import crypto from "node:crypto";
import { runDialogOrchestrator } from "../flow/dialogOrchestrator";
import { planMultiStepQueryWithLlmAsync } from "../flow/llmMultiStepPlannerRuntime";
import { planMultiStepQuery } from "../flow/multiStepPlanner";
import type { CloseIntent } from "../orchestrator/sales/closePromptBuilder";
import type { ProposeIntent } from "../orchestrator/sales/proposePromptBuilder";
import type { RecommendIntent } from "../orchestrator/sales/recommendPromptBuilder";
import { runSalesFlowWithLogging } from "../orchestrator/sales/runSalesFlowWithLogging";
import { detectSalesIntents } from "../orchestrator/sales/salesIntentDetector";
import type { ExtendedSalesMeta } from "../orchestrator/sales/salesOrchestrator";
import { appendToSessionHistory, getSessionHistory } from "./contextStore";
import {
  getSalesSessionMeta,
  updateSalesSessionMeta,
  type SalesSessionKey,
} from "./salesContextStore";
import type { DialogMessage, DialogTurnInput, DialogTurnResult, ProductCard } from "./types";
import { pool } from "../../lib/db";
import { fetchDefaultExcludedIds, mergeExcludedIds } from "../../lib/defaultExcludedIds";

// GID 1216970103691946 (PR-11): SalesFlow の段階(clarify→propose→recommend→close)を
// 次ターンへ引き継ぐかどうかのテナント単位フラグ。CLAUDE.md 禁止35(会話の振る舞いを
// 変える機能を全テナント一斉に有効化しない)のため、tenants.features で段階的に開ける。
// 既定OFF = 従来通り毎ターン previousMeta=undefined(clarify固定)。
// actionExecutor.ts の features->>'avatar' 読み取りと同じ生SQLパターンを踏襲する
// (専用キャッシュ層は作らない。呼び出し頻度は同程度で、既存の前例が非キャッシュのため)。
async function isSalesStageContinuityEnabled(tenantId: string): Promise<boolean> {
  if (!pool) return false;
  try {
    const result = await pool.query<{ enabled: string | null }>(
      `SELECT features->>'sales_stage_continuity' AS enabled FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return result.rows[0]?.enabled === "true";
  } catch {
    return false; // fail-closed: 従来挙動(clarify固定)を維持する
  }
}

// ユーザー入力 + 会話履歴からざっくりトークン数を見積もる。
// （Phase3 v1 では char/4 の雑な近似で十分）
function estimateContextTokens(
  input: string,
  history?: DialogMessage[]
): number {
  const historyText = history?.map((m) => m.content ?? "").join("\n") ?? "";
  const totalChars = input.length + historyText.length;

  const approxTokens = Math.max(1, Math.round(totalChars / 4));
  return approxTokens;
}

function ensureSessionId(sessionId?: string): string {
  if (sessionId && sessionId.length > 0) return sessionId;
  return crypto.randomUUID();
}

const DEFAULT_PROPOSE_INTENT: ProposeIntent = "trial_lesson_offer";
const DEFAULT_RECOMMEND_INTENT: RecommendIntent =
  "recommend_course_based_on_level";
const DEFAULT_CLOSE_INTENT: CloseIntent = "close_next_step_confirmation";

const DEFAULT_PERSONA_TAGS: string[] = ["beginner"];
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID ?? "english-demo";

export async function runDialogTurn(
  input: DialogTurnInput
): Promise<DialogTurnResult> {
  const { message, sessionId, tenantId, options } = input;
  const effectiveTenantId = tenantId ?? DEFAULT_TENANT_ID;

  const effectiveSessionId = ensureSessionId(sessionId);

  // 既存セッション履歴を取得
  const history = getSessionHistory(effectiveTenantId, effectiveSessionId);

  // 1) Multi-Step Planner
  const useMultiStepPlanner = options?.useMultiStepPlanner ?? true;
  const useLlmPlanner = options?.useLlmPlanner === true;

  const contextTokens = estimateContextTokens(message, history);

  const basePlannerOptions = {
    topK: options?.topK,
    language: options?.language,
  };

  let multiStepPlan;

  if (useMultiStepPlanner) {
    multiStepPlan = useLlmPlanner
      ? await planMultiStepQueryWithLlmAsync(
          message,
          {
            ...basePlannerOptions,
            routeContext: {
              contextTokens,
              recall: null,
              complexity: null,
              safetyTag: "none",
            },
          },
          history
        )
      : await planMultiStepQuery(message, basePlannerOptions, history);
  } else {
    // Phase3 v1 では useMultiStepPlanner=false でも内部的には同じ Planner を利用する
    multiStepPlan = await planMultiStepQuery(
      message,
      basePlannerOptions,
      history
    );
  }

  // 1.5) SalesOrchestrator: SalesFlow (Propose など) を評価
  const salesSessionKey: SalesSessionKey = {
    tenantId: effectiveTenantId,
    sessionId: effectiveSessionId,
  };

  const personaTags =
    options?.personaTags && options.personaTags.length > 0
      ? options.personaTags
      : DEFAULT_PERSONA_TAGS;

  // Phase14+: SalesFlow 用の intent を簡易ルールベースで自動検出
  const detectedIntents = detectSalesIntents({
    userMessage: message,
    history: history ?? [],
    plan: multiStepPlan,
  });

  const proposeIntent = detectedIntents.proposeIntent ?? DEFAULT_PROPOSE_INTENT;
  const recommendIntent =
    detectedIntents.recommendIntent ?? DEFAULT_RECOMMEND_INTENT;
  const closeIntent = detectedIntents.closeIntent ?? DEFAULT_CLOSE_INTENT;

  // GID 1216970103691946 (PR-11): フラグONのテナントのみ、前ターンの段階を
  // salesContextStore から読んで引き継ぐ。フラグOFF(既定)は従来通り undefined を
  // 渡し、毎ターン clarify 固定の挙動を変えない。
  const stageContinuityEnabled = await isSalesStageContinuityEnabled(effectiveTenantId);
  const existingSalesMeta = stageContinuityEnabled
    ? getSalesSessionMeta(salesSessionKey)
    : undefined;
  const previousMeta: ExtendedSalesMeta | undefined = existingSalesMeta
    ? ({
        // salesOrchestrator は previousMeta.phase を「前ターンの段階」として読む
        // (result.meta.phase として書き込まれる。ExtendedSalesMeta 自体の型には
        // 含まれていない実行時プロパティのため as any を踏襲する)。
        phase: existingSalesMeta.currentStage,
        proposeTriggered: existingSalesMeta.proposeTriggered,
        recommendTriggered: existingSalesMeta.recommendTriggered,
        closeTriggered: existingSalesMeta.closeTriggered,
        personaTags: existingSalesMeta.personaTags,
      } as ExtendedSalesMeta)
    : undefined;

  const salesResult = await runSalesFlowWithLogging(
    effectiveTenantId,
    effectiveSessionId,
    {
      detection: {
        userMessage: message,
        history: (history ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content ?? "",
          })),
        // Phase17: MultiStepQueryPlan は PlannerPlan と構造が異なるため、
        // sales detection にはまだ渡さない（将来 PlannerPlan 側と揃えてから連携する）
      },
      previousMeta,
      proposeIntent,
      recommendIntent,
      closeIntent,
      personaTags,
    }
  );

  // SalesFlow の現在ステージをセッションメタに保存（次ターンのコンテキスト用）
  if (salesResult.nextStage) {
    const meta = salesResult.meta as ExtendedSalesMeta;
    updateSalesSessionMeta(salesSessionKey, {
      currentStage: salesResult.nextStage,
      proposeTriggered: meta.proposeTriggered,
      recommendTriggered: meta.recommendTriggered,
      closeTriggered: meta.closeTriggered,
      // lastIntent は必要になったタイミングで拡張する
    });
  }

  // 1.6) Phase69-2 [外1] GID 1218086284362759: agentSearchRoute.ts と同じく、
  // テナントの default_excluded_ids をリクエスト側の excluded_ids とマージする。
  const dbDefaultExcludedIds = await fetchDefaultExcludedIds(effectiveTenantId);
  const mergedExcludedIds = mergeExcludedIds(
    options?.excluded_ids,
    dbDefaultExcludedIds
  );

  // 2) Orchestrator に実行を委譲
  const orchestrated = await runDialogOrchestrator({
    plan: multiStepPlan,
    sessionId: effectiveSessionId,
    tenantId: effectiveTenantId,
    history: history ?? [],
    options: {
      topK: options?.topK,
      debug: options?.debug,
      visitorId: options?.visitorId,
      excludedIds: mergedExcludedIds,
    },
  });

  // SalesOrchestrator の結果に応じて、必要なら Sales 用の回答に差し替える
  if (salesResult.nextStage && salesResult.prompt) {
    orchestrated.answer = salesResult.prompt;
    orchestrated.final = true;
    orchestrated.needsClarification = false;
    orchestrated.clarifyingQuestions = undefined;
  }

  // 3) セッション履歴を更新（user 発話 + assistant 回答）
  const updates: DialogMessage[] = [{ role: "user", content: message }];

  if (orchestrated.answer) {
    updates.push({ role: "assistant", content: orchestrated.answer });
  }

  appendToSessionHistory(effectiveTenantId, effectiveSessionId, updates);

  // 4) DialogTurnResult を構築
  const result: DialogTurnResult = {
    sessionId: effectiveSessionId,
    answer: orchestrated.answer,
    detectedIntents,
    steps: orchestrated.steps,
    final: orchestrated.final,
    needsClarification:
      orchestrated.needsClarification ??
      multiStepPlan.needsClarification ??
      false,
    clarifyingQuestions:
      orchestrated.clarifyingQuestions ?? multiStepPlan.clarifyingQuestions,
    promptVariantId: orchestrated.promptVariantId,
    promptVariantName: orchestrated.promptVariantName,
    appliedRuleIds: orchestrated.appliedRuleIds,
    meta: {
      multiStepPlan,
      orchestratorMode: "local",
      needsClarification:
        orchestrated.needsClarification ??
        multiStepPlan.needsClarification ??
        false,
      clarifyingQuestions:
        orchestrated.clarifyingQuestions ?? multiStepPlan.clarifyingQuestions,
      gapSignal: orchestrated.gapSignal,
      // synthesis の実トークン。CHAT_LLM_MODEL レートで課金。
      llmUsage: orchestrated.llmUsage,
      // PR-2(2026-08-25収益監査): query埋め込みは以前 llmUsage に合算しており
      // CHAT_LLM_MODEL レートで誤課金されていた。別単価のため分離して渡す。
      embeddingUsage: orchestrated.embeddingUsage,
      // Subtask 3: マルチステップ planner LLM（GPT-OSS 20B/120B）は chat とは
      // 別モデル単価のため、合算せず各モデルを実レートで別 usage_log として課金する。
      plannerLlmUsages: multiStepPlan.llmUsages,
      ragSources: orchestrated.ragSources,
      ragCategory: orchestrated.category,
    },
  };

  // Phase73: recommend ステージ時に faq_docs から商品メタを取得して productCard に設定
  if (salesResult.nextStage === "recommend" && pool) {
    try {
      const row = await pool.query<{
        id: number;
        question: string;
        product_image_url: string | null;
        product_price: string | null;
        product_cta_url: string | null;
      }>(
        `SELECT id, question, product_image_url, product_price, product_cta_url
         FROM faq_docs
         WHERE tenant_id = $1
           AND product_image_url IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`,
        [effectiveTenantId]
      );
      const meta = row.rows[0];
      if (
        meta &&
        (meta.product_image_url || meta.product_price || meta.product_cta_url)
      ) {
        const card: ProductCard = {
          product_id: String(meta.id),
          name: meta.question.slice(0, 100),
          price: meta.product_price ?? "",
          image_url: meta.product_image_url ?? "",
          cta_url: meta.product_cta_url ?? "",
        };
        result.productCard = card;
      }
    } catch {
      // non-fatal: DB 未適用環境（migration 未実行）でも動作を継続する
    }
  }

  return result;
}
