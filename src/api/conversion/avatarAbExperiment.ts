// src/api/conversion/avatarAbExperiment.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤
//
// 既存の ab_experiments / ab_results（Phase58, src/api/conversion/abTestRoutes.ts）を
// 再利用し、「アバターあり vs テキストのみ」の割当を決定・記録する。
// variant_a / variant_b の JSONB にどちらも { avatarEnabled: boolean } を含む
// running な実験を「アバター実験」とみなす規約とする（専用のtype列は追加しない）。

import type { Pool } from 'pg';
import { assignVariant } from './abTestRoutes';

export interface AvatarExperimentVariantConfig {
  avatarEnabled: boolean;
}

export interface RunningAvatarExperiment {
  id: number;
  tenantId: string;
  variantA: AvatarExperimentVariantConfig;
  variantB: AvatarExperimentVariantConfig;
  trafficSplit: number;
}

export interface AvatarAssignmentResult {
  avatarEnabled: boolean;
  experimentId: number | null;
  variant: 'a' | 'b' | null;
}

/** variant_a/variant_b のJSONBが { avatarEnabled: boolean } の形か判定する */
function isAvatarVariantConfig(v: unknown): v is AvatarExperimentVariantConfig {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>)['avatarEnabled'] === 'boolean'
  );
}

/**
 * テナントに紐づく running なアバター実験を1件探す。
 * 複数存在する場合は最新(created_at DESC)を採用する（通常は同時に1件のみを想定）。
 * DB障害時はnull（実験なし扱いにフォールバック — 可用性優先）。
 */
export async function findRunningAvatarExperiment(
  pool: Pick<Pool, 'query'>,
  tenantId: string,
): Promise<RunningAvatarExperiment | null> {
  try {
    const result = await pool.query<{
      id: number;
      variant_a: unknown;
      variant_b: unknown;
      traffic_split: string | number;
    }>(
      `SELECT id, variant_a, variant_b, traffic_split
       FROM ab_experiments
       WHERE tenant_id = $1 AND status = 'running'
       ORDER BY created_at DESC`,
      [tenantId],
    );

    for (const row of result.rows) {
      if (isAvatarVariantConfig(row.variant_a) && isAvatarVariantConfig(row.variant_b)) {
        return {
          id: row.id,
          tenantId,
          variantA: row.variant_a,
          variantB: row.variant_b,
          trafficSplit: Number(row.traffic_split),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 訪問者/セッション単位でアバター表示可否を決定する。
 *
 * GID 1216944004404664（プランゲート）とは独立: defaultAvatarEnabled が false
 * （テナントのfeatures.avatarがそもそも無効）の場合は実験を一切参照せず、
 * 常に false を返す（アバターを出せないテナントで実験に参加させない、という
 * タスク仕様のガード）。
 *
 * stickyKey が session_id 相当であれば sticky（同一セッション内で結果が揺れない）。
 * 既存の assignVariant（同一visitor_idは常に同じvariant）をそのまま再利用する。
 */
export async function resolveAvatarAssignment(
  pool: Pick<Pool, 'query'>,
  tenantId: string,
  stickyKey: string,
  defaultAvatarEnabled: boolean,
): Promise<AvatarAssignmentResult> {
  if (!defaultAvatarEnabled) {
    return { avatarEnabled: false, experimentId: null, variant: null };
  }

  const experiment = await findRunningAvatarExperiment(pool, tenantId);
  if (!experiment) {
    return { avatarEnabled: defaultAvatarEnabled, experimentId: null, variant: null };
  }

  const variant = assignVariant(stickyKey, experiment.trafficSplit);
  const avatarEnabled =
    variant === 'a' ? experiment.variantA.avatarEnabled : experiment.variantB.avatarEnabled;

  return { avatarEnabled, experimentId: experiment.id, variant };
}

/**
 * 割当時点の露出をab_resultsに1行記録する（成果は後から更新 — reconcileAbResultOutcomes参照）。
 * (experiment_id, session_id) にユニーク制約があるため、同一セッションからの複数回呼び出しは
 * 冪等（ON CONFLICT DO NOTHING）。fire-and-forgetで呼ぶこと（結果表示をブロックしない）。
 * migration_ab_results_exposure.sql の適用前（convertedがNOT NULLのまま）の環境では
 * INSERTが失敗しうるため、失敗は握りつぶす（露出記録の欠落は許容し、可用性を優先する）。
 */
export async function recordAvatarExposure(
  pool: Pick<Pool, 'query'>,
  experimentId: number,
  variant: 'a' | 'b',
  sessionId: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ab_results (experiment_id, variant, session_id, converted)
       VALUES ($1, $2, $3::uuid, NULL)
       ON CONFLICT (experiment_id, session_id) DO NOTHING`,
      [experimentId, variant, sessionId],
    );
  } catch {
    // best-effort — 露出記録の失敗でリクエストを失敗させない
  }
}
