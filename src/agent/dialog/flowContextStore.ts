// src/agent/dialog/flowContextStore.ts

import crypto from "crypto";

export type FlowState = "clarify" | "answer" | "confirm" | "terminal";

export type TerminalReason =
  | "completed"
  | "aborted_user"
  | "aborted_budget"
  | "aborted_loop_detected"
  | "escalated_handoff"
  | "failed_safe_mode";

export interface FlowBudgets {
  maxTurnsPerSession: number;
  maxSameStateRepeats: number;
  maxClarifyRepeats: number;
  maxConfirmRepeats: number;
  loopWindowTurns: number;
}

export interface FlowSessionMeta {
  state: FlowState;
  turnIndex: number;

  sameStateRepeats: number;
  clarifyRepeats: number;
  confirmRepeats: number;

  recentStates: FlowState[];
  lastClarifySignature?: string;

  terminalReason?: TerminalReason;
  lastUpdatedAt: string;
}

export interface FlowSessionKey {
  tenantId: string;
  conversationId: string;
}

const toInternalKey = (key: FlowSessionKey): string =>
  `${key.tenantId}::${key.conversationId}`;

const sessionStore = new Map<string, FlowSessionMeta>();

export const defaultFlowBudgets = (): FlowBudgets => ({
  maxTurnsPerSession: Number(process.env.PHASE22_MAX_TURNS ?? 12),
  maxSameStateRepeats: Number(process.env.PHASE22_MAX_SAME_STATE_REPEATS ?? 3),
  maxClarifyRepeats: Number(process.env.PHASE22_MAX_CLARIFY_REPEATS ?? 2),
  maxConfirmRepeats: Number(process.env.PHASE22_MAX_CONFIRM_REPEATS ?? 2),
  loopWindowTurns: Number(process.env.PHASE22_LOOP_WINDOW_TURNS ?? 6),
});

export function getOrInitFlowSessionMeta(key: FlowSessionKey): FlowSessionMeta {
  const existing = sessionStore.get(toInternalKey(key));
  if (existing) return existing;

  const now = new Date().toISOString();
  const init: FlowSessionMeta = {
    state: "answer",
    turnIndex: 0,
    sameStateRepeats: 0,
    clarifyRepeats: 0,
    confirmRepeats: 0,
    recentStates: [],
    lastUpdatedAt: now,
  };
  sessionStore.set(toInternalKey(key), init);
  return init;
}

export function setFlowSessionMeta(
  key: FlowSessionKey,
  meta: FlowSessionMeta
): FlowSessionMeta {
  sessionStore.set(toInternalKey(key), meta);
  return meta;
}

export function resetFlowSessionMeta(key: FlowSessionKey): void {
  sessionStore.delete(toInternalKey(key));
}

/**
 * Clarify の「同一質問繰り返し」検知用シグネチャ。
 * Phase22 では「賢く解消」より「止まる」を優先するため、
 * 正規化 + ハッシュで決定的に扱う。
 */
export function toClarifySignature(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[？?]+/g, "?")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
