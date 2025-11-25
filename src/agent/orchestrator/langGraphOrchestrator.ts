// src/agent/orchestrator/langGraphOrchestrator.ts

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import pino from "pino";

import { PlannerPlan } from "../dialog/types";
import { runSearchAgent } from "../flow/searchAgent";
import { callGroqWith429Retry } from "../llm/groqClient";
import {
  PlannerRoute,
  PlannerRoutingDecision,
  RouteContextV2,
  routePlannerModelV2,
} from "../llm/modelRouter";

import { runSalesPipeline } from "./sales/salesPipeline";
import { resolveSalesPipelineKind } from "./sales/pipelines/pipelineFactory";

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

/**
 * Graph 内でやり取りする状態 (LangGraph Annotation ベース)。
 * LangGraph ではこの State をそのまま node 間で共有する。
 *
 * State は Annotation.Root で定義し、実体の型は typeof DialogStateAnnotation.State から取得する。
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

/**
 * RAG パイプラインから返されるコンテキストの型。
 *
 * DialogGraphState では optional（?）として扱われるが、
 * runInitialRagRetrieval などから戻る値としては必須。
 */
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

/**
 * 初回の RAG 検索を実行し、DialogGraphState.ragContext 相当の値を返す。
 *
 * Phase5: /agent.search と同じハイブリッド + 再ランクパイプラインを再利用するために、
 * runSearchAgent を呼び出して RAG コンテキストを構築する。
 */
async function runInitialRagRetrieval(
  initialInput: DialogInput
): Promise<RagContext> {
  // Phase5: /agent.search と同じハイブリッド + 再ランクパイプラインを再利用するために、
  // runSearchAgent を呼び出して RAG コンテキストを構築する。
  const searchResponse = await runSearchAgent({
    q: initialInput.userMessage,
    topK: 8,
    // Planner はここでは使わず、軽量な Rule-based Planner に任せる。
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

  // 簡易的にトークン数を概算（文字数/4）し、上限を設ける。
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

  return {
    documents,
    // Phase3 の hybridSearch には recall 指標がない前提で null とする。
    recall: null,
    contextTokens,
    stats: {
      searchMs,
      rerankMs,
      rerankEngine,
      totalMs,
    },
  };
}

/**
 * 長期対話向け:
 * - history が一定以上に伸びたら、古いターンを semantic summary (goals / constraints / decisions / open-questions など)
 *   として historySummary に格納し、
 * - 直近のターンだけを残す。
 */
async function summarizeHistoryIfNeeded(
  initialInput: DialogInput
): Promise<DialogInput> {
  const MAX_HISTORY_MESSAGES = 12; // これを超えたらサマリを作る
  const KEEP_RECENT = 6; // 直近はそのまま保持

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

  if (!older.length) {
    return existingSummary ?? "";
  }

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
    {
      logger,
    }
  );

  return raw.trim();
}

/**
 * ContextBuilder Node:
 * - RAG 実行
 * - RouteContextV2 の構築
 */
async function contextBuilderNode(
  initialInput: DialogInput
): Promise<DialogGraphState> {
  // Phase4: 初回の RAG 検索を実行し、RouteContextV2 を構築する。
  const ragContext = await runInitialRagRetrieval(initialInput);

  // 会話の深さとコンテキストトークン数から、ざっくり複雑さを推定する。
  const depth = initialInput.history.length;
  const tokens = ragContext.contextTokens;

  let complexity: "low" | "medium" | "high";
  if (tokens < 512 && depth <= 1) {
    complexity = "low";
  } else if (tokens > 2048 || depth > 6) {
    complexity = "high";
  } else {
    complexity = "medium";
  }

  // DetectIntentHint をルーティング側でも利用しておく
  const intentHint = detectIntentHint(initialInput);

  const requiresSafeMode = detectSafetyFlag(initialInput);
  const routeContext: RouteContextV2 = {
    contextTokens: tokens,
    recall: ragContext.recall,
    complexity,
    safetyTag: requiresSafeMode ? "sensitive" : "none",
    conversationDepth: depth,
    used120bCount: 0,
    max120bPerRequest: 1, // とりあえず 1 回まで
    intentType: intentHint,
    requiresSafeMode,
  };

  const pipelineKind = resolveSalesPipelineKind({
    explicitKind: undefined,
    tenantId: initialInput.tenantId,
  });

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
  };
}

/**
 * Planner Node:
 * - routePlannerModelV2 で 20B/120B を選択
 * - 選択したモデルで Planner LLM を実行
 * - Phase4 ヒューリスティクスで 20B/120B ルーティングを上書き
 */
async function plannerNode(state: DialogGraphState): Promise<DialogGraphState> {
  if (process.env.NODE_ENV === "test") {
    return {
      ...state,
      plannerDecision: {
        route: "20b",
        reasons: ["test-mode"],
        used120bCount: 0,
      },
      plannerSteps: {
        steps: [],
        needsClarification: false,
        confidence: "low",
      },
    };
  }
  // まずは既存の V2 ルーターにルーティングさせる
  const baseDecision = routePlannerModelV2(state.routeContext);

  const ctx = state.routeContext;
  let decision = baseDecision;

  // Phase4 ヒューリスティクス:
  // - セーフティモードが必要な場合
  // - コンテキストトークンが大きい場合
  // - 会話が深い場合
  // などのときに 120B にエスカレートする。
  if (decision.route === "20b") {
    const extraReasons: string[] = [];

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

    // extraReasons 変数は今後拡張用のプレースホルダとして残しておく。
    void extraReasons;
  }

  const plannerSteps = await callPlannerLLM(decision.route, {
    input: state.input,
    ragContext: state.ragContext,
  });

  return {
    ...state,
    plannerDecision: decision,
    plannerSteps,
    // V2 ルーティング結果を routeContext に反映しておく
    routeContext: {
      ...state.routeContext,
      used120bCount: decision.used120bCount,
    },
  };
}

/**
 * Clarify Node:
 * - Planner が Clarify を要求している場合は Clarifying Questions をそのまま出力にする。
 * - それ以外の場合は状態を変更せずに次ノードへ。
 */
async function clarifyNode(state: DialogGraphState): Promise<DialogGraphState> {
  const plan = state.plannerSteps;

  // Safety フラグが立っている場合は Clarify をスキップ（Answer 側で安全な応答に集中する）
  if (state.routeContext.requiresSafeMode) {
    return state;
  }

  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length) {
    const clarificationText = plan.clarifyingQuestions.join("\n");

    return {
      ...state,
      finalText: clarificationText,
    };
  }

  return state;
}

/**
 * Search Node:
 * - PlannerPlan に search ステップが含まれている場合は、その query で再検索して ragContext を更新。
 *   Phase8 では、RAG クエリは ContextBuilder で既に実行済み。将来的に拡張予定。
 */
async function searchNode(state: DialogGraphState): Promise<DialogGraphState> {
  const plan = state.plannerSteps;

  if (!plan) {
    return state;
  }

  // Phase8: SalesStage ベースの PlannerPlan では、RAG クエリは ContextBuilder で既に実行済み。
  // 将来的に「plannerPlan から再検索クエリを組み立てる」場合にここを拡張する。
  return state;
}

/**
 * Sales Node:
 * - PlannerPlan（SalesStage）とヒューリスティックの両方を使ってアップセル / CTA 検出を行い、salesMeta にフラグを立てる。
 * - Phase8 ではルールベースのみ（将来 LLM ベースの SalesAgent に差し替え予定）。
 */
async function salesNode(state: DialogGraphState): Promise<DialogGraphState> {
  // SalesDetectionContext は SalesPipeline 側で定義されているが、
  // ここでは型に依存しない形で必要なフィールドだけ組み立てる。
  const detectionContext = {
    userMessage: state.input.userMessage,
    history: state.input.history,
    plan: state.plannerSteps,
  };

  const prevMeta = state.salesMeta;

  // すでに pipelineKind が入っていればそれを優先し、無ければ tenant 情報から推定する。
  const pipelineKind = resolveSalesPipelineKind({
    explicitKind: prevMeta?.pipelineKind,
    tenantId: state.input.tenantId,
  });

  const nextMeta = runSalesPipeline(detectionContext, prevMeta, {
    tenantId: state.input.tenantId,
    pipelineKind,
  });

  return {
    ...state,
    salesMeta: nextMeta,
  };
}
/**
 * Final Node:
 * - LangGraph 的には特別な処理は行わず、そのまま State を返す。
 * - runDialogGraph 側で DialogOutput にマッピングする。
 */
async function finalNode(state: DialogGraphState): Promise<DialogGraphState> {
  return state;
}

/**
 * PlannerNode のあとにどのノードへ遷移するかを決める Edge 関数。
 * - safety: AnswerNode へ
 * - needsClarification: ClarifyNode へ
 * - それ以外: AnswerNode へ
 */
function routeFromPlanner(state: DialogGraphState): string {
  if (state.routeContext.requiresSafeMode) {
    // セーフモード時は SalesNode を飛ばして直接 AnswerNode へ
    return "AnswerNode";
  }

  const plan = state.plannerSteps;

  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length) {
    return "ClarifyNode";
  }

  // 通常時は SalesNode を通して salesMeta を構築してから AnswerNode へ進む
  return "SalesNode";
}

/**
 * Dialog 用 LangGraph の構築。
 * - ContextBuilder は runDialogGraph の外側で実行し、Planner から先を Graph に乗せる。
 */
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

/**
 * Answer Node:
 * - 実際の Answer LLM を呼び出して応答テキストを生成する。
 */
async function answerNode(state: DialogGraphState): Promise<DialogGraphState> {
  if (process.env.NODE_ENV === "test") {
    return {
      ...state,
      finalText: "[test output]",
    };
  }

  const plan = state.plannerSteps;

  // Clarify ターンの場合は、ClarifyNode が設定した finalText（または clarifyingQuestions）をそのまま返し、
  // Answer LLM は呼ばない。これにより Clarify → SalesNode → AnswerNode → FinalNode という経路でも
  // 質問文が上書きされない。
  if (
    plan &&
    plan.needsClarification &&
    plan.clarifyingQuestions?.length &&
    !state.routeContext.requiresSafeMode
  ) {
    if (state.finalText && state.finalText.length > 0) {
      return state;
    }
    const clarificationText = plan.clarifyingQuestions.join("\n");
    return {
      ...state,
      finalText: clarificationText,
    };
  }

  const route: PlannerRoute = state.plannerDecision?.route ?? "20b"; // 念のためデフォルト 20B

  const answerText = await callAnswerLLM(route, {
    input: state.input,
    ragContext: state.ragContext,
    plannerSteps: state.plannerSteps,
    safeMode: state.routeContext.requiresSafeMode,
  });

  return {
    ...state,
    finalText: answerText,
  };
}

/**
 * LangGraph ベースの Dialog Orchestrator エントリポイント。
 */
export async function runDialogGraph(
  input: DialogInput
): Promise<DialogOutput> {
  // 0. 長期対話向けの履歴サマリ圧縮
  const summarizedInput = await summarizeHistoryIfNeeded(input);

  // 1. Context 構築 (RAG + RouteContextV2)
  const initialState = await contextBuilderNode(summarizedInput);

  // 1.5 シンプルな follow-up などの場合は Planner LLM をスキップして、
  //     既存の fast-path で Answer まで一気に生成
  const fastDecision = routePlannerModelV2(initialState.routeContext);
  if (shouldUseFastAnswer(summarizedInput, initialState.routeContext)) {
    const fastState: DialogGraphState = {
      ...initialState,
      plannerDecision: fastDecision,
    };

    const answered = await answerNode(fastState);

    if (!answered.finalText) {
      return {
        text: "現在うまくお応えできません。しばらくしてからお試しください。",
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

    return {
      text: answered.finalText,
      route: fastDecision.route,
      plannerReasons: fastDecision.reasons,
      plannerPlan: answered.plannerSteps,
      safetyTag: answered.routeContext.safetyTag,
      requiresSafeMode: answered.routeContext.requiresSafeMode,
      ragStats: answered.ragContext?.stats,
      salesMeta: answered.salesMeta,
    };
  }

  // 2. LangGraph 実行（Planner / Clarify / Search / Sales / Answer / Final）
  const finalState = await dialogGraph.invoke(initialState);

  if (!finalState.finalText || !finalState.plannerDecision) {
    // 何かがおかしい場合のフォールバック
    return {
      text: "現在うまくお応えできません。しばらくしてからお試しください。",
      route: "20b",
      plannerReasons: ["fallback:no-final-text-or-decision"],
      plannerPlan: finalState.plannerSteps,
      safetyTag: finalState.routeContext.safetyTag,
      requiresSafeMode: finalState.routeContext.requiresSafeMode,
      ragStats: finalState.ragContext?.stats,
      salesMeta: finalState.salesMeta,
    };
  }

  return {
    text: finalState.finalText,
    route: finalState.plannerDecision.route,
    plannerReasons: finalState.plannerDecision.reasons,
    plannerPlan: finalState.plannerSteps,
    safetyTag: finalState.routeContext.safetyTag,
    requiresSafeMode: finalState.routeContext.requiresSafeMode,
    ragStats: finalState.ragContext?.stats,
    salesMeta: finalState.salesMeta,
  };
}
/**
 * シンプルな follow-up （例: Clarify に答えた 2 ターン目など）では、
 * Planner LLM をスキップして Answer だけを実行するためのヒューリスティック。
 *
 * - safety フラグが立っている場合は常に Planner 経由にする
 * - history がまったく無い初回メッセージでは使わない
 * - shipping / returns / payment / product-info などの典型的なコマース系意図で、
 *   現在メッセージが十分に具体的（文字数がある程度長い）な場合に fast-path を有効にする
 */
function shouldUseFastAnswer(
  input: DialogInput,
  routeContext: RouteContextV2
): boolean {
  if (routeContext.requiresSafeMode) {
    return false;
  }

  const depth = input.history?.length ?? 0;
  if (depth === 0) {
    return false;
  }

  const text = (input.userMessage || "").toLowerCase();
  if (text.length < 15) {
    return false;
  }

  const intent = detectIntentHint(input);
  const fastIntents = ["shipping", "returns", "payment", "product-info"];

  return fastIntents.includes(intent);
}

/**
 * 簡易的なセーフティフラグ検出ヘルパー。
 * 本番環境では専用の safety classifier に置き換える想定。
 */
function detectSafetyFlag(input: DialogInput): boolean {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(" ")
    .toLowerCase();

  const safetyKeywords = [
    // self-harm / suicide (日本語・英語の一部)
    "自殺",
    "死にたい",
    "リストカット",
    "自傷",
    "自殺したい",
    "suicide",
    "kill myself",
    // violence / abuse
    "暴力",
    "虐待",
    "dv",
    "暴行",
    "assault",
    "abuse",
    // illegal activity (ごく一部の一般的なキーワード)
    "違法",
    "犯罪",
    "drug",
    "drugs",
  ];

  return safetyKeywords.some((k) => text.includes(k.toLowerCase()));
}

/**
 * Intent ヒント検出ヘルパー
 */
function detectIntentHint(input: DialogInput): string {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(" ")
    .toLowerCase();

  // shipping / delivery
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
  if (shippingKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return "shipping";
  }

  // returns / refunds / cancellations
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
  if (returnKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return "returns";
  }

  // payment / billing
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
  if (paymentKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return "payment";
  }

  // product information
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
  if (productKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return "product-info";
  }

  return "general";
}

/**
 * Planner 用のプロンプトを組み立てるヘルパ。
 * 実際のプロンプト設計は Phase3 の仕様に合わせてチューニングしてください。
 */
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

/**
 * Answer 用のプロンプトを組み立てるヘルパ。
 */
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

/**
 * 実際の Planner LLM 呼び出し。
 * - Groq GPT-OSS 20B/120B を呼ぶ実装をここに隠蔽する。
 */
async function callPlannerLLM(
  route: PlannerRoute,
  payload: {
    input: DialogInput;
    ragContext?: DialogGraphState["ragContext"];
  }
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
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0,
      maxTokens: 512,
      tag: "planner",
    },
    {
      logger,
    }
  );
  logger.info(
    {
      route,
      model,
      rawPreview: raw.slice(0, 400),
    },
    "planner.raw"
  );

  try {
    const rawJson = JSON.parse(raw) as any;

    if (!rawJson || !Array.isArray(rawJson.steps)) {
      throw new Error("Planner JSON has no steps array");
    }

    // Normalize legacy MultiStepPlanner-style steps (type: "clarify" | "search" | "answer")
    // into SalesStage-based PlannerStep objects (stage: "clarify" | "propose" | "recommend" | "close").
    const normalizedSteps = rawJson.steps.map((step: any, idx: number) => {
      // If it already has stage, assume it is in the new format and return as-is.
      if (step && typeof step === "object" && step.stage) {
        return step;
      }

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

      // Default: treat answer/tool-like steps as recommend-stage
      return {
        id,
        stage: "recommend",
        title,
        description:
          description ||
          "Provide a recommendation or answer based on the gathered context.",
      };
    });

    const normalizedPlan: PlannerPlan = {
      ...rawJson,
      steps: normalizedSteps,
    };

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

/**
 * 実際の Answer LLM 呼び出し。
 * - Groq GPT-OSS 20B/120B を呼ぶ実装をここに隠蔽する。
 */
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

  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a commerce FAQ assistant. Answer clearly, in the user locale, and strictly follow any tool / RAG evidence.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
      maxTokens,
      tag: payload.safeMode ? "answer-safe" : "answer",
    },
    {
      logger,
    }
  );

  return raw;
}
const logger = pino();
