// src/agent/dialog/flowContextStore.ts

import crypto from "crypto";
import { buildTenantSessionKey } from "./sessionKey";

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

/**
 * TTL 掃き出し用の最終アクセス時刻を内部だけで持つ。
 * 公開型 FlowSessionMeta の形は変えない（snapshot/peek の呼び出し側を壊さないため）。
 */
interface FlowSessionEntry {
  meta: FlowSessionMeta;
  lastAccessedAt: number;
}

// キー生成は sessionKey.ts に一本化（contextStore.ts / salesContextStore.ts と共有）。
// conversationId は他ストアの sessionId と同じ役割。
const toInternalKey = (key: FlowSessionKey): string =>
  buildTenantSessionKey(key.tenantId, key.conversationId);

const sessionStore = new Map<string, FlowSessionEntry>();

// contextStore.ts と同じ理由・同じ値。middleware 側の既存スイープとも揃える。
const SESSION_ENTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const defaultFlowBudgets = (): FlowBudgets => ({
  maxTurnsPerSession: Number(process.env.PHASE22_MAX_TURNS ?? 12),
  maxSameStateRepeats: Number(process.env.PHASE22_MAX_SAME_STATE_REPEATS ?? 3),
  maxClarifyRepeats: Number(process.env.PHASE22_MAX_CLARIFY_REPEATS ?? 2),
  maxConfirmRepeats: Number(process.env.PHASE22_MAX_CONFIRM_REPEATS ?? 2),
  loopWindowTurns: Number(process.env.PHASE22_LOOP_WINDOW_TURNS ?? 6),
});

export function getOrInitFlowSessionMeta(key: FlowSessionKey): FlowSessionMeta {
  const internalKey = toInternalKey(key);
  const existing = sessionStore.get(internalKey);
  if (existing) {
    // 毎ターン呼ばれる経路なので、ここが flow セッションの生存signalになる。
    existing.lastAccessedAt = Date.now();
    return existing.meta;
  }

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
  sessionStore.set(internalKey, { meta: init, lastAccessedAt: Date.now() });
  return init;
}

// Phase47-B: 副作用なしの読み取り専用 getter（reward signal 用）
// TTL の最終アクセス時刻も更新しない（同一ターン内で getOrInit が既に更新しており、
// 生存判定はそちらに委ねる。ここで更新すると「副作用なし」の契約が壊れる）。
export function peekFlowSessionMeta(
  key: FlowSessionKey
): FlowSessionMeta | undefined {
  return sessionStore.get(toInternalKey(key))?.meta;
}

export function setFlowSessionMeta(
  key: FlowSessionKey,
  meta: FlowSessionMeta
): FlowSessionMeta {
  sessionStore.set(toInternalKey(key), { meta, lastAccessedAt: Date.now() });
  return meta;
}

export function resetFlowSessionMeta(key: FlowSessionKey): void {
  sessionStore.delete(toInternalKey(key));
}

// Phase47-D: heartbeat 集計用の読み取り専用 snapshot（副作用なし）
// 全件を走査するため、ここで最終アクセス時刻を更新すると全エントリが
// 永久に TTL を逃れてしまう。意図的に更新しない。
export function snapshotFlowSessionMetas(): FlowSessionMeta[] {
  return Array.from(sessionStore.values(), (entry) => entry.meta);
}

/**
 * TTL を超過したエントリを掃き出す。戻り値は削除件数（監視・テスト用）。
 * resetFlowSessionMeta は本番の呼び出し元が無く、実質この掃き出しが唯一の回収経路。
 */
export function evictExpiredFlowSessionMetas(): number {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of sessionStore.entries()) {
    if (now - entry.lastAccessedAt > SESSION_ENTRY_TTL_MS) {
      sessionStore.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/** 現在保持しているセッション数（メモリ蓄積の観測用）。 */
export function flowSessionMetaCount(): number {
  return sessionStore.size;
}

// .unref() は必須（プロセス終了 / jest をブロックしないため）
setInterval(evictExpiredFlowSessionMetas, SESSION_ENTRY_TTL_MS).unref?.();

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
