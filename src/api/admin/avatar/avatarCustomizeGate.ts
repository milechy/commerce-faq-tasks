// src/api/admin/avatar/avatarCustomizeGate.ts
// avatar_customize（自社アバターの作り込み）ゲートの唯一の判定。
//
// なぜ切り出したか:
// このゲートが必要な生成ルートは generationRoutes.ts の4本
// (generate-image / match-voice / design-voice / generate-prompt) と
// falGenerationRoutes.ts の1本の計5本あり、2ファイルに分かれている。
// 各ルートに if を書き写すと、CLAUDE.md 禁止6「同じ関心事を2ファイルに複製したまま
// 片方だけ直す」の典型になる（premium_avatar のゲートが premiumGenerationRoutes.ts
// にだけ在り、この2ファイルが素通りしていたのが、まさにその状態だった）。
//
// ★avatar ゲートとは別物★
// `avatar`（Standard〜）は「R2C の既定アバターを使えるか」。
// `avatar_customize`（Growth〜）は「自社向けに画像・声・プロンプトを作れるか」。
// Standard(¥9,800)の商品性そのものがこの線引きなので、片方で代用しない。
//
// super_admin はバイパスする。planFeatures.ts 冒頭のバイパス境界に照らすと、
// 画像生成・声マッチングは「1回ごとに原価が発生する staff 起点の操作」であり、
// テナントの権能を永続的に付与する操作(activate_avatar 等)ではないため
// （premium_avatar と同じ扱い、PR #538）。

import type { Pool } from "pg";
import { queryTenantPlan, planHasFeature } from "../../../lib/billing/planFeatures";

/** 拒否時に返す 403 本文。premium_avatar ゲートと同じ形（error + message）に揃える。 */
export interface AvatarCustomizeDenial {
  error: "plan_upgrade_required";
  message: string;
}

// 「次に何をすればよいか」を書く（CLAUDE.md エラーハンドリング）。
// プラン制限は正常系の分岐なので、失敗ではなく Standard で何ができるかも併せて伝える。
export const AVATAR_CUSTOMIZE_DENIAL: AvatarCustomizeDenial = {
  error: "plan_upgrade_required",
  message:
    "アバターの作成・カスタマイズ（画像生成・声の選定・プロンプト生成）はGrowthプラン以上でご利用いただけます。Standardプランでは R2C の既定アバターをそのままご利用いただけます",
};

/**
 * avatar_customize が使えるかを判定し、使えない場合だけ 403 の本文を返す。
 *
 * fail-safe: plan 取得失敗時は queryTenantPlan の既定どおり free_ad 扱い（＝拒否）。
 * 費用の発生する外部API呼び出しの手前で使うこと（拒否したのに原価だけ出る状態を作らない）。
 *
 * @returns 拒否すべきときは 403 本文、通してよいときは null
 */
export async function avatarCustomizeDenial(
  pool: Pick<Pool, "query">,
  isSuperAdmin: boolean,
  tenantId: string,
): Promise<AvatarCustomizeDenial | null> {
  if (isSuperAdmin) return null;
  const plan = await queryTenantPlan(pool, tenantId);
  return planHasFeature(plan, "avatar_customize") ? null : AVATAR_CUSTOMIZE_DENIAL;
}
