// src/agent/flow/loopDetector.ts

import type { FlowState } from "../dialog/flowContextStore";

export type LoopType = "state_pattern" | "clarify_signature";

export function detectStatePatternLoop(
  recentStates: FlowState[],
  windowTurns: number
): { loopDetected: boolean; pattern?: FlowState[] } {
  if (recentStates.length < windowTurns) return { loopDetected: false };

  const window = recentStates.slice(-windowTurns);
  // windowTurns が偶数のときのみ簡易反復チェック（例: 6 = ABCABC）
  if (windowTurns % 2 !== 0) return { loopDetected: false };

  const half = windowTurns / 2;
  const a = window.slice(0, half).join(",");
  const b = window.slice(half).join(",");
  if (a === b) return { loopDetected: true, pattern: window };
  return { loopDetected: false };
}
