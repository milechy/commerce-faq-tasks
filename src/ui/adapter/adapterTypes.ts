// src/ui/adapter/adapterTypes.ts

/**
 * Adapter provider identifiers.
 * UI は provider に依存した表示をしたい場合がある（例: バッジ表示）。
 */
export type AdapterProvider = "lemon_slice";

/**
 * Server response: meta.adapter.status を UI が参照して表示モードを切り替える。
 * PR2b の意図: readiness/failed/fallback を UI/adapter 層で可観測化する。
 */
export type AdapterStatus =
  | "disabled" // 明示OFF（flag/kill-switch/pii等）
  | "requested" // probe開始（readiness未確定）
  | "ready" // readiness確認OK（成功時のみ）
  | "fallback" // degraded（timeout等でfallback処理）
  | "failed"; // hard fail（例: 例外・応答不正）

/**
 * UI が実際に表示切替に使うモード（UX観点）。
 */
export type AdapterUIMode =
  | "hidden"
  | "disabled"
  | "loading"
  | "ready"
  | "fallback"
  | "failed";

/**
 * UI が参照する adapter 状態メタ。
 * サーバが meta.adapter に載せる想定。
 */
export type AdapterMeta = {
  provider: AdapterProvider;
  status: AdapterStatus;
  reason?: string;
  correlationId?: string;
};
