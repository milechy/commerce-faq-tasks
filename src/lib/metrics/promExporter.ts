import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import {
  KPI_METRIC_NAMES,
  RAG_DURATION_BUCKETS,
} from "./kpiDefinitions";

/**
 * Prometheus メトリクスレジストリ（シングルトン）
 * ragContent・書籍内容はラベルに含めない
 */
export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({ app: "rajiuce" });

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** 会話終了カウンター (reason, tenantId) */
export const conversationTerminalCounter = new Counter({
  name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
  help: "Total number of conversation sessions that reached a terminal state",
  labelNames: ["reason", "tenantId"] as const,
  registers: [metricsRegistry],
});

/** ループ検出カウンター (tenantId) */
export const loopDetectedCounter = new Counter({
  name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
  help: "Total number of dialog loop detections",
  labelNames: ["tenantId"] as const,
  registers: [metricsRegistry],
});

/** アバターリクエストカウンター (status, tenantId) */
export const avatarRequestsCounter = new Counter({
  name: KPI_METRIC_NAMES.AVATAR_REQUESTS_TOTAL,
  help: "Total number of avatar requests",
  labelNames: ["status", "tenantId"] as const,
  registers: [metricsRegistry],
});

/** HTTP エラーカウンター (statusCode, tenantId) */
export const httpErrorsCounter = new Counter({
  name: KPI_METRIC_NAMES.HTTP_ERRORS_TOTAL,
  help: "Total number of HTTP errors (4xx/5xx)",
  labelNames: ["statusCode", "tenantId"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** RAG 処理時間ヒストグラム (phase, tenantId) */
export const ragDurationHistogram = new Histogram({
  name: KPI_METRIC_NAMES.RAG_DURATION_MS,
  help: "RAG pipeline duration in milliseconds per phase",
  labelNames: ["phase", "tenantId"] as const,
  buckets: RAG_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** Kill switch 状態ゲージ (reason) */
export const killSwitchGauge = new Gauge({
  name: KPI_METRIC_NAMES.KILL_SWITCH_ACTIVE,
  help: "Whether a kill switch is currently active (1=active, 0=inactive)",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

/** アクティブセッション数ゲージ (tenantId) */
export const activeSessionsGauge = new Gauge({
  name: KPI_METRIC_NAMES.ACTIVE_SESSIONS,
  help: "Number of currently active dialog sessions per tenant",
  labelNames: ["tenantId"] as const,
  registers: [metricsRegistry],
});
