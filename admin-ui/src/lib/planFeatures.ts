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

/** プラン変更の確認画面で「何が増えるか / 何が使えなくなるか」を出すための表示名。 */
export const GATED_FEATURE_LABELS: Record<GatedFeature, string> = {
  avatar: "AIアバター",
  voice_clone: "音声クローン",
  analytics: "会話分析",
  conversion: "成果分析・A/Bテスト",
  deep_research: "ディープリサーチ",
  premium_avatar: "プレミアムアバター生成",
  sai_task: "Sai代行",
  pre_dispatch: "アバターの事前ディスパッチ(高速表示)",
  hide_branding: "「Powered by R2C」バッジの非表示",
};

const ALL_GATED_FEATURES = Object.keys(FEATURE_MIN_PLAN) as GatedFeature[];

/**
 * プランを from → to に変えたときに使えるようになる機能と、使えなくなる機能を返す。
 *
 * 「失う機能」をテナントに事前提示するのが目的なので、画面ごとに
 * planHasFeature を並べ書きせずここに集約する（CLAUDE.md 禁止6）。
 * from が null(プラン未確定)のときは差分を出さない — 未確定を
 * free_ad と同一視すると「全部失う」と誤表示するため（fail-safe の向きに注意）。
 */
export function planFeatureDelta(
  from: TenantPlan | null,
  to: TenantPlan,
): { gained: GatedFeature[]; lost: GatedFeature[] } {
  if (from === null) return { gained: [], lost: [] };
  const gained = ALL_GATED_FEATURES.filter(
    (f) => !planHasFeature(from, f) && planHasFeature(to, f),
  );
  const lost = ALL_GATED_FEATURES.filter(
    (f) => planHasFeature(from, f) && !planHasFeature(to, f),
  );
  return { gained, lost };
}

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

/** 複数レスポンスを一括判定した結果。planLimited と genericFailure は同時に立ちうる。 */
export interface FetchOutcome {
  /**
   * 403 plan_upgrade_required を1本でも受けたか。
   * message を持たない403もあるため、message の有無ではなくこのフラグで判定すること
   * (planLimitMessage が null でも制限は掛かっている場合がある)。
   */
  planLimited: boolean;
  /** サーバが返したプラン制限の理由文。無ければ null(呼び出し側で共通文言に落とす) */
  planLimitMessage: string | null;
  /** プラン制限以外の失敗(5xx・非JSON応答など)を1本でも受けたか */
  genericFailure: boolean;
}

/**
 * 「成功したものだけ state に反映し、失敗はプラン制限とそれ以外に仕分ける」処理。
 *
 * 複数エンドポイントを Promise.all で並列取得する画面(会話分析・成約分析)が
 * 同じ処理を各自で持っていたため共通化した。ページごとに403判定を書かない
 * (CLAUDE.md「実装の置き場所」: プラン制限のフロント判定は planFeatures.ts)。
 *
 * - 403 plan_upgrade_required は正常系の分岐であり genericFailure に含めない
 * - 1本が失敗しても他の成功結果は巻き込まない(applyの呼び出しは独立)
 * - 失敗した項目の apply は呼ばれないため、呼び出し元が「前回値を残すか null に
 *   戻すか」を選べる。古い期間のデータが新しい期間ラベルの下に残らないよう、
 *   呼び出し元は失敗時に null へ倒すこと。
 */
export async function applyFetchResults(
  entries: Array<{ res: Response; apply: (data: unknown) => void }>,
): Promise<FetchOutcome> {
  let planLimited = false;
  let planLimitMessage: string | null = null;
  let genericFailure = false;

  await Promise.all(
    entries.map(async ({ res, apply }) => {
      if (res.ok) {
        apply(await res.json());
        return;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // 非JSON応答(nginx の502 HTML など)は本文を読めない。generic 扱いにする。
      }
      if (isPlanUpgradeRequired(body)) {
        planLimited = true;
        // 複数本が403でも最初の message を代表として使う(同じ制限が並ぶだけのため)
        planLimitMessage =
          planLimitMessage ?? (body as { message?: string }).message ?? null;
      } else {
        genericFailure = true;
      }
    }),
  );

  return { planLimited, planLimitMessage, genericFailure };
}
