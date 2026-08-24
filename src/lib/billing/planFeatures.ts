// src/lib/billing/planFeatures.ts
// LP(r2c.biz)の料金表に対応するプラン別機能制限。
// 表示側(admin-ui/src/lib/planFeatures.ts と admin-ui/src/pages/admin/tenants/types.ts の
// PLAN_OPTIONS)と一致させること。
//
// LPの機能マッピング:
//   Growth〜: AIアバター（顔・声）、高度なAnalytics、CV計測、プレミアムアバター生成
//   Enterprise〜: カスタムアバター（Fish Audio Voice Cloning）、ディープリサーチ、Sai代行（R2Cエージェント）
// 「心理学Sales AI」は現状すべてのプランで提供するため、ここでは制限しない。
//
// GID 1216961878992581: super_admin バイパスの境界（意図的な区別。「割れている」わけではない）。
// 新しいゲートを追加する際は、以下のどちらに当てはまるかで super_admin バイパスの可否を判断すること。
//   - テナントの権能を永続的に付与する操作(features フラグを立てる等) → バイパス不可。
//     super_admin であってもプランを超えた権能付与はさせない
//     (例: activate_avatar — テナントの avatar 機能を有効化する操作、PR #533)。
//   - 1回ごとに原価が発生する staff 起点の操作 → バイパス可。サポート業務を止めない
//     (例: deep_research / premium_avatar / sai_task — その場限りの生成・代行実行、PR #538)。

import type { Pool } from "pg";
import { getPool } from "../db";

export type TenantPlan = "free_ad" | "starter" | "growth" | "enterprise";

// free_ad は starter よりさらに下の最下段（広告原資の無料プラン。テキストチャット限定・
// 月次会話数上限あり）。既存の fail-safe（取得失敗・未設定時は最も制限の強い段）の
// 落とし先を starter から free_ad へ移す。CLAUDE.md 絶対にやってはいけないこと37:
// この落とし先は rank() ・ queryTenantPlan の allowlist ・ queryTenantPlan の catch
// 返り値の3箇所すべてで同時に直すこと。1箇所でも取り残すと、DB障害時に
// 無料テナントが starter へ「昇格」する経路になる（型チェック・テストは通り、
// 障害時にしか発現しないため気づけない）。
const PLAN_RANK: Record<TenantPlan, number> = {
  free_ad: -1,
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
  | "pre_dispatch"
  | "hide_branding";

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
  // ウィジェットの「Powered by R2C」バッジ非表示権。Growth以上の特典として料金表に明記する。
  hide_branding: "growth",
};

// (a) fail-safe 3箇所のうち1つ目: 未知/null/undefinedは最も制限の強い free_ad 扱い。
function rank(plan: string | null | undefined): number {
  return PLAN_RANK[plan as TenantPlan] ?? PLAN_RANK.free_ad;
}

export function planHasFeature(plan: string | null | undefined, feature: GatedFeature): boolean {
  return rank(plan) >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
}

/**
 * 指定のPoolを使ってテナントの現在のプランを取得する。
 * fail-safe: 取得失敗・未設定時は最も制限の強い free_ad 扱いにする。
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
    // (b) fail-safe 3箇所のうち2つ目: 既知の4値のみ通す allowlist。
    // それ以外(null・未知の文字列・テナント不在で rows が空)は free_ad へ倒す。
    if (plan === "free_ad" || plan === "starter" || plan === "growth" || plan === "enterprise") {
      return plan;
    }
    return "free_ad";
  } catch {
    // (c) fail-safe 3箇所のうち3つ目: DB障害時も free_ad へ倒す。
    return "free_ad";
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
