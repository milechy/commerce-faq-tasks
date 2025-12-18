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
import { appendToSessionHistory, getSessionHistory } from "./contextStore";
import {
  getSalesSessionMeta,
  updateSalesSessionMeta,
  type SalesSessionKey,
} from "./salesContextStore";
import type { DialogMessage, DialogTurnInput, DialogTurnResult } from "./types";

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
  const { message, sessionId, options } = input;

  const effectiveSessionId = ensureSessionId(sessionId);

  // 既存セッション履歴を取得
  const history = getSessionHistory(effectiveSessionId);

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
    tenantId: DEFAULT_TENANT_ID,
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

  const salesResult = await runSalesFlowWithLogging(
    DEFAULT_TENANT_ID,
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
      // Phase16: previousMeta はまだ SalesSessionMeta とは統合していないため、一旦 undefined とする
      previousMeta: undefined,
      proposeIntent,
      recommendIntent,
      closeIntent,
      personaTags,
    }
  );

  // SalesFlow の現在ステージをセッションメタに保存（次ターンのコンテキスト用）
  if (salesResult.nextStage) {
    updateSalesSessionMeta(salesSessionKey, {
      currentStage: salesResult.nextStage,
      // lastIntent や personaTags は必要になったタイミングで拡張する
    });
  }

  // 2) Orchestrator に実行を委譲
  const orchestrated = await runDialogOrchestrator({
    plan: multiStepPlan,
    sessionId: effectiveSessionId,
    history: history ?? [],
    options: {
      topK: options?.topK,
      debug: options?.debug,
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

  appendToSessionHistory(effectiveSessionId, updates);

  // 4) DialogTurnResult を構築
  const result: DialogTurnResult = {
    sessionId: effectiveSessionId,
    answer: orchestrated.answer,
    steps: orchestrated.steps,
    final: orchestrated.final,
    needsClarification:
      orchestrated.needsClarification ??
      multiStepPlan.needsClarification ??
      false,
    clarifyingQuestions:
      orchestrated.clarifyingQuestions ?? multiStepPlan.clarifyingQuestions,
    meta: {
      multiStepPlan,
      orchestratorMode: "local",
      needsClarification:
        orchestrated.needsClarification ??
        multiStepPlan.needsClarification ??
        false,
      clarifyingQuestions:
        orchestrated.clarifyingQuestions ?? multiStepPlan.clarifyingQuestions,
    },
  };

  return result;
}
