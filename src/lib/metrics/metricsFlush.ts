// src/lib/metrics/metricsFlush.ts
// Phase72-D: Prometheus メトリクスを PostgreSQL に 5 分周期でスナップショット

import type { Pool } from "pg";
import type { Logger } from "pino";
import { metricsRegistry } from "./promExporter";
import { KPI_METRIC_NAMES } from "./kpiDefinitions";

// ---------------------------------------------------------------------------
// 対象メトリクス（Counter: delta / Histogram: avg）
// ---------------------------------------------------------------------------

const COUNTER_METRIC_NAMES: ReadonlyArray<string> = [
  KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
  KPI_METRIC_NAMES.AVATAR_REQUESTS_TOTAL,
  KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
];

const HISTOGRAM_METRIC_NAMES: ReadonlyArray<string> = [
  KPI_METRIC_NAMES.RAG_DURATION_MS,
];

// ---------------------------------------------------------------------------
// Counter 前回値キャッシュ（key = `metricName|serializedLabels`）
// ---------------------------------------------------------------------------

const prevCounterValues = new Map<string, number>();

// ---------------------------------------------------------------------------
// 内部ユーティリティ
// ---------------------------------------------------------------------------

function cacheKey(metricName: string, labels: Record<string, string>): string {
  return `${metricName}|${JSON.stringify(labels, Object.keys(labels).sort())}`;
}

// ---------------------------------------------------------------------------
// flush 実行関数（1 回分）
// ---------------------------------------------------------------------------

async function flushOnce(pool: Pool, logger: Logger): Promise<void> {
  let metrics: Awaited<ReturnType<typeof metricsRegistry.getMetricsAsJSON>>;
  try {
    metrics = await metricsRegistry.getMetricsAsJSON();
  } catch (err) {
    logger.warn({ err }, "[metricsFlush] getMetricsAsJSON failed");
    return;
  }

  const now = new Date();
  const rows: Array<{
    metric_name: string;
    labels: Record<string, string>;
    value: number;
  }> = [];

  for (const metric of metrics) {
    const name = metric.name;

    if (COUNTER_METRIC_NAMES.includes(name)) {
      // Counter: 各ラベルセットの delta を計算
      for (const value of metric.values ?? []) {
        const labels = value.labels as Record<string, string>;
        const currentVal = value.value as number;
        const key = cacheKey(name, labels);
        const prev = prevCounterValues.get(key) ?? 0;
        const delta = currentVal - prev;
        if (delta > 0) {
          rows.push({ metric_name: name, labels, value: delta });
        }
        prevCounterValues.set(key, currentVal);
      }
    } else if (HISTOGRAM_METRIC_NAMES.includes(name)) {
      // Histogram: sum と count から平均を計算
      // prom-client は _sum / _count suffix サフィックスで別 metric として返す場合があるが
      // getMetricsAsJSON は bucket 形式で返す。sum/count を label なしで集約する。
      // 各 bucket エントリの value.value はバケット累積値。
      // sum エントリは metricName_sum、count は metricName_count で提供される。
      // ただし getMetricsAsJSON では values[].labels に le が付く bucket のほか、
      // {count, sum} フィールドが values 配列に含まれない場合がある。
      // → 同じ Registry から collect() → getMetricsAsJSON() の実体を使う。
      //
      // 実際の構造: { name, help, type: 'histogram', values: [{labels:{le:'50',...}, value: N}, ..., {labels:{}, value: sum}] }
      // sum ラベル: le が無く、metricName_sum という名前 OR labels = {} で最後のエントリ。
      //
      // 安全な方法: labels.le が undefined のエントリで sum/count を取る。
      // prom-client v15 では {labels:{}, value: N} が _sum と _count に対応する
      // 2 エントリが末尾に現れる（順番は sum→count）。
      //
      // ここではラベル別に sum と count を集計し、count>0 の場合のみ INSERT する。

      // ラベル（le 除く）ごとに sum/count を集計するための Map
      const histAgg = new Map<string, { sum: number; count: number }>();

      for (const v of metric.values ?? []) {
        const labels = v.labels as Record<string, string>;
        const { le, ...labelWithoutLe } = labels;
        const key = cacheKey(name, labelWithoutLe);

        if (!histAgg.has(key)) {
          histAgg.set(key, { sum: 0, count: 0 });
        }
        const entry = histAgg.get(key)!;

        if (le === "+Inf") {
          // +Inf バケットの累積値 = count
          entry.count = v.value as number;
        } else if (le === undefined) {
          // le がない = _sum エントリ（prom-client が返す構造に依存）
          entry.sum = v.value as number;
        }
        // 他バケット（le = 数値）はスキップ
      }

      for (const [key, { sum, count }] of histAgg) {
        if (count <= 0) continue; // divide-by-zero ガード
        const avg = sum / count;
        // key から labels を復元（cacheKey は name|JSON）
        const labelsJson = key.slice(name.length + 1);
        let parsedLabels: Record<string, string> = {};
        try {
          parsedLabels = JSON.parse(labelsJson) as Record<string, string>;
        } catch {
          // JSON 解析失敗は空ラベルで続行
        }
        rows.push({ metric_name: name, labels: parsedLabels, value: avg });
      }
    }
  }

  if (rows.length === 0) return;

  try {
    // バルク INSERT
    const valuesClause = rows
      .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
      .join(", ");
    const params: (string | number | object)[] = [];
    for (const row of rows) {
      params.push(row.metric_name, row.labels, row.value, now.toISOString());
    }
    await pool.query(
      `INSERT INTO metrics_snapshots (metric_name, labels, value, snapshot_at)
       VALUES ${valuesClause}`,
      params,
    );
    logger.info({ count: rows.length }, "[metricsFlush] snapshot flushed");
  } catch (err) {
    logger.warn({ err }, "[metricsFlush] INSERT failed");
  }
}

// ---------------------------------------------------------------------------
// Public: initMetricsFlush
// ---------------------------------------------------------------------------

/**
 * Prometheus メトリクスを PostgreSQL に定期 flush する。
 * @returns cleanup 関数（SIGTERM/SIGINT ハンドラ内で呼ぶ）
 */
export function initMetricsFlush(
  pool: Pool | null,
  logger: Logger,
  intervalMs = 5 * 60 * 1000,
): () => void {
  if (!pool) {
    logger.warn("[metricsFlush] pool not initialized, flush disabled");
    return () => {};
  }

  const timer = setInterval(() => {
    void flushOnce(pool, logger);
  }, intervalMs);

  logger.info({ intervalMs }, "[metricsFlush] initialized");

  return () => {
    clearInterval(timer);
    logger.info("[metricsFlush] timer cleared");
  };
}
