// src/agent/orchestrator/langGraphOrchestrator.ts

import pino from 'pino';

import {
  defaultFlowBudgets,
  getOrInitFlowSessionMeta,
  setFlowSessionMeta,
} from '../dialog/flowContextStore';
import { detectUserStop, detectYesNo } from '../flow/userSignals';
import { evaluateAvatarPolicy } from '../avatar/avatarPolicy';
import { logPhase22Event } from '../observability/phase22EventLogger';
import { routePlannerModelV2 } from '../llm/modelRouter';

import {
  type DialogInput,
  type DialogOutput,
  applyPhase22FlowAfterGeneration,
  shouldUseFastAnswer,
  detectIntentHint,
  buildTerminalText,
  buildConfirmPrompt,
} from './flowControl';
import {
  contextBuilderNode,
  answerNode,
  dialogGraph,
  readAvatarFlags,
  readKillSwitch,
  newCorrelationId,
  type DialogGraphState,
} from './graphNodes';
import { summarizeHistoryIfNeeded } from './ragRetrieval';

// Re-exports for backward compatibility
export type { DialogInput, DialogOutput } from './flowControl';
export type { DialogGraphState } from './graphNodes';

const logger = pino();

/**
 * LangGraph ベースの Dialog Orchestrator エントリポイント。
 * Phase22: meta.flow による「終端保証」を最優先で適用する。
 */
export async function runDialogGraph(
  input: DialogInput,
): Promise<DialogOutput> {
  logger.info(
    {
      tenantId: input.tenantId,
      locale: input.locale,
      conversationId: input.conversationId,
      preview: input.userMessage.slice(0, 120),
    },
    'dialog.run.start',
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
      state: 'terminal' as const,
      terminalReason: 'aborted_budget' as const,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);
    logger.info(
      { event: 'flow.terminal_reached', meta: { flow: next } },
      'phase22.flow.terminal_reached',
    );
    // Phase45 Stream B: fire-and-forget with judgeEvaluator
    if (process.env['JUDGE_AUTO_EVALUATE'] === 'true') {
      const sid = input.conversationId;
      setImmediate(() => {
        import('../judge/judgeEvaluator').then(({ evaluateSession }) =>
          evaluateSession(sid),
        ).catch((err: unknown) => {
          logger.warn({ err, sessionId: sid }, 'judge.auto.failed (non-blocking)');
        });
      });
    }
    return {
      text: buildTerminalText(input.locale, 'aborted_budget'),
      route: '20b',
      plannerReasons: ['phase22:aborted_budget'],
    };
  }

  // confirm 状態なら、graph を呼ばずに Yes/No を決定的に処理して終端へ
  if (flow.state === 'confirm') {
    const stop = detectUserStop(input.userMessage);
    const yn = stop ? 'stop' : detectYesNo(input.userMessage);

    // Phase22: confirm 入力を必ずログ化（後追い）
    logger.info(
      {
        event: 'flow.confirm_input',
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        turnIndex,
        decision: yn, // "yes" | "no" | "unknown" | "stop"
      },
      'phase22.flow.confirm_input',
    );

    if (stop) {
      const next = {
        ...flow,
        turnIndex,
        state: 'terminal' as const,
        terminalReason: 'aborted_user' as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: 'flow.terminal_reached', meta: { flow: next } },
        'phase22.flow.terminal_reached',
      );
      // Phase45 Stream B: fire-and-forget with judgeEvaluator
      if (process.env['JUDGE_AUTO_EVALUATE'] === 'true') {
        const sid = input.conversationId;
        setImmediate(() => {
          import('../judge/judgeEvaluator').then(({ evaluateSession }) =>
            evaluateSession(sid),
          ).catch((err: unknown) => {
            logger.warn({ err, sessionId: sid }, 'judge.auto.failed (non-blocking)');
          });
        });
      }
      return {
        text: buildTerminalText(input.locale, 'aborted_user'),
        route: '20b',
        plannerReasons: ['phase22:aborted_user'],
      };
    }

    if (yn === 'yes') {
      const next = {
        ...flow,
        turnIndex,
        state: 'terminal' as const,
        terminalReason: 'completed' as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: 'flow.terminal_reached', meta: { flow: next } },
        'phase22.flow.terminal_reached',
      );
      // Phase45 Stream B: fire-and-forget with judgeEvaluator
      if (process.env['JUDGE_AUTO_EVALUATE'] === 'true') {
        const sid = input.conversationId;
        setImmediate(() => {
          import('../judge/judgeEvaluator').then(({ evaluateSession }) =>
            evaluateSession(sid),
          ).catch((err: unknown) => {
            logger.warn({ err, sessionId: sid }, 'judge.auto.failed (non-blocking)');
          });
        });
      }
      return {
        text: buildTerminalText(input.locale, 'completed'),
        route: '20b',
        plannerReasons: ['phase22:completed'],
      };
    }

    if (yn === 'no') {
      // Phase22: no で clarify に戻さない（ループ余地を削る）
      const next = {
        ...flow,
        turnIndex,
        state: 'terminal' as const,
        terminalReason: 'aborted_user' as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: 'flow.terminal_reached', meta: { flow: next } },
        'phase22.flow.terminal_reached',
      );
      // Phase45 Stream B: fire-and-forget with judgeEvaluator
      if (process.env['JUDGE_AUTO_EVALUATE'] === 'true') {
        const sid = input.conversationId;
        setImmediate(() => {
          import('../judge/judgeEvaluator').then(({ evaluateSession }) =>
            evaluateSession(sid),
          ).catch((err: unknown) => {
            logger.warn({ err, sessionId: sid }, 'judge.auto.failed (non-blocking)');
          });
        });
      }
      return {
        text: buildTerminalText(input.locale, 'aborted_user'),
        route: '20b',
        plannerReasons: ['phase22:aborted_user'],
      };
    }

    const confirmRepeats = flow.confirmRepeats + 1;
    if (confirmRepeats >= budgets.maxConfirmRepeats) {
      const next = {
        ...flow,
        turnIndex,
        confirmRepeats,
        state: 'terminal' as const,
        terminalReason: 'aborted_budget' as const,
        lastUpdatedAt: new Date().toISOString(),
      };
      setFlowSessionMeta(flowKey, next);
      logger.info(
        { event: 'flow.terminal_reached', meta: { flow: next } },
        'phase22.flow.terminal_reached',
      );
      // Phase45 Stream B: fire-and-forget with judgeEvaluator
      if (process.env['JUDGE_AUTO_EVALUATE'] === 'true') {
        const sid = input.conversationId;
        setImmediate(() => {
          import('../judge/judgeEvaluator').then(({ evaluateSession }) =>
            evaluateSession(sid),
          ).catch((err: unknown) => {
            logger.warn({ err, sessionId: sid }, 'judge.auto.failed (non-blocking)');
          });
        });
      }
      return {
        text: buildTerminalText(input.locale, 'aborted_budget'),
        route: '20b',
        plannerReasons: ['phase22:aborted_budget'],
      };
    }

    const next = {
      ...flow,
      turnIndex,
      confirmRepeats,
      state: 'confirm' as const,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);
    logger.info(
      { event: 'flow.enter_state', meta: { flow: next } },
      'phase22.flow.enter_state',
    );
    return {
      text:
        (input.locale === 'ja'
          ? '「はい」または「いいえ」でお答えください。'
          : 'Please answer with yes or no.') + buildConfirmPrompt(input.locale),
      route: '20b',
      plannerReasons: ['phase22:confirm_retry'],
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
    provider: 'lemon_slice',
    locale: input.locale,
    userMessage: input.userMessage,
    history: input.history,
    intentHint,
    flags: avatarFlags,
    killSwitch: avatarKill,
    timing: {
      readinessTimeoutMs: Number(
        process.env.AVATAR_READINESS_TIMEOUT_MS ?? 1500,
      ),
    },
  });

  // NOTE: ここでは "ready" を絶対に出さない（UIが嘘をつかない）。
  // requested/disabled/forced-off のみを扱う（presentation-only）。
  if (avatarDecision.status === 'forced_off_pii') {
    logPhase22Event(logger, {
      event: 'avatar.forced_off_pii',
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: 'lemon_slice',
          disableReason: avatarDecision.disableReason,
          piiReasons: avatarDecision.piiReasons ?? [],
        },
      },
    });
  } else if (avatarDecision.status === 'disabled_by_flag') {
    logPhase22Event(logger, {
      event: 'avatar.disabled_by_flag',
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: 'lemon_slice',
          disableReason: avatarDecision.disableReason,
        },
      },
    });
  } else if (avatarDecision.status === 'disabled_by_kill_switch') {
    logPhase22Event(logger, {
      event: 'avatar.disabled_by_kill_switch',
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: 'lemon_slice',
          disableReason: avatarDecision.disableReason,
          killReason: avatarDecision.killReason,
        },
      },
    });
  } else if (avatarDecision.status === 'requested') {
    logPhase22Event(logger, {
      event: 'avatar.requested',
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      correlationId,
      meta: {
        avatar: {
          provider: 'lemon_slice',
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
      'dialog.run.fast-path',
    );

    const fastState: DialogGraphState = {
      ...initialState,
      plannerDecision: fastDecision,
    };
    const answered = await answerNode(fastState);

    if (!answered.finalText) {
      logger.warn(
        { route: fastDecision.route },
        'dialog.run.fast-path.no-final-text',
      );
      return {
        text:
          input.locale === 'ja'
            ? '現在うまくお応えできません。しばらくしてからお試しください。'
            : "Sorry, I couldn't generate an answer right now. Please try again.",
        route: fastDecision.route,
        plannerReasons: [
          'fallback:no-final-text-in-fast-path',
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
    logger.warn({}, 'dialog.run.no-final-text-or-decision');
    return {
      text:
        input.locale === 'ja'
          ? '現在うまくお応えできません。しばらくしてからお試しください。'
          : "Sorry, I couldn't generate an answer right now. Please try again.",
      route: '20b',
      plannerReasons: ['fallback:no-final-text-or-decision'],
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
    'dialog.run.success',
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
