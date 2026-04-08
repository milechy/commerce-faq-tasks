// src/lib/research/featureCheck.ts
// Phase60-C: テナントのdeep_researchフラグ読み取り

import { getPool } from '../db';

/**
 * テナントのdeep_researchフィーチャーフラグを読み取る。
 * DB未接続・テナント不在・features未設定の場合は false を返す（safe default）。
 */
export async function isDeepResearchEnabled(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const pool = getPool();
    const result = await pool.query<{ features: Record<string, unknown> | null }>(
      'SELECT features FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    if (result.rows.length === 0) return false;
    const features = result.rows[0]!.features ?? {};
    return features['deep_research'] === true;
  } catch {
    return false; // silent fail — DB unavailable or テナント未登録
  }
}
