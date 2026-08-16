// admin-ui/src/lib/planFeatures.ts
// LP(r2c.biz)の料金表に対応するプラン別機能制限。
// backend(src/lib/billing/planFeatures.ts)のロジックと一致させること。
//
// GID 1216961878992581: super_admin バイパスの境界（意図的な区別。「割れている」わけではない）。
// 新しいゲートを追加する際は、以下のどちらに当てはまるかで super_admin バイパスの可否を判断すること。
//   - テナントの権能を永続的に付与する操作(features フラグを立てる等) → バイパス不可。
//     super_admin であってもプランを超えた権能付与はさせない
//     (例: activate_avatar — テナントの avatar 機能を有効化する操作、PR #533)。
//   - 1回ごとに原価が発生する staff 起点の操作 → バイパス可。サポート業務を止めない
//     (例: deep_research / premium_avatar / sai_task — その場限りの生成・代行実行、PR #538)。

import type { TenantPlan } from "../auth/useAuth";

const PLAN_RANK: Record<TenantPlan, number> = {
  starter: 0,
  growth: 1,
  enterprise: 2,
};

export type GatedFeature =
  | "avatar"
  | "voice_clone"
  | "analytics"
  | "conversion"
  | "deep_research"
  | "premium_avatar"
  | "sai_task"
  | "pre_dispatch";

const FEATURE_MIN_PLAN: Record<GatedFeature, TenantPlan> = {
  avatar: "growth",
  voice_clone: "enterprise",
  analytics: "growth",
  conversion: "growth",
  // GID 1216944249525907: 原価が跳ねる機能への新規プランゲート
  deep_research: "enterprise",
  premium_avatar: "growth",
  sai_task: "enterprise",
  // GID 1216944004404664: 事前ディスパッチ(アバター高速表示)はLP表記どおりEnterprise限定
  pre_dispatch: "enterprise",
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

/**
 * API応答が「プラン制限による403」かどうかを判定する。
 * 403 plan_upgrade_required は正常系の分岐であり、エラーではない
 * （読み込み失敗の赤帯や「0件」表示と混同しない。CLAUDE.md 絶対にやってはいけないこと 21）。
 */
export function isPlanUpgradeRequired(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === "plan_upgrade_required"
  );
}
