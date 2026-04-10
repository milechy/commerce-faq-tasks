// src/agent/orchestrator/graphNodes.ts
// LangGraph グラフノード群 + グラフ定義

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import crypto from 'crypto';
import pino from 'pino';

import type { PlannerPlan } from '../dialog/types';
import { buildRuleBasedPlan } from '../flow/ruleBasedPlanner';
import {
  type PlannerRoute,
  type PlannerRoutingDecision,
  type RouteContextV2,
  routePlannerModelV2,
} from '../llm/modelRouter';
import { resolveSalesPipelineKind } from './sales/pipelines/pipelineFactory';
import { runSalesPipeline } from './sales/salesPipeline';

import {
  detectIntentHint,
  detectSafetyFlag,
  type DialogInput,
  type RagContext,
} from './flowControl';
import { callPlannerLLM, callAnswerLLM } from './llmCalls';
import { runInitialRagRetrieval } from './ragRetrieval';

const logger = pino();

// ── グラフ状態定義 ────────────────────────────────────────────────────────────

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
        pipelineKind?: 'generic' | 'saas' | 'ec' | 'reservation';
        upsellTriggered?: boolean;
        ctaTriggered?: boolean;
        notes?: string[];
      }
    | undefined
  >(),
});

export type DialogGraphState = typeof DialogStateAnnotation.State;

// ── ユーティリティ ────────────────────────────────────────────────────────────

export function readAvatarFlags() {
  const enabled = (process.env.FF_AVATAR_ENABLED ?? 'false') === 'true';
  const forceOff = (process.env.FF_AVATAR_FORCE_OFF ?? 'false') === 'true';
  return { avatarEnabled: enabled, avatarForceOff: forceOff };
}

export function readKillSwitch() {
  const enabled = (process.env.KILL_SWITCH_AVATAR ?? 'false') === 'true';
  const reason = process.env.KILL_SWITCH_REASON ?? undefined;
  return { enabled, reason };
}

export function newCorrelationId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ── グラフノード ──────────────────────────────────────────────────────────────

export async function contextBuilderNode(
  initialInput: DialogInput,
): Promise<DialogGraphState> {
  const ragContext = await runInitialRagRetrieval(initialInput);

  const depth = (initialInput.history ?? []).length;
  const tokens = ragContext.contextTokens;

  let complexity: 'low' | 'medium' | 'high';
  if (tokens < 512 && depth <= 1) complexity = 'low';
  else if (tokens > 2048 || depth > 6) complexity = 'high';
  else complexity = 'medium';

  const intentHint = detectIntentHint(initialInput);
  const requiresSafeMode = detectSafetyFlag(initialInput);

  const routeContext: RouteContextV2 = {
    contextTokens: tokens,
    recall: ragContext.recall,
    complexity,
    safetyTag: requiresSafeMode ? 'sensitive' : 'none',
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
    'dialog.context.built',
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

export async function plannerNode(state: DialogGraphState): Promise<DialogGraphState> {
  if (process.env.NODE_ENV === 'test') {
    return {
      ...state,
      plannerDecision: {
        route: '20b',
        reasons: ['test-mode'],
        used120bCount: 0,
      },
      plannerSteps: { steps: [], needsClarification: false, confidence: 'low' },
    };
  }

  const intentHint = detectIntentHint(state.input);
  if (!state.routeContext.requiresSafeMode && intentHint !== 'general') {
    const rulePlan = buildRuleBasedPlan(state.input, intentHint);
    if (rulePlan) {
      const decision: PlannerRoutingDecision = {
        route: '20b',
        reasons: [`rule-based:${intentHint}`],
        used120bCount: 0,
      };
      logger.info(
        { intentHint, route: decision.route, reasons: decision.reasons },
        'dialog.planner.rule-based',
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
    'dialog.planner.route.base',
  );

  const ctx = state.routeContext;
  let decision = baseDecision;

  if (decision.route === '20b') {
    if (ctx.requiresSafeMode) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:requires-safe-mode'],
      };
    } else if (
      ctx.contextTokens > 2048 &&
      ctx.used120bCount < (ctx.max120bPerRequest ?? 1)
    ) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:context-tokens-high'],
      };
    } else if (
      ctx.conversationDepth > 6 &&
      ctx.used120bCount < (ctx.max120bPerRequest ?? 1)
    ) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:deep-conversation'],
      };
    } else if (
      ctx.complexity === 'high' &&
      ctx.used120bCount < (ctx.max120bPerRequest ?? 1)
    ) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:complexity-high'],
      };
    }
  }

  logger.info(
    { finalRoute: decision.route, finalReasons: decision.reasons },
    'dialog.planner.route.final',
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
    'dialog.planner.plan',
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

export async function clarifyNode(state: DialogGraphState): Promise<DialogGraphState> {
  const plan = state.plannerSteps;

  if (state.routeContext.requiresSafeMode) return state;

  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length) {
    logger.info({ questions: plan.clarifyingQuestions }, 'dialog.clarify.emit');
    return { ...state, finalText: plan.clarifyingQuestions.join('\n') };
  }

  return state;
}

export async function searchNode(state: DialogGraphState): Promise<DialogGraphState> {
  void state;
  return state;
}

export async function salesNode(state: DialogGraphState): Promise<DialogGraphState> {
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
    'dialog.sales.meta',
  );

  return { ...state, salesMeta: nextMeta };
}

export async function finalNode(state: DialogGraphState): Promise<DialogGraphState> {
  return state;
}

export function routeFromPlanner(state: DialogGraphState): string {
  if (state.routeContext.requiresSafeMode) return 'AnswerNode';

  const plan = state.plannerSteps;
  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length)
    return 'ClarifyNode';

  return 'SalesNode';
}

export async function answerNode(state: DialogGraphState): Promise<DialogGraphState> {
  if (process.env.NODE_ENV === 'test')
    return { ...state, finalText: '[test output]' };

  const plan = state.plannerSteps;

  // Clarifyターンは clarifyNode が入れた finalText を維持（上書きしない）
  if (
    plan &&
    plan.needsClarification &&
    plan.clarifyingQuestions?.length &&
    !state.routeContext.requiresSafeMode
  ) {
    if (state.finalText && state.finalText.length > 0) return state;
    return { ...state, finalText: plan.clarifyingQuestions.join('\n') };
  }

  const route: PlannerRoute = state.plannerDecision?.route ?? '20b';

  logger.info(
    {
      route,
      safeMode: state.routeContext.requiresSafeMode,
      hasPlan: !!plan,
      hasRagContext: !!state.ragContext,
    },
    'dialog.answer.call',
  );

  const answerText = await callAnswerLLM(route, {
    input: state.input,
    ragContext: state.ragContext,
    plannerSteps: state.plannerSteps,
    safeMode: state.routeContext.requiresSafeMode,
  });

  return { ...state, finalText: answerText };
}

// ── グラフ定義 ────────────────────────────────────────────────────────────────

export const dialogGraph = new StateGraph(DialogStateAnnotation)
  .addNode('PlannerNode', plannerNode)
  .addNode('ClarifyNode', clarifyNode)
  .addNode('SearchNode', searchNode)
  .addNode('SalesNode', salesNode)
  .addNode('AnswerNode', answerNode)
  .addNode('FinalNode', finalNode)
  .addEdge(START, 'PlannerNode')
  .addConditionalEdges('PlannerNode', routeFromPlanner)
  .addEdge('ClarifyNode', 'SalesNode')
  .addEdge('SearchNode', 'SalesNode')
  .addEdge('SalesNode', 'AnswerNode')
  .addEdge('AnswerNode', 'FinalNode')
  .addEdge('FinalNode', END)
  .compile();
