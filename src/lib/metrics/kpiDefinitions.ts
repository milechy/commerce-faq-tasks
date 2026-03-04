/**
 * Phase23 KPI メトリクス定数定義
 * ragContent・書籍内容をラベルに含めないこと
 */

export const KPI_METRIC_NAMES = {
  CONVERSATION_TERMINAL_TOTAL: "rajiuce_conversation_terminal_total",
  LOOP_DETECTED_TOTAL: "rajiuce_loop_detected_total",
  AVATAR_REQUESTS_TOTAL: "rajiuce_avatar_requests_total",
  RAG_DURATION_MS: "rajiuce_rag_duration_ms",
  HTTP_ERRORS_TOTAL: "rajiuce_http_errors_total",
  KILL_SWITCH_ACTIVE: "rajiuce_kill_switch_active",
  ACTIVE_SESSIONS: "rajiuce_active_sessions",
} as const;

export type KpiMetricName = (typeof KPI_METRIC_NAMES)[keyof typeof KPI_METRIC_NAMES];

/** 会話終了理由 */
export type ConversationTerminalReason =
  | "completed"
  | "loop_abort"
  | "kill_switch"
  | "timeout"
  | "error";

/** アバターリクエストステータス */
export type AvatarRequestStatus = "success" | "error" | "rate_limited";

/** RAG フェーズ */
export type RagPhase = "embed" | "search" | "rerank" | "answer";

/** RAG duration Histogram のバケット境界 (ms) */
export const RAG_DURATION_BUCKETS = [50, 100, 200, 500, 1000, 1500, 2000, 3000, 5000];

/** /metrics へのアクセス制御用ヘッダー名 */
export const INTERNAL_REQUEST_HEADER = "x-internal-request";
