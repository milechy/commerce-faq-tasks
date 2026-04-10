// src/agent/orchestrator/flowControl.ts
// 共有型定義 + Phase22 フロー制御 + ルーティング判定ヘルパー

import pino from 'pino';
import {
  defaultFlowBudgets,
  getOrInitFlowSessionMeta,
  setFlowSessionMeta,
  toClarifySignature,
  type FlowState,
  type TerminalReason,
} from '../dialog/flowContextStore';
import { detectStatePatternLoop } from '../flow/loopDetector';
import type { PlannerPlan } from '../dialog/types';
import type { PlannerRoute, RouteContextV2 } from '../llm/modelRouter';

const logger = pino();

// ── 共有型定義 ───────────────────────────────────────────────────────────────

/**
 * /agent.dialog の入力ペイロードのサマリ型。
 */
export interface DialogInput {
  tenantId: string;
  userMessage: string;
  locale: 'ja' | 'en';
  conversationId: string;
  /** 直近の会話履歴（圧縮前）。 */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 圧縮された過去履歴のサマリ。 */
  historySummary?: string;
}

/**
 * /agent.dialog の最終出力。
 */
export interface DialogOutput {
  text: string;
  route: PlannerRoute;
  plannerReasons: string[];
  /** Planner が生成したマルチステッププラン。 */
  plannerPlan?: PlannerPlan;
  safetyTag?: string;
  requiresSafeMode?: boolean;
  ragStats?: {
    searchMs?: number;
    rerankMs?: number;
    rerankEngine?: 'heuristic' | 'ce' | 'ce+fallback';
    totalMs?: number;
  };
  salesMeta?: {
    pipelineKind?: 'generic' | 'saas' | 'ec' | 'reservation';
    upsellTriggered?: boolean;
    ctaTriggered?: boolean;
    notes?: string[];
  };
}

export type RagContext = {
  documents: Array<{ id: string; score: number; text: string }>;
  recall: number | null;
  contextTokens: number;
  stats?: {
    searchMs?: number;
    rerankMs?: number;
    rerankEngine?: 'heuristic' | 'ce' | 'ce+fallback';
    totalMs?: number;
  };
};

// ── テキストビルダー ──────────────────────────────────────────────────────────

export function buildConfirmPrompt(locale: 'ja' | 'en'): string {
  return locale === 'ja'
    ? '\n\nこの内容で会話を終了してよいですか？（はい / いいえ）'
    : '\n\nIs it OK to end the conversation with this? (yes / no)';
}

export function buildTerminalText(
  locale: 'ja' | 'en',
  reason: TerminalReason,
): string {
  if (locale === 'en') {
    switch (reason) {
      case 'completed':
        return 'Understood. Ending the conversation.';
      case 'aborted_user':
        return 'Understood. Ending the conversation.';
      case 'aborted_budget':
        return 'We could not complete confirmation. For safety, we are ending this conversation. Please start over if needed.';
      case 'aborted_loop_detected':
        return 'We detected a repeated loop. For safety, we are ending this conversation. Please start over if needed.';
      case 'failed_safe_mode':
        return 'For safety reasons, we are ending this conversation.';
      case 'escalated_handoff':
        return 'We will hand this off to a human agent. Ending the conversation.';
      default:
        return 'Ending the conversation.';
    }
  }

  switch (reason) {
    case 'completed':
      return '承知しました。会話を終了します。';
    case 'aborted_user':
      return '承知しました。会話を終了します。';
    case 'aborted_budget':
      return '確認が完了しないため、安全のため会話を終了します。必要なら最初からやり直してください。';
    case 'aborted_loop_detected':
      return '同じ確認が繰り返されたため、安全のため会話を終了します。必要なら最初からやり直してください。';
    case 'failed_safe_mode':
      return '安全上の理由により、この会話は終了します。';
    case 'escalated_handoff':
      return '担当者に引き継ぎます。会話を終了します。';
    default:
      return '会話を終了します。';
  }
}

// ── 意図・安全フラグ検出 ─────────────────────────────────────────────────────

export function detectIntentHint(input: DialogInput): string {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(' ')
    .toLowerCase();

  const shippingKeywords = [
    '送料', '配送料', '配送', 'お届け', '届く', '到着', '何日',
    'when will it arrive', 'delivery', 'shipping',
  ];
  if (shippingKeywords.some((k) => text.includes(k.toLowerCase())))
    return 'shipping';

  const returnKeywords = [
    '返品', '返金', 'キャンセル', '交換', '不良品',
    'return', 'refund', 'cancel',
  ];
  if (returnKeywords.some((k) => text.includes(k.toLowerCase())))
    return 'returns';

  const paymentKeywords = [
    '支払', '支払い', '決済', 'クレジット', 'カード', '請求', '領収書',
    'invoice', 'payment', 'pay',
  ];
  if (paymentKeywords.some((k) => text.includes(k.toLowerCase())))
    return 'payment';

  const productKeywords = [
    '在庫', '入荷', 'サイズ', '色', 'カラー', '素材', '仕様', '詳細',
    'stock', 'size', 'color', 'material',
  ];
  if (productKeywords.some((k) => text.includes(k.toLowerCase())))
    return 'product-info';

  return 'general';
}

export function detectSafetyFlag(input: DialogInput): boolean {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(' ')
    .toLowerCase();

  const safetyKeywords = [
    '自殺', '死にたい', 'リストカット', '自傷', '自殺したい',
    'suicide', 'kill myself', '暴力', '虐待', 'dv', '暴行',
    'assault', 'abuse', '違法', '犯罪', 'drug', 'drugs',
  ];

  return safetyKeywords.some((k) => text.includes(k.toLowerCase()));
}

export function looksLikeClarifyFollowup(input: DialogInput): boolean {
  const history = input.history ?? [];
  if (!history.length) return false;

  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return false;

  const t = lastAssistant.content;

  const clarifyPhrases = [
    'どの商品（またはカテゴリ）についての配送・送料を知りたいですか？',
    'お届け先の都道府県（または国）を教えてください。',
    'ご注文番号を教えていただけますか？',
    '返品したい商品の名前または型番（SKU）を教えてください。',
    '返品を希望される理由（サイズ違い・イメージ違い・不良品など）を教えてください。',
    'ご注文番号、購入日、商品の状態、返品理由を教えていただけますか？',
    '購入日を教えてください。',
    '商品の状態はどうですか？',
    '返品理由を教えてください。',
    'どの商品についてのご質問でしょうか？（商品名や型番などを教えてください）',
    'どのような点について知りたいですか？（サイズ感・色・在庫状況・素材など）',
  ];

  return clarifyPhrases.some((phrase) => t.includes(phrase));
}

export function isSimpleGeneralFaq(
  input: DialogInput,
  routeContext: RouteContextV2,
): boolean {
  const text = [
    input.userMessage,
    ...(input.history ?? []).map((m) => m.content),
  ]
    .join(' ')
    .toLowerCase();

  if (routeContext.conversationDepth > 1) return false;
  if (routeContext.complexity === 'high') return false;
  if (text.length > 60) return false;

  const faqKeywords = [
    '営業時間', '何時から', '何時まで', '定休日', '休業日', '営業日',
    '店舗', 'ショップ', 'お店', '場所', '住所', 'アクセス', '行き方',
    '電話番号', '問い合わせ先', 'お問い合わせ', '連絡先', 'サポート', 'カスタマーサポート',
  ];
  if (!faqKeywords.some((k) => text.includes(k.toLowerCase()))) return false;

  const complexMarkers = [
    'コツ', 'やり方', '方法', 'テクニック', '戦略', '比較',
    'どれがいい', 'どれが良い', 'おすすめ', '最適', '一番', 'お得', '安く', 'なるべく',
  ];
  if (complexMarkers.some((k) => text.includes(k.toLowerCase()))) return false;

  return true;
}

export function shouldUseFastAnswer(
  input: DialogInput,
  routeContext: RouteContextV2,
): boolean {
  if (routeContext.requiresSafeMode) return false;

  const intent = detectIntentHint(input);
  const text = (input.userMessage || '').toLowerCase();
  const isClarifyFollowup = looksLikeClarifyFollowup(input);
  const depth = input.history?.length ?? 0;

  if (intent === 'general') return isSimpleGeneralFaq(input, routeContext);

  const fastIntents = ['shipping', 'returns', 'payment', 'product-info'];
  if (!fastIntents.includes(intent)) return false;

  if (intent === 'payment') return text.length >= 8;
  if (depth === 0) return false;

  const minLength = isClarifyFollowup ? 8 : 15;
  if (text.length < minLength) return false;

  return true;
}

// ── Phase22 フロー制御 ────────────────────────────────────────────────────────

export function applyPhase22FlowAfterGeneration(params: {
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

  const nextState: FlowState = isClarifyTurn ? 'clarify' : 'confirm';

  // Phase22: recentStates は無制限に増やさない（壊れない）
  const rawRecentStates = [...prevFlow.recentStates, nextState];
  const maxKeep = Math.max(8, budgets.loopWindowTurns * 2);
  const recentStates = rawRecentStates.slice(-maxKeep);

  const loopCheck = detectStatePatternLoop(
    recentStates,
    budgets.loopWindowTurns,
  );

  const clarifySig = isClarifyTurn ? toClarifySignature(finalText) : undefined;
  const clarifySignatureLoop =
    isClarifyTurn && clarifySig && prevFlow.lastClarifySignature === clarifySig;

  if (loopCheck.loopDetected || clarifySignatureLoop) {
    const next = {
      ...prevFlow,
      turnIndex,
      state: 'terminal' as const,
      terminalReason: 'aborted_loop_detected' as const,
      recentStates,
      lastClarifySignature: clarifySig ?? prevFlow.lastClarifySignature,
      lastUpdatedAt: new Date().toISOString(),
    };
    setFlowSessionMeta(flowKey, next);

    logger.info(
      {
        event: 'flow.loop_detected',
        meta: {
          flow: {
            pattern: loopCheck.pattern,
            loopType: clarifySignatureLoop
              ? 'clarify_signature'
              : 'state_pattern',
            // Phase22: 後追い用
            recentTail: recentStates.slice(
              -Math.min(recentStates.length, budgets.loopWindowTurns),
            ),
          },
        },
      },
      'phase22.flow.loop_detected',
    );

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
    const text = buildTerminalText(input.locale, 'aborted_loop_detected');
    return {
      textWithConfirm: text,
      forcedTerminal: {
        text,
        route: '20b',
        plannerReasons: ['phase22:aborted_loop_detected'],
      },
    };
  }

  const sameStateRepeats =
    prevFlow.state === nextState ? prevFlow.sameStateRepeats + 1 : 0;
  const clarifyRepeats =
    nextState === 'clarify' ? prevFlow.clarifyRepeats + 1 : 0;

  // Phase22: 上限に達したら止める（決定性）
  if (
    sameStateRepeats >= budgets.maxSameStateRepeats ||
    clarifyRepeats >= budgets.maxClarifyRepeats
  ) {
    const next = {
      ...prevFlow,
      turnIndex,
      state: 'terminal' as const,
      terminalReason: 'aborted_budget' as const,
      sameStateRepeats,
      clarifyRepeats,
      recentStates,
      lastClarifySignature: clarifySig ?? prevFlow.lastClarifySignature,
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
    const text = buildTerminalText(input.locale, 'aborted_budget');
    return {
      textWithConfirm: text,
      forcedTerminal: {
        text,
        route: '20b',
        plannerReasons: ['phase22:aborted_budget'],
      },
    };
  }

  // Phase22: Log exit from previous state
  if (prevFlow.state !== nextState) {
    logger.info(
      {
        event: 'flow.exit_state',
        meta: {
          from: prevFlow.state,
          to: nextState,
          turnIndex,
          conversationId: flowKey.conversationId,
        },
      },
      'phase22.flow.exit_state',
    );
  }

  const next = {
    ...prevFlow,
    turnIndex,
    state: nextState,
    sameStateRepeats,
    clarifyRepeats,
    confirmRepeats: nextState === 'confirm' ? 0 : prevFlow.confirmRepeats,
    recentStates,
    lastClarifySignature: clarifySig ?? prevFlow.lastClarifySignature,
    lastUpdatedAt: new Date().toISOString(),
  };
  setFlowSessionMeta(flowKey, next);

  // Phase22: Log entry to new state
  if (prevFlow.state !== nextState) {
    logger.info(
      {
        event: 'flow.enter_state',
        meta: {
          state: nextState,
          from: prevFlow.state,
          turnIndex,
          conversationId: flowKey.conversationId,
        },
      },
      'phase22.flow.enter_state',
    );
  }

  logger.info(
    { event: 'flow.state_updated', meta: { flow: next } },
    'phase22.flow.state_updated',
  );

  const textWithConfirm = isClarifyTurn
    ? finalText
    : finalText + buildConfirmPrompt(input.locale);
  return { textWithConfirm };
}
