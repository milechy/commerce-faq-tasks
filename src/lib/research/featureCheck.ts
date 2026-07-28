// src/lib/research/featureCheck.ts
// Phase60-C: テナントのdeep_researchフラグ読み取り

import { getPool } from '../db';
import { planHasFeature } from '../billing/planFeatures';

/**
 * テナントのdeep_researchフィーチャーフラグを読み取る。
 * DB未接続・テナント不在・features未設定の場合は false を返す（safe default）。
 *
 * GID 1216944249525907: features.deep_research がONでも、プランがEnterprise未満なら
 * 利用不可とする（Perplexity Sonar ProはGroq系の30-50倍の原価がかかるため）。
 * fail-safe: DB取得失敗時は false（=最も制限の強いstarter相当）を返す。
 */
export async function isDeepResearchEnabled(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const pool = getPool();
    const result = await pool.query<{ features: Record<string, unknown> | null; plan: string | null }>(
      'SELECT features, plan FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    if (result.rows.length === 0) return false;
    const row = result.rows[0]!;
    const features = row.features ?? {};
    if (features['deep_research'] !== true) return false;
    return planHasFeature(row.plan, 'deep_research');
  } catch {
    return false; // silent fail — DB unavailable or テナント未登録
  }
}
