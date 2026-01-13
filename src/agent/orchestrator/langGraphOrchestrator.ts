// src/agent/orchestrator/langGraphOrchestrator.ts

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import crypto from "crypto";
import pino from "pino";

import {
  defaultFlowBudgets,
  getOrInitFlowSessionMeta,
  setFlowSessionMeta,
  toClarifySignature,
  type FlowState,
  type TerminalReason,
} from "../dialog/flowContextStore";
import { PlannerPlan } from "../dialog/types";
import { detectStatePatternLoop } from "../flow/loopDetector";
import { buildRuleBasedPlan } from "../flow/ruleBasedPlanner";
import { runSearchAgent } from "../flow/searchAgent";
import { detectUserStop, detectYesNo } from "../flow/userSignals";
import { callGroqWith429Retry } from "../llm/groqClient";
import {
  PlannerRoute,
  PlannerRoutingDecision,
  RouteContextV2,
  routePlannerModelV2,
} from "../llm/modelRouter";

import { evaluateAvatarPolicy } from "../avatar/avatarPolicy";
import { logPhase22Event } from "../observability/phase22EventLogger";

import { resolveSalesPipelineKind } from "./sales/pipelines/pipelineFactory";
import { runSalesPipeline } from "./sales/salesPipeline";

const logger = pino();

/**
 * /agent.dialog の入力ペイロードのサマリ型。
 * 実際には既存のハンドラの型に合わせて拡張してください。
 */
export interface DialogInput {
  tenantId: string;
  userMessage: string;
  locale: "ja" | "en";
  conversationId: string;
  /**
   * 直近の会話履歴（圧縮前）。
   */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * 圧縮された過去履歴のサマリ。
   * 長期対話時に古い履歴を要約して保持するために利用する。
   */
  historySummary?: string;
}

/**
 * /agent.dialog の最終出力。
 * 実際には root レスポンス型にマージする想定。
 */
export interface DialogOutput {
  text: string;
  route: PlannerRoute;
  plannerReasons: string[];
  /**
   * Planner が生成したマルチステッププラン。
   * HTTP レイヤーで steps / needsClarification などにマッピングするために公開する。
   */
  plannerPlan?: PlannerPlan;
  /**
   * Safety / routing 関連のメタ情報。
   * HTTP レイヤーやログで利用する。
   */
  safetyTag?: string;
  requiresSafeMode?: boolean;
  /**
   * RAG 部分のメトリクス。
   * HTTP レイヤーから meta.ragContext / ragStats へ反映するために公開する。
   */
  ragStats?: {
    searchMs?: number;
    rerankMs?: number;
    rerankEngine?: "heuristic" | "ce" | "ce+fallback";
    totalMs?: number;
  };
  /**
   * SalesPipeline / SalesRules ベースの営業メタ情報。
   * Phase9 では pipelineKind / upsellTriggered / ctaTriggered / notes などを含む。
   */
  salesMeta?: {
    pipelineKind?: "generic" | "saas" | "ec" | "reservation";
    upsellTriggered?: boolean;
    ctaTriggered?: boolean;
    notes?: string[];
  };
}

function buildConfirmPrompt(locale: "ja" | "en"): string {
  return locale === "ja"
    ? "\n\nこの内容で会話を終了してよいですか？（はい / いいえ）"
    : "\n\nIs it OK to end the conversation with this? (yes / no)";
}

function buildTerminalText(
  locale: "ja" | "en",
  reason: TerminalReason
): string {
  if (locale === "en") {
    switch (reason) {
      case "completed":
        return "Understood. Ending the conversation.";
      case "aborted_user":
        return "Understood. Ending the conversation.";
      case "aborted_budget":
        return "We could not complete confirmation. For safety, we are ending this conversation. Please start over if needed.";
      case "aborted_loop_detected":
        return "We detected a repeated loop. For safety, we are ending this conversation. Please start over if needed.";
      case "failed_safe_mode":
        return "For safety reasons, we are ending this conversation.";
      case "escalated_handoff":
        return "We will hand this off to a human agent. Ending the conversation.";
      default:
        return "Ending the conversation.";
    }
  }

  switch (reason) {
    case "completed":
      return "承知しました。会話を終了します。";
    case "aborted_user":
      return "承知しました。会話を終了します。";
    case "aborted_budget":
      return "確認が完了しないため、安全のため会話を終了します。必要なら最初からやり直してください。";
    case "aborted_loop_detected":
      return "同じ確認が繰り返されたため、安全のため会話を終了します。必要なら最初からやり直してください。";
    case "failed_safe_mode":
      return "安全上の理由により、この会話は終了します。";
    case "escalated_handoff":
      return "担当者に引き継ぎます。会話を終了します。";
    default:
      return "会話を終了します。";
  }
}

/**
 * Graph 内でやり取りする状態 (LangGraph Annotation ベース)
 */
const DialogStateAnnotation = Annotation.Root({
  input: Annotation<DialogInput>(),
  ragContext: Annotation<RagContext | undefined>(),
  routeContext: Annotation<RouteContextV2>(),
  plannerDecision: Annotation<PlannerRoutingDecision | undefined>(),
  plannerSteps: Annotation<PlannerPlan | undefined>(),
  finalText: Annotation<string | undefined>(),
  salesMeta: Annotation<
    | {
        pipelineKind?: "generic" | "saas" | "ec" | "reservation";
        upsellTriggered?: boolean;
        ctaTriggered?: boolean;
        notes?: string[];
      }
    | undefined
  >(),
});

export type DialogGraphState = typeof DialogStateAnnotation.State;

type RagContext = {
  documents: Array<{ id: string; score: number; text: string }>;
  recall: number | null;
  contextTokens: number;
  stats?: {
    searchMs?: number;
    rerankMs?: number;
    rerankEngine?: "heuristic" | "ce" | "ce+fallback";
    totalMs?: number;
  };
};

async function runInitialRagRetrieval(
  initialInput: DialogInput
): Promise<RagContext> {
  logger.info(
    {
      tenantId: initialInput.tenantId,
      locale: initialInput.locale,
      preview: initialInput.userMessage.slice(0, 120),
    },
    "dialog.rag.start"
  );

  const searchResponse = await runSearchAgent({
    q: initialInput.userMessage,
    topK: 8,
    useLlmPlanner: false,
    debug: true,
  });

  const rerankDebug = searchResponse.debug?.rerank as
    | {
        items: Array<{ id: string; text: string; score: number }>;
        ce_ms?: number;
        engine?: "heuristic" | "ce" | "ce+fallback";
        rerankEngine?: "heuristic" | "ce" | "ce+fallback";
      }
    | undefined;

  const searchDebug = searchResponse.debug?.search as
    | {
        items: Array<{ id: string; text: string; score: number }>;
        ms?: number;
        note?: string;
      }
    | undefined;

  const items =
    rerankDebug?.items && rerankDebug.items.length
      ? rerankDebug.items
      : searchDebug?.items ?? [];

  const documents = (items ?? []).map((item: any) => ({
    id: String(item.id),
    score: typeof item.score === "number" ? item.score : 0,
    text: String(item.text ?? ""),
  }));

  const totalChars = documents.reduce((sum, doc) => sum + doc.text.length, 0);
  const contextTokens = Math.min(
    4096,
    Math.max(128, Math.floor(totalChars / 4) || 256)
  );

  const searchMs =
    typeof searchDebug?.ms === "number" ? searchDebug.ms : undefined;
  const rerankMs =
    typeof rerankDebug?.ce_ms === "number" ? rerankDebug.ce_ms : undefined;
  const rerankEngine =
    rerankDebug?.rerankEngine ?? rerankDebug?.engine ?? undefined;

  const totalMs =
    typeof searchMs === "number" || typeof rerankMs === "number"
      ? (searchMs ?? 0) + (rerankMs ?? 0)
      : undefined;

  logger.info(
    {
      tenantId: initialInput.tenantId,
      locale: initialInput.locale,
      documents: documents.length,
      searchMs,
      rerankMs,
      rerankEngine,
      totalMs,
    },
    "dialog.rag.finished"
  );

  return {
    documents,
    recall: null,
    contextTokens,
    stats: { searchMs, rerankMs, rerankEngine, totalMs },
  };
}

async function summarizeHistoryIfNeeded(
  initialInput: DialogInput
): Promise<DialogInput> {
  const MAX_HISTORY_MESSAGES = 12;
  const KEEP_RECENT = 6;

  const history = initialInput.history ?? [];
  if (history.length <= MAX_HISTORY_MESSAGES) {
    return initialInput;
  }

  const older = history.slice(0, history.length - KEEP_RECENT);
  const recent = history.slice(-KEEP_RECENT);

  const summary = await summarizeHistoryWithLLM({
    locale: initialInput.locale,
    older,
    existingSummary: initialInput.historySummary,
  });

  return {
    ...initialInput,
    history: recent,
    historySummary: summary,
  };
}

type ConversationTurn = { role: "user" | "assistant"; content: string };

async function summarizeHistoryWithLLM(payload: {
  locale: "ja" | "en";
  older: ConversationTurn[];
  existingSummary?: string;
}): Promise<string> {
  const { locale, older, existingSummary } = payload;

  if (!older.length) return existingSummary ?? "";

  const model = process.env.GROQ_PLANNER_20B_MODEL ?? "groq/compound-mini";

  const turnsText = older
    .map((m, idx) => `${idx + 1}. ${m.role}: ${m.content}`)
    .join("\n");

  const systemContent =
    locale === "ja"
      ? [
          "あなたはコマース FAQ アシスタント向けに会話履歴を要約するアシスタントです。",
          "常に次の 5 つのセクションを、この順番・見出し名で出力してください（足りない情報がある場合でも空で残してください）。",
          "",
          "Goals:",
          "- ユーザーの目的・ゴールを箇条書きでまとめる",
          "",
          "Constraints:",
          "- 配送エリア・予算・支払方法・利用不可なオプションなど、明示された制約を箇条書きでまとめる",
          "",
          "Decisions:",
          "- すでに合意・決定された事項を箇条書きでまとめる",
          "",
          "OpenQuestions:",
          "- まだ解決していない質問や TODO を箇条書きでまとめる",
          "",
          "FAQContext:",
          "- 店舗種別・ユーザー区分・既に説明済みのポリシーなど、補助的な文脈を箇条書きでまとめる",
          "",
          "出力は必ずこの 5 見出しと箇条書きのみを含めてください。余計な説明文や前後の文章は追加しないでください。",
        ].join("\n")
      : [
          "You summarize conversation history for a commerce FAQ assistant.",
          "Always respond using the following 5 sections, in this exact order and with these exact headings (even if some are empty):",
          "",
          "Goals:",
          "- Bullet points summarizing the user’s goals.",
          "",
          "Constraints:",
          "- Bullet points summarizing explicit constraints (delivery region, budget, payment methods, unavailable options, etc.).",
          "",
          "Decisions:",
          "- Bullet points summarizing already agreed or decided items.",
          "",
          "OpenQuestions:",
          "- Bullet points summarizing unresolved questions or TODOs.",
          "",
          "FAQContext:",
          "- Bullet points summarizing any helpful context (store type, user segment, policies already explained, etc.).",
          "",
          "Only output these 5 headings and bullet points. Do not add any additional prose before or after.",
        ].join("\n");

  const userParts: string[] = [];
  if (existingSummary && existingSummary.trim().length > 0) {
    userParts.push(
      locale === "ja"
        ? `これまでのサマリ:\n${existingSummary}`
        : `Existing summary:\n${existingSummary}`
    );
  }
  userParts.push(
    locale === "ja"
      ? `以下の会話ターンを、先ほどのフォーマット (Goals / Constraints / Decisions / OpenQuestions / FAQContext) に従ってセマンティックサマリとしてまとめ直してください:\n${turnsText}`
      : `Rewrite the following conversation turns as a structured semantic summary using the sections (Goals / Constraints / Decisions / OpenQuestions / FAQContext):\n${turnsText}`
  );

  const prompt = userParts.join("\n\n");

  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 384,
      tag: "summary",
    },
    { logger }
  );

  return raw.trim();
}

async function contextBuilderNode(
  initialInput: DialogInput
): Promise<DialogGraphState> {
  const ragContext = await runInitialRagRetrieval(initialInput);

  const history = initialInput.history ?? [];
  const depth = history.length;
  const tokens = ragContext.contextTokens;

  let complexity: "low" | "medium" | "high";
  if (tokens < 512 && depth <= 1) complexity = "low";
  else if (tokens > 2048 || depth > 6) complexity = "high";
  else complexity = "medium";

  const intentHint = detectIntentHint(initialInput);
  const requiresSafeMode = detectSafetyFlag(initialInput);

  const routeContext: RouteContextV2 = {
    contextTokens: tokens,
    recall: ragContext.recall,
    complexity,
    safetyTag: requiresSafeMode ? "sensitive" : "none",
    conversationDepth: depth,
    used120bCount: 0,
    max120bPerRequest: 1,
    intentType: intentHint,
    requiresSafeMode,
  };

  const pipelineKind = resolveSalesPipelineKind({
    explicitKind: undefined,
    tenantId: initialInput.tenantId,
  });

  logger.debug(
    {
      tenantId: initialInput.tenantId,
      locale: initialInput.locale,
      depth,
      tokens,
      complexity,
      intentHint,
      requiresSafeMode,
      pipelineKind,
    },
    "dialog.context.built"
  );

  return {
    input: initialInput,
    ragContext,
    routeContext,
    salesMeta: {
      pipelineKind,
      upsellTriggered: false,
      ctaTriggered: false,
      notes: [],
    },
    plannerDecision: undefined,
    plannerSteps: undefined,
    finalText: undefined,
  };
}

async function plannerNode(state: DialogGraphState): Promise<DialogGraphState> {
  if (process.env.NODE_ENV === "test") {
    return {
      ...state,
      plannerDecision: {
        route: "20b",
        reasons: ["test-mode"],
        used120bCount: 0,
      },
      plannerSteps: { steps: [], needsClarification: false, confidence: "low" },
    };
  }

  const intentHint = detectIntentHint(state.input);
  if (!state.routeContext.requiresSafeMode && intentHint !== "general") {
    const rulePlan = buildRuleBasedPlan(state.input, intentHint);
    if (rulePlan) {
      const decision: PlannerRoutingDecision = {
        route: "20b",
        reasons: [`rule-based:${intentHint}`],
        used120bCount: 0,
      };
      logger.info(
        { intentHint, route: decision.route, reasons: decision.reasons },
        "dialog.planner.rule-based"
      );
      return {
        ...state,
        plannerDecision: decision,
        plannerSteps: rulePlan,
        routeContext: {
          ...state.routeContext,
          used120bCount: decision.used120bCount,
        },
      };
    }
  }

  const baseDecision = routePlannerModelV2(state.routeContext);
  logger.info(
    {
      routeContext: state.routeContext,
      baseRoute: baseDecision.route,
      baseReasons: baseDecision.reasons,
    },
    "dialog.planner.route.base"
  );

  const ctx = state.routeContext;
  let decision = baseDecision;

  if (decision.route === "20b") {
    if (ctx.requiresSafeMode) {
      decision = {
        ...decision,
        route: "120b",
        reasons: [...decision.reasons, "phase4:requires-safe-mode"],
      };
    } else if (
      ctx.contextTokens > 2048 &&
      ctx.used120bCount < (ctx.max120bPerRequest ?? 1)
    ) {
      decision = {
        ...decision,
        route: "120b",
        reasons: [...decision.reasons, "phase4:context-tokens-high"],
      };
    } else if (
      ctx.conversationDepth > 6 &&
      ctx.used120bCount < (ctx.max120bPerRequest ?? 1)
    ) {
      decision = {
        ...decision,
        route: "120b",
        reasons: [...decision.reasons, "phase4:deep-conversation"],
      };
    } else if (
      ctx.complexity === "high" &&
      ctx.used120bCount < (ctx.max120bPerRequest ?? 1)
    ) {
      decision = {
        ...decision,
        route: "120b",
        reasons: [...decision.reasons, "phase4:complexity-high"],
      };
    }
  }

  logger.info(
    { finalRoute: decision.route, finalReasons: decision.reasons },
    "dialog.planner.route.final"
  );

  const plannerSteps = await callPlannerLLM(decision.route, {
    input: state.input,
    ragContext: state.ragContext,
  });

  logger.debug(
    {
      route: decision.route,
      stepCount: Array.isArray(plannerSteps?.steps)
        ? plannerSteps.steps.length
        : 0,
      needsClarification: plannerSteps?.needsClarification ?? false,
    },
    "dialog.planner.plan"
  );

  return {
    ...state,
    plannerDecision: decision,
    plannerSteps,
    routeContext: {
      ...state.routeContext,
      used120bCount: decision.used120bCount,
    },
  };
}

async function clarifyNode(state: DialogGraphState): Promise<DialogGraphState> {
  const plan = state.plannerSteps;

  if (state.routeContext.requiresSafeMode) return state;

  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length) {
    logger.info({ questions: plan.clarifyingQuestions }, "dialog.clarify.emit");
    return { ...state, finalText: plan.clarifyingQuestions.join("\n") };
  }

  return state;
}

async function searchNode(state: DialogGraphState): Promise<DialogGraphState> {
  void state;
  return state;
}

async function salesNode(state: DialogGraphState): Promise<DialogGraphState> {
  const detectionContext = {
    userMessage: state.input.userMessage,
    history: state.input.history,
    plan: state.plannerSteps,
  };

  const prevMeta = state.salesMeta;

  const pipelineKind = resolveSalesPipelineKind({
    explicitKind: prevMeta?.pipelineKind,
    tenantId: state.input.tenantId,
  });

  const nextMeta = runSalesPipeline(detectionContext, prevMeta, {
    tenantId: state.input.tenantId,
    pipelineKind,
  });

  logger.debug(
    {
      tenantId: state.input.tenantId,
      pipelineKind: nextMeta.pipelineKind,
      upsellTriggered: nextMeta.upsellTriggered,
      ctaTriggered: nextMeta.ctaTriggered,
    },
    "dialog.sales.meta"
  );

  return { ...state, salesMeta: nextMeta };
}

async function finalNode(state: DialogGraphState): Promise<DialogGraphState> {
  return state;
}

function routeFromPlanner(state: DialogGraphState): string {
  if (state.routeContext.requiresSafeMode) return "AnswerNode";

  const plan = state.plannerSteps;
  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length)
    return "ClarifyNode";

  return "SalesNode";
}

async function answerNode(state: DialogGraphState): Promise<DialogGraphState> {
  if (process.env.NODE_ENV === "test")
    return { ...state, finalText: "[test output]" };

  const plan = state.plannerSteps;

  // Clarifyターンは clarifyNode が入れた finalText を維持（上書きしない）
  if (
    plan &&
    plan.needsClarification &&
    plan.clarifyingQuestions?.length &&
    !state.routeContext.requiresSafeMode
  ) {
    if (state.finalText && state.finalText.length > 0) return state;
    return { ...state, finalText: plan.clarifyingQuestions.join("\n") };
  }

  const route: PlannerRoute = state.plannerDecision?.route ?? "20b";

  logger.info(
    {
      route,
      safeMode: state.routeContext.requiresSafeMode,
      hasPlan: !!plan,
      hasRagContext: !!state.ragContext,
    },
    "dialog.answer.call"
  );

  const answerText = await callAnswerLLM(route, {
    input: state.input,
    ragContext: state.ragContext,
    plannerSteps: state.plannerSteps,
    safeMode: state.routeContext.requiresSafeMode,
  });

  return { ...state, finalText: answerText };
}

const dialogGraph = new StateGraph(DialogStateAnnotation)
  .addNode("PlannerNode", plannerNode)
  .addNode("ClarifyNode", clarifyNode)
  .addNode("SearchNode", searchNode)
  .addNode("SalesNode", salesNode)
  .addNode("AnswerNode", answerNode)
  .addNode("FinalNode", finalNode)
  .addEdge(START, "PlannerNode")
  .addConditionalEdges("PlannerNode", routeFromPlanner)
  .addEdge("ClarifyNode", "SalesNode")
  .addEdge("SearchNode", "SalesNode")
  .addEdge("SalesNode", "AnswerNode")
  .addEdge("AnswerNode", "FinalNode")
  .addEdge("FinalNode", END)
  .compile();

function readAvatarFlags() {
  const enabled = (process.env.FF_AVATAR_ENABLED ?? "false") === "true";
  const forceOff = (process.env.FF_AVATAR_FORCE_OFF ?? "false") === "true";
  return { avatarEnabled: enabled, avatarForceOff: forceOff };
}

function readKillSwitch() {
  const enabled = (process.env.KILL_SWITCH_AVATAR ?? "false") === "true";
  const reason = process.env.KILL_SWITCH_REASON ?? undefined;
  return { enabled, reason };
}

function newCorrelationId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * LangGraph ベースの Dialog Orchestrator エントリポイント。
 * Phase22: meta.flow による「終端保証」を最優先で適用する。
 */
export async function runDialogGraph(
  input: DialogInput
): Promise<DialogOutput> {
  logger.info(
    {
      tenantId: input.tenantId,
      locale: input.locale,
      conversationId: input.conversationId,
      preview: input.userMessage.slice(0, 120),
    },
    "dialog.run.start"
  );

  // -------------------------
  // Phase22: Flow Controller
  // -------------------------
  const flowKey = {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
  };
  const budgets = defaultFlowBudgets();
  const flow = getOrInitFlowSessionMeta(flowKey);
  const turnIndex = flow.turnIndex + 1;

  // 予算超過 → 強制終端
  if (turnIndex > budgets.maxTurnsPerSession) {
    const next = {
      ...flow,
      turnIndex,
      state: "terminal" as const,
      terminalReason: "aborted_budget" as const,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);
    logger.info(
      { event: "flow.terminal_reached", meta: { flow: next } },
      "phase22.flow.terminal_reached"
    );
    return {
      text: buildTerminalText(input.locale, "aborted_budget"),
      route: "20b",
      plannerReasons: ["phase22:aborted_budget"],
    };
  }

  // confirm 状態なら、graph を呼ばずに Yes/No を決定的に処理して終端へ
  if (flow.state === "confirm") {
    const stop = detectUserStop(input.userMessage);
    const yn = stop ? "stop" : detectYesNo(input.userMessage);

    // Phase22: confirm 入力を必ずログ化（後追い）
    logger.info(
      {
        event: "flow.confirm_input",
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        turnIndex,
        decision: yn, // "yes" | "no" | "unknown" | "stop"
      },
      "phase22.flow.confirm_input"
    );

    if (stop) {
      const next = {
        ...flow,
        turnIndex,
        state: "terminal" as const,
        terminalReason: "aborted_user" as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: "flow.terminal_reached", meta: { flow: next } },
        "phase22.flow.terminal_reached"
      );
      return {
        text: buildTerminalText(input.locale, "aborted_user"),
        route: "20b",
        plannerReasons: ["phase22:aborted_user"],
      };
    }

    if (yn === "yes") {
      const next = {
        ...flow,
        turnIndex,
        state: "terminal" as const,
        terminalReason: "completed" as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: "flow.terminal_reached", meta: { flow: next } },
        "phase22.flow.terminal_reached"
      );
      return {
        text: buildTerminalText(input.locale, "completed"),
        route: "20b",
        plannerReasons: ["phase22:completed"],
      };
    }

    if (yn === "no") {
      // Phase22: no で clarify に戻さない（ループ余地を削る）
      const next = {
        ...flow,
        turnIndex,
        state: "terminal" as const,
        terminalReason: "aborted_user" as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: "flow.terminal_reached", meta: { flow: next } },
        "phase22.flow.terminal_reached"
      );
      return {
        text: buildTerminalText(input.locale, "aborted_user"),
        route: "20b",
        plannerReasons: ["phase22:aborted_user"],
      };
    }

    const confirmRepeats = flow.confirmRepeats + 1;
    // NOTE: maxConfirmRepeats を「許容回数」として扱うため >= にする
    // (例) maxConfirmRepeats=2 なら unknown 2回目で aborted_budget
    if (confirmRepeats >= budgets.maxConfirmRepeats) {
      const next = {
        ...flow,
        turnIndex,
        confirmRepeats,
        state: "terminal" as const,
        terminalReason: "aborted_budget" as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: "flow.terminal_reached", meta: { flow: next } },
        "phase22.flow.terminal_reached"
      );
      return {
        text: buildTerminalText(input.locale, "aborted_budget"),
        route: "20b",
        plannerReasons: ["phase22:aborted_budget"],
      };
    }

    const next = {
      ...flow,
      turnIndex,
      confirmRepeats,
      state: "confirm" as const,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);
    logger.info(
      { event: "flow.enter_state", meta: { flow: next } },
      "phase22.flow.enter_state"
    );
    return {
      text:
        (input.locale === "ja"
          ? "「はい」または「いいえ」でお答えください。"
          : "Please answer with yes or no.") + buildConfirmPrompt(input.locale),
      route: "20b",
      plannerReasons: ["phase22:confirm_retry"],
    };
  }

  // -------------------------
  // Phase22: Avatar Policy (presentation-only)
  // -------------------------
  const correlationId = newCorrelationId();
  const avatarFlags = readAvatarFlags();
  const avatarKill = readKillSwitch();
  const intentHint = detectIntentHint(input);

  const avatarDecision = evaluateAvatarPolicy({
    provider: "lemon_slice",
    locale: input.locale,
    userMessage: input.userMessage,
    history: input.history,
    intentHint,
    flags: avatarFlags,
    killSwitch: avatarKill,
    timing: {
      readinessTimeoutMs: Number(
        process.env.AVATAR_READINESS_TIMEOUT_MS ?? 1500
      ),
    },
  });

  // NOTE: ここでは "ready" を絶対に出さない（UIが嘘をつかない）。
  // requested/disabled/forced-off のみを扱う（presentation-only）。
  if (avatarDecision.status === "forced_off_pii") {
    logPhase22Event(logger, {
      event: "avatar.forced_off_pii",
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: "lemon_slice",
          disableReason: avatarDecision.disableReason,
          piiReasons: avatarDecision.piiReasons ?? [],
        },
      },
    });
  } else if (avatarDecision.status === "disabled_by_flag") {
    logPhase22Event(logger, {
      event: "avatar.disabled_by_flag",
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: "lemon_slice",
          disableReason: avatarDecision.disableReason,
        },
      },
    });
  } else if (avatarDecision.status === "disabled_by_kill_switch") {
    logPhase22Event(logger, {
      event: "avatar.disabled_by_kill_switch",
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: "lemon_slice",
          disableReason: avatarDecision.disableReason,
          killReason: avatarDecision.killReason,
        },
      },
    });
  } else if (avatarDecision.status === "requested") {
    logPhase22Event(logger, {
      event: "avatar.requested",
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: "lemon_slice",
          readinessTimeoutMs: avatarDecision.readinessTimeoutMs,
        },
      },
    });
  }

  // -------------------------
  // Normal dialog execution
  // -------------------------
  const summarizedInput = await summarizeHistoryIfNeeded(input);
  const initialState = await contextBuilderNode(summarizedInput);

  // fast-path
  const fastDecision = routePlannerModelV2(initialState.routeContext);
  if (shouldUseFastAnswer(summarizedInput, initialState.routeContext)) {
    logger.info(
      { route: fastDecision.route, reasons: fastDecision.reasons },
      "dialog.run.fast-path"
    );

    const fastState: DialogGraphState = {
      ...initialState,
      plannerDecision: fastDecision,
    };
    const answered = await answerNode(fastState);

    if (!answered.finalText) {
      logger.warn(
        { route: fastDecision.route },
        "dialog.run.fast-path.no-final-text"
      );
      return {
        text:
          input.locale === "ja"
            ? "現在うまくお応えできません。しばらくしてからお試しください。"
            : "Sorry, I couldn’t generate an answer right now. Please try again.",
        route: fastDecision.route,
        plannerReasons: [
          "fallback:no-final-text-in-fast-path",
          ...fastDecision.reasons,
        ],
        plannerPlan: answered.plannerSteps,
        safetyTag: answered.routeContext.safetyTag,
        requiresSafeMode: answered.routeContext.requiresSafeMode,
        ragStats: answered.ragContext?.stats,
        salesMeta: answered.salesMeta,
      };
    }

    const applied = applyPhase22FlowAfterGeneration({
      input,
      flowKey,
      budgets,
      prevFlow: flow,
      turnIndex,
      isClarifyTurn: false,
      finalText: answered.finalText,
    });
    if (applied.forcedTerminal) return applied.forcedTerminal;

    return {
      text: applied.textWithConfirm,
      route: fastDecision.route,
      plannerReasons: fastDecision.reasons,
      plannerPlan: answered.plannerSteps,
      safetyTag: answered.routeContext.safetyTag,
      requiresSafeMode: answered.routeContext.requiresSafeMode,
      ragStats: answered.ragContext?.stats,
      salesMeta: answered.salesMeta,
    };
  }

  // graph slow-path
  const finalState = await dialogGraph.invoke(initialState);

  if (!finalState.finalText || !finalState.plannerDecision) {
    logger.warn({}, "dialog.run.no-final-text-or-decision");
    return {
      text:
        input.locale === "ja"
          ? "現在うまくお応えできません。しばらくしてからお試しください。"
          : "Sorry, I couldn’t generate an answer right now. Please try again.",
      route: "20b",
      plannerReasons: ["fallback:no-final-text-or-decision"],
      plannerPlan: finalState.plannerSteps,
      safetyTag: finalState.routeContext.safetyTag,
      requiresSafeMode: finalState.routeContext.requiresSafeMode,
      ragStats: finalState.ragContext?.stats,
      salesMeta: finalState.salesMeta,
    };
  }

  logger.info(
    {
      route: finalState.plannerDecision.route,
      reasons: finalState.plannerDecision.reasons,
      safetyTag: finalState.routeContext.safetyTag,
      requiresSafeMode: finalState.routeContext.requiresSafeMode,
    },
    "dialog.run.success"
  );

  const isClarifyTurn =
    Boolean(finalState.plannerSteps?.needsClarification) &&
    Boolean(finalState.plannerSteps?.clarifyingQuestions?.length) &&
    !finalState.routeContext.requiresSafeMode;

  const applied = applyPhase22FlowAfterGeneration({
    input,
    flowKey,
    budgets,
    prevFlow: flow,
    turnIndex,
    isClarifyTurn,
    finalText: finalState.finalText,
  });
  if (applied.forcedTerminal) return applied.forcedTerminal;

  return {
    text: applied.textWithConfirm,
    route: finalState.plannerDecision.route,
    plannerReasons: finalState.plannerDecision.reasons,
    plannerPlan: finalState.plannerSteps,
    safetyTag: finalState.routeContext.safetyTag,
    requiresSafeMode: finalState.routeContext.requiresSafeMode,
    ragStats: finalState.ragContext?.stats,
    salesMeta: finalState.salesMeta,
  };
}

function applyPhase22FlowAfterGeneration(params: {
  input: DialogInput;
  flowKey: { tenantId: string; conversationId: string };
  budgets: ReturnType<typeof defaultFlowBudgets>;
  prevFlow: ReturnType<typeof getOrInitFlowSessionMeta>;
  turnIndex: number;
  isClarifyTurn: boolean;
  finalText: string;
}): { textWithConfirm: string; forcedTerminal?: DialogOutput } {
  const {
    input,
    flowKey,
    budgets,
    prevFlow,
    turnIndex,
    isClarifyTurn,
    finalText,
  } = params;

  const nextState: FlowState = isClarifyTurn ? "clarify" : "confirm";

  // Phase22: recentStates は無制限に増やさない（壊れない）
  const rawRecentStates = [...prevFlow.recentStates, nextState];
  const maxKeep = Math.max(8, budgets.loopWindowTurns * 2);
  const recentStates = rawRecentStates.slice(-maxKeep);

  const loopCheck = detectStatePatternLoop(
    recentStates,
    budgets.loopWindowTurns
  );

  const clarifySig = isClarifyTurn ? toClarifySignature(finalText) : undefined;
  const clarifySignatureLoop =
    isClarifyTurn && clarifySig && prevFlow.lastClarifySignature === clarifySig;

  if (loopCheck.loopDetected || clarifySignatureLoop) {
    const next = {
      ...prevFlow,
      turnIndex,
      state: "terminal" as const,
      terminalReason: "aborted_loop_detected" as const,
      recentStates,
      lastClarifySignature: clarifySig ?? prevFlow.lastClarifySignature,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);

    logger.info(
      {
        event: "flow.loop_detected",
        meta: {
          flow: {
            pattern: loopCheck.pattern,
            loopType: clarifySignatureLoop
              ? "clarify_signature"
              : "state_pattern",
            // Phase22: 後追い用
            recentTail: recentStates.slice(
              -Math.min(recentStates.length, budgets.loopWindowTurns)
            ),
          },
        },
      },
      "phase22.flow.loop_detected"
    );

    logger.info(
      { event: "flow.terminal_reached", meta: { flow: next } },
      "phase22.flow.terminal_reached"
    );

    const text = buildTerminalText(input.locale, "aborted_loop_detected");
    return {
      textWithConfirm: text,
      forcedTerminal: {
        text,
        route: "20b",
        plannerReasons: ["phase22:aborted_loop_detected"],
      },
    };
  }

  const sameStateRepeats =
    prevFlow.state === nextState ? prevFlow.sameStateRepeats + 1 : 0;
  const clarifyRepeats =
    nextState === "clarify" ? prevFlow.clarifyRepeats + 1 : 0;

  // Phase22: 上限に達したら止める（決定性）
  if (
    sameStateRepeats >= budgets.maxSameStateRepeats ||
    clarifyRepeats >= budgets.maxClarifyRepeats
  ) {
    const next = {
      ...prevFlow,
      turnIndex,
      state: "terminal" as const,
      terminalReason: "aborted_budget" as const,
      sameStateRepeats,
      clarifyRepeats,
      recentStates,
      lastClarifySignature: clarifySig ?? prevFlow.lastClarifySignature,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);

    logger.info(
      { event: "flow.terminal_reached", meta: { flow: next } },
      "phase22.flow.terminal_reached"
    );

    const text = buildTerminalText(input.locale, "aborted_budget");
    return {
      textWithConfirm: text,
      forcedTerminal: {
        text,
        route: "20b",
        plannerReasons: ["phase22:aborted_budget"],
      },
    };
  }

  // Phase22: Log exit from previous state
  if (prevFlow.state !== nextState) {
    logger.info(
      {
        event: "flow.exit_state",
        meta: {
          from: prevFlow.state,
          to: nextState,
          turnIndex,
          conversationId: flowKey.conversationId,
        },
      },
      "phase22.flow.exit_state"
    );
  }

  const next = {
    ...prevFlow,
    turnIndex,
    state: nextState,
    sameStateRepeats,
    clarifyRepeats,
    confirmRepeats: nextState === "confirm" ? 0 : prevFlow.confirmRepeats,
    recentStates,
    lastClarifySignature: clarifySig ?? prevFlow.lastClarifySignature,
    lastUpdatedAt: new Date().toISOString(),
  };
  setFlowSessionMeta(flowKey, next);

  // Phase22: Log entry to new state
  if (prevFlow.state !== nextState) {
    logger.info(
      {
        event: "flow.enter_state",
        meta: {
          state: nextState,
          from: prevFlow.state,
          turnIndex,
          conversationId: flowKey.conversationId,
        },
      },
      "phase22.flow.enter_state"
    );
  }

  logger.info(
    { event: "flow.state_updated", meta: { flow: next } },
    "phase22.flow.state_updated"
  );

  const textWithConfirm = isClarifyTurn
    ? finalText
    : finalText + buildConfirmPrompt(input.locale);
  return { textWithConfirm };
}

/**
 * シンプルな follow-up などの場合は Planner LLM をスキップするヒューリスティック。
 */
function shouldUseFastAnswer(
  input: DialogInput,
  routeContext: RouteContextV2
): boolean {
  if (routeContext.requiresSafeMode) return false;

  const intent = detectIntentHint(input);
  const text = (input.userMessage || "").toLowerCase();
  const isClarifyFollowup = looksLikeClarifyFollowup(input);
  const depth = input.history?.length ?? 0;

  if (intent === "general") return isSimpleGeneralFaq(input, routeContext);

  const fastIntents = ["shipping", "returns", "payment", "product-info"];
  if (!fastIntents.includes(intent)) return false;

  if (intent === "payment") return text.length >= 8;
  if (depth === 0) return false;

  const minLength = isClarifyFollowup ? 8 : 15;
  if (text.length < minLength) return false;

  return true;
}

function isSimpleGeneralFaq(
  input: DialogInput,
  routeContext: RouteContextV2
): boolean {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(" ")
    .toLowerCase();

  if (routeContext.conversationDepth > 1) return false;
  if (routeContext.complexity === "high") return false;
  if (text.length > 60) return false;

  const faqKeywords = [
    "営業時間",
    "何時から",
    "何時まで",
    "定休日",
    "休業日",
    "営業日",
    "店舗",
    "ショップ",
    "お店",
    "場所",
    "住所",
    "アクセス",
    "行き方",
    "電話番号",
    "問い合わせ先",
    "お問い合わせ",
    "連絡先",
    "サポート",
    "カスタマーサポート",
  ];
  if (!faqKeywords.some((k) => text.includes(k.toLowerCase()))) return false;

  const complexMarkers = [
    "コツ",
    "やり方",
    "方法",
    "テクニック",
    "戦略",
    "比較",
    "どれがいい",
    "どれが良い",
    "おすすめ",
    "最適",
    "一番",
    "お得",
    "安く",
    "なるべく",
  ];
  if (complexMarkers.some((k) => text.includes(k.toLowerCase()))) return false;

  return true;
}

function looksLikeClarifyFollowup(input: DialogInput): boolean {
  const history = input.history ?? [];
  if (!history.length) return false;

  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastAssistant) return false;

  const t = lastAssistant.content;

  const clarifyPhrases = [
    "どの商品（またはカテゴリ）についての配送・送料を知りたいですか？",
    "お届け先の都道府県（または国）を教えてください。",
    "ご注文番号を教えていただけますか？",
    "返品したい商品の名前または型番（SKU）を教えてください。",
    "返品を希望される理由（サイズ違い・イメージ違い・不良品など）を教えてください。",
    "ご注文番号、購入日、商品の状態、返品理由を教えていただけますか？",
    "購入日を教えてください。",
    "商品の状態はどうですか？",
    "返品理由を教えてください。",
    "どの商品についてのご質問でしょうか？（商品名や型番などを教えてください）",
    "どのような点について知りたいですか？（サイズ感・色・在庫状況・素材など）",
  ];

  return clarifyPhrases.some((phrase) => t.includes(phrase));
}

function detectSafetyFlag(input: DialogInput): boolean {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(" ")
    .toLowerCase();

  const safetyKeywords = [
    "自殺",
    "死にたい",
    "リストカット",
    "自傷",
    "自殺したい",
    "suicide",
    "kill myself",
    "暴力",
    "虐待",
    "dv",
    "暴行",
    "assault",
    "abuse",
    "違法",
    "犯罪",
    "drug",
    "drugs",
  ];

  return safetyKeywords.some((k) => text.includes(k.toLowerCase()));
}

function detectIntentHint(input: DialogInput): string {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(" ")
    .toLowerCase();

  const shippingKeywords = [
    "送料",
    "配送料",
    "配送",
    "お届け",
    "届く",
    "到着",
    "何日",
    "when will it arrive",
    "delivery",
    "shipping",
  ];
  if (shippingKeywords.some((k) => text.includes(k.toLowerCase())))
    return "shipping";

  const returnKeywords = [
    "返品",
    "返金",
    "キャンセル",
    "交換",
    "不良品",
    "return",
    "refund",
    "cancel",
  ];
  if (returnKeywords.some((k) => text.includes(k.toLowerCase())))
    return "returns";

  const paymentKeywords = [
    "支払",
    "支払い",
    "決済",
    "クレジット",
    "カード",
    "請求",
    "領収書",
    "invoice",
    "payment",
    "pay",
  ];
  if (paymentKeywords.some((k) => text.includes(k.toLowerCase())))
    return "payment";

  const productKeywords = [
    "在庫",
    "入荷",
    "サイズ",
    "色",
    "カラー",
    "素材",
    "仕様",
    "詳細",
    "stock",
    "size",
    "color",
    "material",
  ];
  if (productKeywords.some((k) => text.includes(k.toLowerCase())))
    return "product-info";

  return "general";
}

function buildPlannerPrompt(payload: {
  input: DialogInput;
  ragContext?: DialogGraphState["ragContext"];
}): string {
  const { input } = payload;

  const recentLines =
    input.history && input.history.length
      ? input.history
          .slice(-6)
          .map((m, idx) => `${idx + 1}. ${m.role}: ${m.content}`)
          .join("\n")
      : "(no recent messages)";

  const intent = detectIntentHint(input);

  const summaryBlock = input.historySummary
    ? [
        "Summarized earlier conversation (compressed, semantic sections: Goals / Constraints / Decisions / OpenQuestions / FAQContext):",
        input.historySummary,
        "",
        "Recent conversation history (most recent last):",
      ].join("\n")
    : "Recent conversation history (most recent last):";

  return [
    "You are the dialog planner for a commerce FAQ assistant.",
    "You receive a semantic summary of earlier conversation organized into sections: Goals, Constraints, Decisions, OpenQuestions, FAQContext.",
    "Use these sections to respect user constraints, remember agreed decisions, and prioritize unresolved questions when planning steps.",
    `User locale: ${input.locale}`,
    `Detected intent (rough guess): ${intent}`,
    "",
    summaryBlock,
    recentLines,
    "",
    `Current user message: "${input.userMessage}"`,
    "",
    "Output STRICTLY a single JSON object with the following shape:",
    "",
    "{",
    '  "steps": [',
    "    {",
    '      "id": "step_clarify_1",',
    '      "stage": "clarify",',
    '      "title": "用途と地域のヒアリング",',
    '      "description": "ユーザーがどの商品について、どの地域への配送について知りたいかを明確にするための質問を行うステップ。",',
    '      "question": "どの商品を、どの地域にお届け予定でしょうか？"',
    "    },",
    "    {",
    '      "id": "step_propose_1",',
    '      "stage": "propose",',
    '      "title": "基本的な送料ポリシーの提示",',
    '      "description": "店舗全体の一般的な送料ポリシーを説明するステップ。特定の商品／地域が分かっていない場合は、代表的な例で説明する。"',
    "    },",
    "    {",
    '      "id": "step_recommend_1",',
    '      "stage": "recommend",',
    '      "title": "おすすめプランの提示",',
    '      "description": "ユーザーの用途や制約に合わせて、具体的なプランや商品構成を1〜3個ほど提案するステップ。上位プランが適切ならその提案も含める。",',
    '      "productIds": []',
    "    },",
    "    {",
    '      "id": "step_close_1",',
    '      "stage": "close",',
    '      "title": "クロージングと行動提案",',
    '      "description": "不安を1つだけケアしたうえで、次に取るべき具体的な行動（購入／予約／問い合わせなど）を1つ提案するステップ。",',
    '      "cta": "purchase"',
    "    }",
    "  ],",
    '  "needsClarification": true,',
    '  "clarifyingQuestions": ["どの商品・どの地域への配送／送料について知りたいですか？"],',
    '  "followupQueries": [],',
    '  "confidence": "medium"',
    "}",
    "",
    "Rules:",
    "- Respond with JSON ONLY. No prose, no explanation.",
    '- For each step, `stage` MUST be one of: "clarify", "propose", "recommend", "close".',
    '- Use Japanese for all titles, descriptions, and questions when locale is "ja"; use English when locale is "en".',
    '- Clarify (stage="clarify"): ask short, concrete questions to fill missing information (用途 / 地域 / 予算 / 決済方法など)。',
    '- Propose (stage="propose"): summarize a single best-fit plan or policy based on known information and explicit constraints.',
    '- Recommend (stage="recommend"): compare 1〜3 concrete options (プラン／商品) and explain why they are suitable. If appropriate, include a slightly higher plan as an upsell option.',
    '- Close (stage="close"): resolve one key remaining concern and propose exactly ONE clear next action (CTA). Set cta to "purchase", "reserve", "contact", "download", or "other".',
    '- If the current user message clearly answers a previous clarification question, set "needsClarification" to false and do NOT add new clarify steps.',
    '- Use the "Constraints" section in the summary to avoid proposing options that violate explicit user limits (delivery region, budget, payment method, etc.).',
    '- Use the "OpenQuestions" section in the summary to prioritize resolving the most important unresolved question in this turn.',
  ].join("\n");
}

function buildAnswerPrompt(payload: {
  input: DialogInput;
  ragContext?: DialogGraphState["ragContext"];
  plannerSteps?: unknown;
  safeMode?: boolean;
}): string {
  const { input, ragContext, safeMode } = payload;

  const docs = ragContext?.documents ?? [];
  const contextSnippet =
    docs.length > 0
      ? docs
          .slice(0, 3)
          .map((d, idx) => `${idx + 1}. ${d.text}`)
          .join("\n")
      : "(no retrieved documents)";

  const baseLines = [
    input.historySummary
      ? `Summarized prior conversation: ${input.historySummary}`
      : undefined,
    `User message: ${input.userMessage}`,
    "",
    "Context documents (top snippets):",
    contextSnippet,
    "",
  ].filter((v): v is string => Boolean(v));

  const normalInstructions = [
    "Use the above context and any previously executed tools or steps to answer the user.",
    "Keep the answer reasonably concise (around 3–8 short sentences or bullet points).",
    "Avoid large tables or very long paragraphs unless the user explicitly requested them.",
    "If you are not sure, clearly say that you are not sure.",
  ];

  const safeModeInstructions = [
    "The topic may involve sensitive, harmful, or abusive content.",
    "Respond in a cautious, supportive, and neutral tone.",
    "Keep the answer concise (around 3–6 short bullet points or paragraphs).",
    "Do NOT provide explicit instructions that could enable self-harm, violence, abuse, or illegal activities.",
    "Explicitly mention that this is general information and may not fully apply to the user’s specific situation.",
    "If the user appears to be in danger or asking for how to commit harm, politely refuse and instead encourage seeking help from appropriate professionals or authorities.",
    "If you are not sure, clearly say that you are not sure, and avoid speculation.",
  ];

  const instructions = safeMode ? safeModeInstructions : normalInstructions;
  return [...baseLines, ...instructions].join("\n");
}

async function callPlannerLLM(
  route: PlannerRoute,
  payload: { input: DialogInput; ragContext?: DialogGraphState["ragContext"] }
): Promise<PlannerPlan> {
  const model =
    route === "120b"
      ? process.env.GROQ_PLANNER_120B_MODEL ?? "groq/compound"
      : process.env.GROQ_PLANNER_20B_MODEL ?? "groq/compound-mini";

  const prompt = buildPlannerPrompt(payload);

  logger.info(
    {
      route,
      model,
      preview: prompt.slice(0, 400),
      conversationId: payload.input.conversationId,
      userMessagePreview: payload.input.userMessage.slice(0, 120),
    },
    "planner.prompt"
  );

  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are the dialog planner for a commerce FAQ assistant. Always respond with valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      maxTokens: 512,
      tag: "planner",
    },
    { logger }
  );

  logger.info({ route, model, rawPreview: raw.slice(0, 400) }, "planner.raw");

  try {
    const rawJson = JSON.parse(raw) as any;
    if (!rawJson || !Array.isArray(rawJson.steps))
      throw new Error("Planner JSON has no steps array");

    const normalizedSteps = rawJson.steps.map((step: any, idx: number) => {
      if (step && typeof step === "object" && step.stage) return step;

      const id = step.id ?? `step_${idx + 1}`;
      const type = String(step.type ?? "answer");
      const description = String(step.description ?? "");
      const title =
        step.title ??
        (type === "clarify"
          ? "Clarification"
          : type === "search"
          ? "Search context"
          : "Recommendation");

      if (type === "clarify") {
        return {
          id,
          stage: "clarify",
          title,
          description: description || "Clarify user requirements.",
          question:
            Array.isArray(step.questions) && step.questions.length
              ? String(step.questions[0])
              : undefined,
        };
      }

      if (type === "search") {
        return {
          id,
          stage: "propose",
          title,
          description:
            description ||
            "Search related FAQ entries to gather context for the answer.",
        };
      }

      return {
        id,
        stage: "recommend",
        title,
        description:
          description ||
          "Provide a recommendation or answer based on the gathered context.",
      };
    });

    const normalizedPlan: PlannerPlan = { ...rawJson, steps: normalizedSteps };
    return normalizedPlan;
  } catch {
    return {
      steps: [
        {
          id: "fallback_propose_1",
          stage: "propose",
          title: "fallback answer",
          description: "fallback answer step due to planner JSON parse error",
        },
      ],
      needsClarification: false,
      confidence: "low",
      raw,
    } as PlannerPlan;
  }
}

async function callAnswerLLM(
  route: PlannerRoute,
  payload: {
    input: DialogInput;
    ragContext?: DialogGraphState["ragContext"];
    plannerSteps?: unknown;
    safeMode?: boolean;
  }
): Promise<string> {
  const model =
    route === "120b"
      ? process.env.GROQ_ANSWER_120B_MODEL ?? "groq/compound"
      : process.env.GROQ_ANSWER_20B_MODEL ?? "groq/compound-mini";

  const prompt = buildAnswerPrompt(payload);
  const maxTokens = payload.safeMode ? 320 : 256;

  const start = Date.now();
  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a commerce FAQ assistant. Answer clearly, in the user locale, and strictly follow any tool / RAG evidence.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens,
      tag: payload.safeMode ? "answer-safe" : "answer",
    },
    { logger }
  );
  const latencyMs = Date.now() - start;

  logger.info(
    { route, model, safeMode: !!payload.safeMode, latencyMs },
    "dialog.answer.finished"
  );
  return raw;
}
