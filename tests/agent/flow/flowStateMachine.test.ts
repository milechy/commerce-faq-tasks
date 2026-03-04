// tests/agent/flow/flowStateMachine.test.ts

import {
  defaultFlowBudgets,
  getOrInitFlowSessionMeta,
  resetFlowSessionMeta,
  setFlowSessionMeta,
  toClarifySignature,
  type FlowSessionKey,
  type FlowState,
} from "../../../src/agent/dialog/flowContextStore";
import { detectStatePatternLoop } from "../../../src/agent/flow/loopDetector";

describe("Phase22 Flow State Machine Tests", () => {
  const sessionKey: FlowSessionKey = {
    tenantId: "test-tenant",
    conversationId: "test-conv",
  };

  beforeEach(() => {
    resetFlowSessionMeta(sessionKey);
  });

  describe("State Transitions", () => {
    test("should initialize with answer state", () => {
      const flow = getOrInitFlowSessionMeta(sessionKey);
      expect(flow.state).toBe("answer");
      expect(flow.turnIndex).toBe(0);
      expect(flow.recentStates).toEqual([]);
    });

    test("should transition from answer to clarify", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "clarify",
        turnIndex: 1,
        recentStates: ["answer", "clarify"],
      });

      expect(flow.state).toBe("clarify");
      expect(flow.turnIndex).toBe(1);
      expect(flow.recentStates).toContain("clarify");
    });

    test("should transition from clarify to answer", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "clarify",
        turnIndex: 1,
        recentStates: ["answer", "clarify"],
      });
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "answer",
        turnIndex: 2,
        recentStates: ["answer", "clarify", "answer"],
      });

      expect(flow.state).toBe("answer");
      expect(flow.turnIndex).toBe(2);
    });

    test("should transition to confirm state", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "confirm",
        turnIndex: 1,
        recentStates: ["answer", "confirm"],
      });

      expect(flow.state).toBe("confirm");
    });

    test("should reach terminal state", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "terminal",
        terminalReason: "completed",
        turnIndex: 3,
      });

      expect(flow.state).toBe("terminal");
      expect(flow.terminalReason).toBe("completed");
    });
  });

  describe("Budget Enforcement", () => {
    test("should track turn index", () => {
      const budgets = defaultFlowBudgets();
      let flow = getOrInitFlowSessionMeta(sessionKey);

      for (let i = 1; i <= budgets.maxTurnsPerSession + 1; i++) {
        flow = setFlowSessionMeta(sessionKey, {
          ...flow,
          turnIndex: i,
        });
      }

      expect(flow.turnIndex).toBeGreaterThan(budgets.maxTurnsPerSession);
    });

    test("should track same state repeats", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      
      for (let i = 0; i < 3; i++) {
        flow = setFlowSessionMeta(sessionKey, {
          ...flow,
          state: "clarify",
          sameStateRepeats: flow.sameStateRepeats + 1,
          turnIndex: i + 1,
        });
      }

      expect(flow.sameStateRepeats).toBe(3);
    });

    test("should reset same state repeats on state change", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "clarify",
        sameStateRepeats: 2,
        turnIndex: 1,
      });
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "answer",
        sameStateRepeats: 0,
        turnIndex: 2,
      });

      expect(flow.sameStateRepeats).toBe(0);
    });

    test("should track clarify repeats independently", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "clarify",
        clarifyRepeats: 1,
        turnIndex: 1,
      });
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "answer",
        turnIndex: 2,
      });
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "clarify",
        clarifyRepeats: 2,
        turnIndex: 3,
      });

      expect(flow.clarifyRepeats).toBe(2);
    });

    test("should track confirm repeats", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "confirm",
        confirmRepeats: 1,
        turnIndex: 1,
      });

      expect(flow.confirmRepeats).toBe(1);
    });
  });

  describe("Loop Detection", () => {
    test("should detect ABCABC pattern", () => {
      const states: FlowState[] = ["answer", "clarify", "confirm", "answer", "clarify", "confirm"];
      const result = detectStatePatternLoop(states, 6);

      expect(result.loopDetected).toBe(true);
      expect(result.pattern).toEqual(states);
    });

    test("should not detect loop with insufficient data", () => {
      const states: FlowState[] = ["answer", "clarify"];
      const result = detectStatePatternLoop(states, 6);

      expect(result.loopDetected).toBe(false);
    });

    test("should not detect loop in non-repeating pattern", () => {
      const states: FlowState[] = ["answer", "clarify", "answer", "confirm", "answer", "clarify"];
      const result = detectStatePatternLoop(states, 6);

      expect(result.loopDetected).toBe(false);
    });

    test("should handle odd window sizes gracefully", () => {
      const states: FlowState[] = ["answer", "clarify", "confirm", "answer", "clarify"];
      const result = detectStatePatternLoop(states, 5);

      expect(result.loopDetected).toBe(false);
    });
  });

  describe("Clarify Signature Detection", () => {
    test("should generate consistent signature for same text", () => {
      const sig1 = toClarifySignature("どの商品に興味がありますか？");
      const sig2 = toClarifySignature("どの商品に興味がありますか？");

      expect(sig1).toBe(sig2);
    });

    test("should normalize whitespace", () => {
      const sig1 = toClarifySignature("どの商品に  興味が  ありますか？");
      const sig2 = toClarifySignature("どの商品に 興味が ありますか？");

      expect(sig1).toBe(sig2);
    });

    test("should normalize question marks", () => {
      const sig1 = toClarifySignature("どの商品に興味がありますか？");
      const sig2 = toClarifySignature("どの商品に興味がありますか?");

      expect(sig1).toBe(sig2);
    });

    test("should be case-insensitive", () => {
      const sig1 = toClarifySignature("What product are you interested in?");
      const sig2 = toClarifySignature("WHAT PRODUCT ARE YOU INTERESTED IN?");

      expect(sig1).toBe(sig2);
    });

    test("should generate different signatures for different text", () => {
      const sig1 = toClarifySignature("どの商品に興味がありますか？");
      const sig2 = toClarifySignature("どのプランに興味がありますか？");

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("Terminal Reasons", () => {
    test("should store completed terminal reason", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "terminal",
        terminalReason: "completed",
      });

      expect(flow.terminalReason).toBe("completed");
    });

    test("should store aborted_user terminal reason", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "terminal",
        terminalReason: "aborted_user",
      });

      expect(flow.terminalReason).toBe("aborted_user");
    });

    test("should store aborted_budget terminal reason", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "terminal",
        terminalReason: "aborted_budget",
      });

      expect(flow.terminalReason).toBe("aborted_budget");
    });

    test("should store aborted_loop_detected terminal reason", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "terminal",
        terminalReason: "aborted_loop_detected",
      });

      expect(flow.terminalReason).toBe("aborted_loop_detected");
    });

    test("should store escalated_handoff terminal reason", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      flow = setFlowSessionMeta(sessionKey, {
        ...flow,
        state: "terminal",
        terminalReason: "escalated_handoff",
      });

      expect(flow.terminalReason).toBe("escalated_handoff");
    });
  });

  describe("Recent States Tracking", () => {
    test("should maintain recent states history", () => {
      let flow = getOrInitFlowSessionMeta(sessionKey);
      const states: FlowState[] = ["answer", "clarify", "answer", "confirm"];

      for (const state of states) {
        flow = setFlowSessionMeta(sessionKey, {
          ...flow,
          state,
          recentStates: [...flow.recentStates, state],
          turnIndex: flow.turnIndex + 1,
        });
      }

      expect(flow.recentStates).toEqual(states);
    });

    test("should handle empty recent states", () => {
      const flow = getOrInitFlowSessionMeta(sessionKey);
      expect(flow.recentStates).toEqual([]);
    });
  });

  describe("Session Isolation", () => {
    test("should isolate different conversations", () => {
      const key1: FlowSessionKey = {
        tenantId: "tenant1",
        conversationId: "conv1",
      };
      const key2: FlowSessionKey = {
        tenantId: "tenant1",
        conversationId: "conv2",
      };

      const flow1 = getOrInitFlowSessionMeta(key1);
      const flow2 = getOrInitFlowSessionMeta(key2);

      setFlowSessionMeta(key1, { ...flow1, turnIndex: 5 });
      setFlowSessionMeta(key2, { ...flow2, turnIndex: 10 });

      const updated1 = getOrInitFlowSessionMeta(key1);
      const updated2 = getOrInitFlowSessionMeta(key2);

      expect(updated1.turnIndex).toBe(5);
      expect(updated2.turnIndex).toBe(10);
    });

    test("should reset only specific session", () => {
      const key1: FlowSessionKey = {
        tenantId: "tenant1",
        conversationId: "conv1",
      };
      const key2: FlowSessionKey = {
        tenantId: "tenant1",
        conversationId: "conv2",
      };

      let flow1 = getOrInitFlowSessionMeta(key1);
      let flow2 = getOrInitFlowSessionMeta(key2);

      flow1 = setFlowSessionMeta(key1, { ...flow1, turnIndex: 5 });
      flow2 = setFlowSessionMeta(key2, { ...flow2, turnIndex: 10 });

      resetFlowSessionMeta(key1);

      const reset1 = getOrInitFlowSessionMeta(key1);
      const unchanged2 = getOrInitFlowSessionMeta(key2);

      expect(reset1.turnIndex).toBe(0);
      expect(unchanged2.turnIndex).toBe(10);
    });
  });
});
