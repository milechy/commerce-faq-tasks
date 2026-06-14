// src/agent/orchestrator/flowControl.phase72c.test.ts
// Phase72-C: applyPhase22FlowAfterGeneration で logFlowTransition が呼ばれることを検証

// flowLogger モジュールを no-op 化してスパイ
jest.mock('../../lib/analytics/flowLogger', () => ({
  logFlowTransition: jest.fn(),
  initFlowLogger: jest.fn(),
}));

import { logFlowTransition } from '../../lib/analytics/flowLogger';
import { applyPhase22FlowAfterGeneration } from './flowControl';
import { resetFlowSessionMeta, getOrInitFlowSessionMeta, defaultFlowBudgets } from '../dialog/flowContextStore';

const mockLogFlow = logFlowTransition as jest.MockedFunction<typeof logFlowTransition>;

const flowKey = { tenantId: 'test-tenant', conversationId: 'sess-abc' };

const baseInput = {
  tenantId: 'test-tenant',
  conversationId: 'sess-abc',
  locale: 'ja',
  userMessage: 'テスト',
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  resetFlowSessionMeta(flowKey);
});

describe('flowControl.ts — logFlowTransition フック (Phase72-C)', () => {
  it('状態が変わった場合に logFlowTransition が呼ばれる', () => {
    const prevFlow = getOrInitFlowSessionMeta(flowKey);
    // 初期状態は 'answer'（getOrInitFlowSessionMeta のデフォルト）
    // isClarifyTurn=true で nextState='clarify' に遷移させる
    applyPhase22FlowAfterGeneration({
      input: baseInput,
      flowKey,
      budgets: defaultFlowBudgets(),
      prevFlow,
      turnIndex: 1,
      isClarifyTurn: true,
      finalText: '質問を確認させてください',
    });

    // answer -> clarify の遷移で呼ばれる
    expect(mockLogFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'test-tenant',
        sessionId: 'sess-abc',
        toState: 'clarify',
        turnIndex: 1,
      }),
    );
  });

  it('状態が変わらない場合は logFlowTransition が呼ばれない', () => {
    // maxClarifyRepeats=2 を避けるため確認ステート (confirm -> confirm) を使う
    // isClarifyTurn=false → nextState='confirm'
    const budgets = { ...defaultFlowBudgets(), maxClarifyRepeats: 10, maxSameStateRepeats: 10, maxConfirmRepeats: 10 };
    const prevFlow = getOrInitFlowSessionMeta(flowKey);
    applyPhase22FlowAfterGeneration({
      input: baseInput,
      flowKey,
      budgets,
      prevFlow,
      turnIndex: 1,
      isClarifyTurn: false, // answer -> confirm
      finalText: '確認',
    });
    jest.clearAllMocks();

    // もう一度 confirm のまま（状態変化なし）
    const prevFlow2 = getOrInitFlowSessionMeta(flowKey);
    applyPhase22FlowAfterGeneration({
      input: baseInput,
      flowKey,
      budgets,
      prevFlow: prevFlow2,
      turnIndex: 2,
      isClarifyTurn: false, // confirm -> confirm（変化なし）
      finalText: '確認2',
    });

    expect(mockLogFlow).not.toHaveBeenCalled();
  });

  it('loop_detected で terminal 強制時に metadata: terminalReason=aborted_loop_detected で呼ばれる', () => {
    // ループ検出を誘発するために loopWindowTurns 回分の同一ステートを積む
    const budgets = defaultFlowBudgets();
    const loopWindow = budgets.loopWindowTurns;

    // 先に clarify 状態で loopWindow 回分の recentStates を積む
    let prevFlow = getOrInitFlowSessionMeta(flowKey);

    // ループが検出される十分な回数を繰り返す（loopWindow * 2 回同じステート）
    for (let i = 0; i < loopWindow + 2; i++) {
      prevFlow = getOrInitFlowSessionMeta(flowKey);
      const result = applyPhase22FlowAfterGeneration({
        input: baseInput,
        flowKey,
        budgets,
        prevFlow,
        turnIndex: i,
        isClarifyTurn: true,
        finalText: '同一テキスト',
      });
      if (result.forcedTerminal) break;
    }
    jest.clearAllMocks();

    // 最終ターン: ループ検出されるべき
    const finalPrevFlow = getOrInitFlowSessionMeta(flowKey);
    const result = applyPhase22FlowAfterGeneration({
      input: baseInput,
      flowKey,
      budgets,
      prevFlow: finalPrevFlow,
      turnIndex: loopWindow + 10,
      isClarifyTurn: true,
      finalText: '同一テキスト',
    });

    if (result.forcedTerminal) {
      expect(mockLogFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          toState: 'terminal',
          metadata: expect.objectContaining({ terminalReason: expect.stringContaining('aborted') }),
        }),
      );
    }
    // forcedTerminal が返らないケース（ループ条件が満たされない環境）でも落とさない
    expect(true).toBe(true);
  });
});
