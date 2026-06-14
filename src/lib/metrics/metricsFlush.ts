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
// tenantId ラベル抽出（PII anti-slop: tenantId を JSONB labels に含めない）
// ---------------------------------------------------------------------------

/**
 * Prometheus labels から tenantId を抜き出し、残りを返す。
 * prom-client の labelNames は camelCase "tenantId" を使用しているため
 * "tenantId" キーを対象とする。
 */
function extractTenantId(labels: Record<string, string>): {
  tenantId: string | null;
  labelsWithoutTenant: Record<string, string>;
} {
  const { tenantId, ...rest } = labels;
  return {
    tenantId: tenantId ?? null,
    labelsWithoutTenant: rest,
  };
}

// ---------------------------------------------------------------------------
// flush 実行関数（1 回分）
// dryRun=true のときは prevCounterValues だけ充填して INSERT しない（warm-up 用）
// ---------------------------------------------------------------------------

async function flushOnce(pool: Pool, logger: Logger, dryRun = false): Promise<void> {
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
    tenant_id: string | null;
    labels: Record<string, string>;
    value: number;
  }> = [];

  for (const metric of metrics) {
    const name = metric.name;

    if (COUNTER_METRIC_NAMES.includes(name)) {
      // Counter: 各ラベルセットの delta を計算
      for (const value of metric.values ?? []) {
        const rawLabels = value.labels as Record<string, string>;
        const currentVal = value.value as number;
        const key = cacheKey(name, rawLabels);
        const prev = prevCounterValues.get(key) ?? 0;
        const delta = currentVal - prev;
        // dryRun でなく delta > 0 の場合のみ INSERT キューに積む
        if (!dryRun && delta > 0) {
          const { tenantId, labelsWithoutTenant } = extractTenantId(rawLabels);
          rows.push({ metric_name: name, tenant_id: tenantId, labels: labelsWithoutTenant, value: delta });
        }
        prevCounterValues.set(key, currentVal);
      }
    } else if (HISTOGRAM_METRIC_NAMES.includes(name)) {
      // Histogram: sum と count から平均を計算
      // prom-client v15 の getMetricsAsJSON 構造:
      //   { name, type: 'histogram', values: [
      //     {labels:{le:'50', phase:'embed', tenantId:'t1'}, value: N},  // bucket
      //     ...
      //     {labels:{le:'+Inf', phase:'embed', tenantId:'t1'}, value: C}, // count
      //     {labels:{phase:'embed', tenantId:'t1'}, value: S},            // sum (le なし)
      //   ]}
      // le を除いたラベルセットごとに sum/count を集計し、count>0 の場合のみ INSERT。

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
          // le がない = _sum エントリ
          entry.sum = v.value as number;
        }
        // 他バケット（le = 数値）はスキップ
      }

      if (!dryRun) {
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
          const { tenantId, labelsWithoutTenant } = extractTenantId(parsedLabels);
          rows.push({ metric_name: name, tenant_id: tenantId, labels: labelsWithoutTenant, value: avg });
        }
      }
    }
  }

  if (dryRun || rows.length === 0) return;

  try {
    // バルク INSERT（5カラム: metric_name, tenant_id, labels, value, snapshot_at）
    const valuesClause = rows
      .map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`)
      .join(", ");
    const params: (string | number | object | null)[] = [];
    for (const row of rows) {
      params.push(row.metric_name, row.tenant_id, row.labels, row.value, now.toISOString());
    }
    await pool.query(
      `INSERT INTO metrics_snapshots (metric_name, tenant_id, labels, value, snapshot_at)
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

  // warm-up: 初回 flush 前に prevCounterValues を現在値で充填する。
  // これにより再起動直後の初回 tick で Counter 累積値全量が delta として INSERT されるスパイクを防ぐ。
  void flushOnce(pool, logger, /*dryRun=*/true);

  const timer = setInterval(() => {
    void flushOnce(pool, logger);
  }, intervalMs);

  logger.info({ intervalMs }, "[metricsFlush] initialized");

  return () => {
    clearInterval(timer);
    logger.info("[metricsFlush] timer cleared");
  };
}
