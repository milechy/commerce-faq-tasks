// admin-ui/src/lib/planFeatures.ts
// LP(r2c.biz)の料金表に対応するプラン別機能制限。
// backend(src/lib/billing/planFeatures.ts)のロジックと一致させること。

import type { TenantPlan } from "../auth/useAuth";

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

/**
 * プランが指定機能を利用できるかを判定する。
 * plan未取得(null)時はfail-safeで「利用不可」として扱う
 * （表示側は「まだ確認できていないので隠しておく」が安全なデフォルト）。
 */
export function planHasFeature(plan: TenantPlan | null, feature: GatedFeature): boolean {
  if (plan === null) return false;
  return PLAN_RANK[plan] >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
}
