/**
 * 管理AIエージェント（/copilot-preview）の挙動メトリクスを metrics_snapshots へ記録する。
 *
 * metric_name / labels / value の意味は docs/AGENT_METRICS.md が唯一の契約。
 * 新しいテーブルは作らず、Phase72-D の汎用シンク metrics_snapshots を再利用する。
 *
 * 制約:
 *   - fire-and-forget。失敗は logger.warn に落とすだけで呼び出し側へ投げない
 *     （計測の失敗がチャット応答を壊してはならない）
 *   - labels に PII を入れない（ユーザー自由入力・FAQ本文・顧客名などは渡さない）
 */

import type { Pool } from 'pg';
import { logger } from '../logger';

export interface AgentMetricInput {
  metricName: string;
  tenantId: string | null;
  labels: Record<string, unknown>;
  value: number;
}

export async function recordAgentMetric(db: Pool, input: AgentMetricInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO metrics_snapshots (metric_name, tenant_id, labels, value)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [input.metricName, input.tenantId, JSON.stringify(input.labels), input.value],
    );
  } catch (err) {
    logger.warn('[agentMetrics] INSERT failed', err);
  }
}
