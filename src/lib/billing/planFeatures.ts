// src/lib/billing/planFeatures.ts
// LP(r2c.biz)の料金表に対応するプラン別機能制限。
// 表示側(admin-ui/src/pages/admin/tenants/types.ts の PLAN_OPTIONS)と一致させること。
//
// LPの機能マッピング:
//   Growth〜: AIアバター（顔・声）、高度なAnalytics、CV計測
//   Enterprise〜: カスタムアバター（Fish Audio Voice Cloning）
// 「心理学Sales AI」は現状すべてのプランで提供するため、ここでは制限しない。

import type { Pool } from "pg";
import { getPool } from "../db";

export type TenantPlan = "starter" | "growth" | "enterprise";

const PLAN_RANK: Record<TenantPlan, number> = {
  starter: 0,
  growth: 1,
  enterprise: 2,
};

export type GatedFeature = "avatar" | "voice_clone" | "analytics" | "conversion";

const FEATURE_MIN_PLAN: Record<GatedFeature, TenantPlan> = {
  avatar: "growth",
  voice_clone: "enterprise",
  analytics: "growth",
  conversion: "growth",
};

function rank(plan: string | null | undefined): number {
  return PLAN_RANK[plan as TenantPlan] ?? PLAN_RANK.starter;
}

export function planHasFeature(plan: string | null | undefined, feature: GatedFeature): boolean {
  return rank(plan) >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
}

/**
 * 指定のPoolを使ってテナントの現在のプランを取得する。
 * fail-safe: 取得失敗・未設定時は最も制限の強い starter 扱いにする。
 * 呼び出し元が既にpool可用性を確認済みの場合はこちらを直接使う
 * （DB障害時に「plan_upgrade_required」で503を覆い隠さないため）。
 */
export async function queryTenantPlan(
  pool: Pick<Pool, "query">,
  tenantId: string,
): Promise<TenantPlan> {
  try {
    const result = await pool.query<{ plan: string | null }>(
      `SELECT plan FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const plan = result.rows[0]?.plan;
    return plan === "growth" || plan === "enterprise" ? plan : "starter";
  } catch {
    return "starter";
  }
}

/** DBからテナントの現在のプランを取得する（getPool()経由）。 */
export async function getTenantPlan(tenantId: string): Promise<TenantPlan> {
  return queryTenantPlan(getPool(), tenantId);
}

export async function tenantHasFeature(tenantId: string, feature: GatedFeature): Promise<boolean> {
  const plan = await getTenantPlan(tenantId);
  return planHasFeature(plan, feature);
}
