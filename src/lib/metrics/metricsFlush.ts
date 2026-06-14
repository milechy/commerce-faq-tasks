/**
 * Phase72-D: Prometheus メトリクス → metrics_snapshots DB 永続化
 *
 * - Counter: 前回値との delta を INSERT（増分のみ保存）
 * - Histogram: _sum 値を INSERT
 * - pool falsy (DB未初期化) 時は noop
 * - setInterval で定期実行し、戻り値 (stop 関数) で onShutdown に clearInterval を差し込む
 */

import type { Pool } from "pg";
import type pino from "pino";
import {
  conversationTerminalCounter,
  loopDetectedCounter,
  avatarRequestsCounter,
  httpErrorsCounter,
  ragDurationHistogram,
} from "./promExporter";
import { KPI_METRIC_NAMES } from "./kpiDefinitions";

// ---------------------------------------------------------------------------
// 前回値キャッシュ（Counter delta 計算用）
// ---------------------------------------------------------------------------

/** key: `metricName:labelHash` → 前回のカウント値 */
const prevCounterValues = new Map<string, number>();

function labelHash(labels: Record<string, string | number>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

// ---------------------------------------------------------------------------
// 内部: 1 回分の flush 処理
// ---------------------------------------------------------------------------

export async function flushOnce(pool: Pool, logger: pino.Logger): Promise<void> {
  const rows: Array<{
    metric_name: string;
    tenant_id: string | null;
    labels: Record<string, string | number>;
    value: number;
  }> = [];

  // --- Counters ---
  const counterMetrics = [
    { counter: conversationTerminalCounter, name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL },
    { counter: loopDetectedCounter, name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL },
    { counter: avatarRequestsCounter, name: KPI_METRIC_NAMES.AVATAR_REQUESTS_TOTAL },
    { counter: httpErrorsCounter, name: KPI_METRIC_NAMES.HTTP_ERRORS_TOTAL },
  ] as const;

  for (const { counter, name } of counterMetrics) {
    const metric = await counter.get();
    for (const val of metric.values) {
      const currentValue = val.value;
      const labels = val.labels as Record<string, string | number>;
      const hash = labelHash(labels);
      const cacheKey = `${name}:${hash}`;
      const prev = prevCounterValues.get(cacheKey) ?? 0;
      const delta = currentValue - prev;
      if (delta > 0) {
        prevCounterValues.set(cacheKey, currentValue);
        const tenantId = (labels["tenantId"] as string | undefined) ?? null;
        // tenantId ラベルは labels JSONB から除外（tenant_id 列で保持）
        const { tenantId: _omit, ...restLabels } = labels as Record<string, string | number> & { tenantId?: string };
        rows.push({ metric_name: name, tenant_id: tenantId, labels: restLabels, value: delta });
      }
    }
  }

  // --- Histogram: ragDurationHistogram (_sum のみ保存) ---
  {
    const metric = await ragDurationHistogram.get();
    for (const val of metric.values) {
      if (val.metricName !== `${KPI_METRIC_NAMES.RAG_DURATION_MS}_sum`) continue;
      const currentSum = val.value;
      const sharedLabels = (val as any).sharedLabels as Record<string, string | number> | undefined ?? {};
      const allLabels = { ...sharedLabels, ...val.labels };
      const hash = labelHash(allLabels);
      const cacheKey = `${KPI_METRIC_NAMES.RAG_DURATION_MS}_sum:${hash}`;
      const prev = prevCounterValues.get(cacheKey) ?? 0;
      const delta = currentSum - prev;
      if (delta > 0) {
        prevCounterValues.set(cacheKey, currentSum);
        const tenantId = (sharedLabels["tenantId"] as string | undefined) ?? null;
        const { tenantId: _omit, ...restLabels } = sharedLabels as Record<string, string | number> & { tenantId?: string };
        rows.push({
          metric_name: KPI_METRIC_NAMES.RAG_DURATION_MS,
          tenant_id: tenantId,
          labels: restLabels,
          value: delta,
        });
      }
    }
  }

  if (rows.length === 0) return;

  // Bulk INSERT
  const placeholders = rows
    .map((_, i) => {
      const base = i * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4})`;
    })
    .join(", ");

  const values: (string | number | null | object)[] = [];
  for (const row of rows) {
    values.push(row.metric_name, row.tenant_id, JSON.stringify(row.labels), row.value);
  }

  await pool.query(
    `INSERT INTO metrics_snapshots (metric_name, tenant_id, labels, value)
     VALUES ${placeholders}`,
    values,
  );

  logger.debug({ count: rows.length }, "[metricsFlush] flushed metrics_snapshots");
}

// ---------------------------------------------------------------------------
// Public: initMetricsFlush
// ---------------------------------------------------------------------------

/**
 * 定期 flush を開始する。
 * @returns stop 関数（onShutdown で呼ぶ）
 */
export function initMetricsFlush(
  pool: Pool | null | undefined,
  logger: pino.Logger,
  intervalMs = 300_000,
): () => void {
  if (!pool) {
    logger.warn("[metricsFlush] pool not available — skipping metrics flush setup");
    return () => { /* noop */ };
  }

  const resolvedPool = pool;

  const timerId = setInterval(() => {
    flushOnce(resolvedPool, logger).catch((err) => {
      logger.error({ err }, "[metricsFlush] flush failed");
    });
  }, intervalMs);

  logger.info({ intervalMs }, "[metricsFlush] started");

  return () => {
    clearInterval(timerId);
    logger.info("[metricsFlush] stopped");
  };
}
