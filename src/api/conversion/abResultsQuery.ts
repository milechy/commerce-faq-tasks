// src/api/conversion/abResultsQuery.ts

// GET /v1/admin/ab/experiments/:id/results の集計本体。
// HTTPレイヤ(abTestRoutes.ts)とチャットエージェント(agent/actionExecutor.ts)の両方から
// 同じ結果を取得できるよう、認可・レスポンス整形から切り離してここに置く
// （summaryQueries.ts と同じ狙い。ただし ab_experiments/ab_results は chat_sessions を
// 経由しないテーブルのため、独立ファイルとして分離する）。

import type { Pool } from 'pg';
import { reconcileAbResultOutcomes } from './abResultsOutcomeSync';

type Db = Pick<Pool, 'query'>;

export type AbVariantResult = {
  exposed: number;
  reached_two_plus: number;
  reached_two_plus_rate: number;
  converted: number;
  conversion_rate: number;
  avg_judge_score: number | null;
};

export type AbExperimentResults = {
  experiment_id: number;
  min_sample_size: number;
  total_exposed: number;
  reliable: boolean;
  warning?: string;
  variants: Record<string, AbVariantResult>;
};

/**
 * 指定experimentの結果を集計する。呼び出し前に存在確認・テナント認可は済んでいること。
 * GID 1216978855735482: 集計直前に reconcileAbResultOutcomes を呼び、成果(継続率/CV)を
 * chat_sessionsと突合してから集計する。best-effort — 突合が失敗しても集計は続行する。
 */
export async function computeAbExperimentResults(
  db: Db,
  experimentId: number,
  minSampleSize: number,
  tenantId: string,
): Promise<AbExperimentResults> {
  try {
    await reconcileAbResultOutcomes(db, experimentId, tenantId);
  } catch {
    // noop — 集計は続行
  }

  const result = await db.query(
    `SELECT
       variant,
       COUNT(*) AS exposed,
       COUNT(*) FILTER (WHERE reached_two_plus_exchanges) AS reached_two_plus,
       COUNT(*) FILTER (WHERE converted) AS converted,
       ROUND(AVG(judge_score)::numeric, 1) AS avg_judge_score
     FROM ab_results
     WHERE experiment_id = $1
     GROUP BY variant`,
    [experimentId],
  );

  const variants: Record<string, AbVariantResult> = {};
  let totalExposed = 0;
  for (const row of result.rows) {
    const exposed = Number(row.exposed);
    const reachedTwoPlus = Number(row.reached_two_plus);
    const converted = Number(row.converted);
    totalExposed += exposed;
    variants[row.variant] = {
      exposed,
      reached_two_plus: reachedTwoPlus,
      reached_two_plus_rate: exposed > 0 ? Math.round((reachedTwoPlus / exposed) * 1000) / 10 : 0,
      converted,
      conversion_rate: exposed > 0 ? Math.round((converted / exposed) * 1000) / 10 : 0,
      avg_judge_score: row.avg_judge_score !== null ? Number(row.avg_judge_score) : null,
    };
  }

  // GID 1216978855735482: peeking(覗き見)によるfalse positive防止。
  // min_sample_size未到達の間は reliable=false とし、意思決定に使わないよう警告する。
  const reliable = totalExposed >= minSampleSize;

  return {
    experiment_id: experimentId,
    min_sample_size: minSampleSize,
    total_exposed: totalExposed,
    reliable,
    ...(reliable
      ? {}
      : {
          warning:
            `サンプルサイズが min_sample_size(${minSampleSize}) に未到達です` +
            `（現在 ${totalExposed} 件）。この結果を意思決定に使わないでください。`,
        }),
    variants,
  };
}

export type AbExperimentOverview = {
  id: number;
  name: string;
  status: string;
  min_sample_size: number;
  traffic_split: number;
  created_at: string;
};

/** テナントの直近のA/Bテストを一覧取得する（チャットの概要表示用、既定5件）。 */
export async function fetchAbExperimentsOverview(
  db: Db,
  tenantId: string,
  limit = 5,
): Promise<AbExperimentOverview[]> {
  const result = await db.query(
    `SELECT id, name, status, min_sample_size, traffic_split, created_at
     FROM ab_experiments
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows;
}
