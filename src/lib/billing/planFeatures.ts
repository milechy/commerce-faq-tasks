// src/lib/billing/planFeatures.ts
// LP(r2c.biz)の料金表に対応するプラン別機能制限。
// 表示側(admin-ui/src/lib/planFeatures.ts と admin-ui/src/pages/admin/tenants/types.ts の
// PLAN_OPTIONS)と一致させること。
//
// LPの機能マッピング:
//   Standard〜: AIアバター（R2C既定アバターの利用のみ。自社アバターの作成は不可）、
//             会話分析（会話数・解決率・未回答質問。自社DB集計で原価ゼロのためStandardへ開放）
//   Growth〜: アバターの自社カスタム作成（avatar_customize）、成果分析（CV計測・A/Bテスト）、
//             プレミアムアバター生成
//   Enterprise〜: カスタムアバター（Fish Audio Voice Cloning）、ディープリサーチ、Sai代行（R2Cエージェント）
// 「心理学Sales AI」は現状すべてのプランで提供するため、ここでは制限しない。
//
// ★avatar と avatar_customize を1つのゲートに戻さないこと★
// Standard(¥9,800)は「アバターを使えること」だけを開放する段で、
// 画像生成・声マッチング・プロンプト生成（Avatar Customization Studio）は Growth 以上。
// 2つを統合すると、Standard の売り(既定アバターで安く始められる)か
// Growth の売り(自社アバターを作れる)のどちらかが消える。
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

export type TenantPlan = "free_ad" | "starter" | "standard" | "growth" | "enterprise";

// free_ad は starter よりさらに下の最下段（広告原資の無料プラン。テキストチャット限定・
// 月次会話数上限あり）。既存の fail-safe（取得失敗・未設定時は最も制限の強い段）の
// 落とし先を starter から free_ad へ移す。CLAUDE.md 絶対にやってはいけないこと37:
// この落とし先は rank() ・ queryTenantPlan の allowlist ・ queryTenantPlan の catch
// 返り値の3箇所すべてで同時に直すこと。1箇所でも取り残すと、DB障害時に
// 無料テナントが starter へ「昇格」する経路になる（型チェック・テストは通り、
// 障害時にしか発現しないため気づけない）。
//
// ★standard は starter と growth の「間」に挿入された段（CLAUDE.md 禁止55）★
// 序数は planHasFeature が `>=` で比較する相対順序そのものなので、
// standard を 1 にする際に growth/enterprise を 2/3 へ繰り上げる必要がある。
// 繰り上げを忘れて standard に既存値と同じ数値を与えると、型チェックもテストの
// 大半も通ったまま「growth と standard が同格」になり、全ゲートが静かに壊れる。
// 値そのものに意味は無く、意味があるのは順序だけ。
const PLAN_RANK: Record<TenantPlan, number> = {
  free_ad: -1,
  starter: 0,
  standard: 1,
  growth: 2,
  enterprise: 3,
};

export type GatedFeature =
  | "avatar"
  | "voice"
  | "avatar_customize"
  | "voice_clone"
  | "analytics"
  | "conversion"
  | "deep_research"
  | "premium_avatar"
  | "sai_task"
  | "pre_dispatch"
  | "hide_branding";

const FEATURE_MIN_PLAN: Record<GatedFeature, TenantPlan> = {
  // アバター「そのもの」を使えるか。Standard は R2C 既定アバターのみ利用できる。
  avatar: "standard",
  // 音声入出力(Fish Audio TTS $15/1M byte・ASR $0.36/audio hour)を使えるか。
  // TTS/ASR は「AIアバター」体験の一部(声で話す/聞く)であり、機能面では avatar と同格。
  // よって最低プランは avatar と揃えて Standard を既定とする。
  // ★方針確認事項★: avatar を持つ Standard 以上のみ音声原価を許容し、free_ad/starter の
  // 公開api-keyからの匿名コスト増幅(Fish課金の全額会社負担・DoS)を止めるのが本ゲートの目的。
  // 「音声は Growth 以上」等に引き上げる場合、既存の Standard アバター利用テナントの
  // 音声が一斉に 403 になる点に注意(実装ではなく料金表・方針の判断)。
  voice: "standard",
  // アバターを自社向けに作り込めるか（画像生成・声マッチング・声デザイン・
  // プロンプト生成 = Avatar Customization Studio）。Standard との差別化の実体。
  avatar_customize: "growth",
  voice_clone: "enterprise",
  // 会話数・解決率・未回答質問など「基本の会話分析」。自社DB集計で限界原価ゼロのため
  // Standardへ開放する(成果分析=conversionと混ぜないこと。2026-08-29に分割)。
  analytics: "standard",
  // 成約率・A/Bテスト等「成果の分析」。Growthの差別化として据え置く。
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

// ★プラン文字列 → TenantPlan の唯一の判定ロジック★
// queryTenantPlan / queryTenantPlanOrThrow / queryTenantPlanResult の3関数は、
// DBから取得した plan 列(文字列 | null)を既知の5値へ検証する部分だけは
// 完全に同一で、違うのは「検証に失敗した(未知/null/DB例外)場合にどう振る舞うか」
// だけだった。以前はこの5値の羅列が3関数にコピペされており、プラン段を
// 追加するたびに3箇所すべてを直す必要があった(1箇所でも取り残すと、
// 型チェック・テストは通ったまま該当プランのテナントが常時 free_ad 扱いに
// なる・DB障害時にしか発現しない等、気づきにくい形で壊れていた)。
//
// fail-safe(DB例外・呼び出し失敗時にどちらへ倒すか)はこの関数の外、
// つまり各呼び出し元の try/catch 側にそのまま残る。この関数自体はDB例外を
// 一切扱わない純粋関数なので、集約してもfail-safeの向きは1つも変わらない:
//   - queryTenantPlan:        catch で free_ad へ丸める(既存のまま)
//   - queryTenantPlanOrThrow: catch を持たず例外をそのまま呼び出し元へ投げる(既存のまま)
//   - queryTenantPlanResult:  catch で null を返す(既存のまま)
//
// ★プラン段を足したらここに必ず加えること★(旧: 3関数それぞれに加える必要があった)
function parseKnownPlan(plan: string | null | undefined): TenantPlan | null {
  if (
    plan === "free_ad" ||
    plan === "starter" ||
    plan === "standard" ||
    plan === "growth" ||
    plan === "enterprise"
  ) {
    return plan;
  }
  return null;
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
    // (b) fail-safe 3箇所のうち2つ目: 既知の5値以外(null・未知の文字列・
    // テナント不在で rows が空)は free_ad へ倒す。判定ロジック自体は
    // parseKnownPlan に集約済み(詳細はそちらのコメント参照)。
    return parseKnownPlan(result.rows[0]?.plan) ?? "free_ad";
  } catch {
    // (c) fail-safe 3箇所のうち3つ目: DB障害時も free_ad へ倒す。
    return "free_ad";
  }
}

/**
 * GID 1217969364194602 [H-7]: queryTenantPlan と異なり、DB問い合わせ自体が例外を
 * 投げた場合は free_ad へ丸め込まず、そのまま呼び出し元へ投げる。
 *
 * queryTenantPlan の fail-safe(DB障害も free_ad = 最も制限が強い段へ倒す)は
 * 「plan を引けなかった以上、機能を開放しない」という向きでは正しいが、
 * pool可用性チェックの後段でこれを使って plan ゲートを掛けている場所では、
 * DB接続断そのものが「plan_upgrade_required」(403)に化けてしまう
 * (テナントに「プランを契約してください」という誤った案内をし、
 * 実際に起きているDB障害を隠してしまう)。呼び出し元が503/500として
 * 扱えるよう、ここでは例外を握り潰さない。
 *
 * plan列がnull/未知の文字列/テナント不在(rowsが空)の場合は、DB障害ではなく
 * データの状態そのものなので、従来通り free_ad へ倒す(判定ロジック自体は
 * parseKnownPlan に集約済み。DB例外時にどう振る舞うかだけが
 * queryTenantPlan/queryTenantPlanResult と異なる)。
 */
export async function queryTenantPlanOrThrow(
  pool: Pick<Pool, "query">,
  tenantId: string,
): Promise<TenantPlan> {
  const result = await pool.query<{ plan: string | null }>(
    `SELECT plan FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return parseKnownPlan(result.rows[0]?.plan) ?? "free_ad";
}

// /api/chat は全リクエストで getTenantPlan() を呼ぶ(free_ad以外のプランでも毎回)。
// この関数がコードベース全体でqueryTenantPlanのprod唯一の呼び出し元であり、
// 恒久的なDBラウンドトリップが最高トラフィックエンドポイントに乗っている状態を
// 緩和するため、TTL 60秒の薄いインメモリキャッシュを手前に挟む。
// queryTenantPlan自体(DB問い合わせ+fail-safe処理)は変更しない。
// プラン変更(管理操作)がTTL内は反映されないトレードオフを許容する
// (動的ウィジェットルート自体が既に24hキャッシュを許容している設計と整合、
// src/lib/billing/planFeatures.test.ts 参照)。
const TENANT_PLAN_CACHE_TTL_MS = 60 * 1000; // 60 seconds

interface TenantPlanCacheEntry {
  plan: TenantPlan;
  expiresAt: number;
}

export const tenantPlanCache: Map<string, TenantPlanCacheEntry> = new Map();

/** DBからテナントの現在のプランを取得する（getPool()経由、TTLキャッシュ付き）。 */
export async function getTenantPlan(tenantId: string): Promise<TenantPlan> {
  const cached = tenantPlanCache.get(tenantId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.plan;
  }

  const plan = await queryTenantPlan(getPool(), tenantId);
  tenantPlanCache.set(tenantId, { plan, expiresAt: now + TENANT_PLAN_CACHE_TTL_MS });
  return plan;
}

/**
 * プラン変更直後に呼び、キャッシュ由来の最大60秒の遅延を消す。
 *
 * ★これは「同一プロセス内」のキャッシュしか消せない★
 * 現構成は単一プロセス(ecosystem.config.cjs: instances 1 / exec_mode fork)なので、
 * この呼び出しでプロセス内の判定は即座に新プランへ切り替わる。
 * ただしキャッシュはプロセスローカルなので、将来スケールアウトすると
 * 他ワーカーが最大 TTL 分だけ旧プランを見る。その前提で書いてある。
 *
 * なお動的ウィジェット配信は Cache-Control 24h（CLAUDE.md 禁止38）で、
 * こちらはワーカー数に関係なく残る。プラン変更を「即時反映」と表現しないこと。
 */
export function invalidateTenantPlanCache(tenantId: string): void {
  tenantPlanCache.delete(tenantId);
}

export async function tenantHasFeature(tenantId: string, feature: GatedFeature): Promise<boolean> {
  const plan = await getTenantPlan(tenantId);
  return planHasFeature(plan, feature);
}

/**
 * free_ad プランか(= R2Cの広告帯を掲出するか)。
 *
 * ★FEATURE_MIN_PLAN に入れてはいけない★
 * planHasFeature は rank(plan) >= rank(min) の「以上」判定なので、
 * 「free_ad のときだけ true」という逆向きの述語は表現できない。
 *
 * ★fail-safe の向きが planHasFeature と逆★
 * 未知/null は false(掲出しない)へ倒す。有料テナントのサイトに
 * 誤って広告が出る方が、無料テナントで掲出漏れが起きるより重い。
 */
export function planShowsAdPromo(plan: string | null | undefined): boolean {
  return plan === "free_ad";
}

// ---------------------------------------------------------------------------
// S4(共有学習プールの参加モデル): プラン別の share(共有プール参加)既定値・強制。
//
// ★fail-safeの向きがqueryTenantPlanと反転する★
// queryTenantPlan/getTenantPlanのfail-safe(未知・null・DB障害を free_ad に倒す)は
// 機能ゲート(planHasFeature)にとっては正しい(free_adが最も制限が強い段だから)。
// しかしデータ提供(share)にとっては free_ad が最も「開いている」側になる
// (free_ad は share 強制ON)。そのため
//   if (plan === "free_ad") share = true
// を queryTenantPlan の結果にそのまま適用すると、DB障害や未知プランの瞬間に
// 全テナントが強制データ共有になってしまう。
//
// これを避けるため、「プランが確実に free_ad と判明した」ケースと
// 「プラン取得に失敗した／未知だった」ケースを型で区別できる
// queryTenantPlanResult を queryTenantPlan とは別に用意する。判定不能時は
// 強制を適用しない(share は既定OFFへ倒す)。
// ---------------------------------------------------------------------------

/**
 * テナントの現在のプランを取得する。queryTenantPlan と異なり fail-safe に相乗りせず、
 * 「確実に5値のいずれかと判明したか」を呼び出し側が区別できるよう null で失敗を表す。
 *
 * - DB例外 → null（取得失敗。free_ad と確定させない）
 * - plan列が null / 未知の文字列 / テナント不在(rowsが空) → null（未確定）
 * - 既知の5値のいずれか → その値
 *
 * queryTenantPlan(機能ゲート用。未知/null/DB障害はfree_adへ倒す)とは用途が異なるため、
 * 実装を共有せず独立させている。共有すると片方の修正がもう片方のfail-safeの向きを
 * 意図せず変えてしまう事故が起きやすい。
 */
export async function queryTenantPlanResult(
  pool: Pick<Pool, "query">,
  tenantId: string,
): Promise<TenantPlan | null> {
  try {
    const result = await pool.query<{ plan: string | null }>(
      `SELECT plan FROM tenants WHERE id = $1`,
      [tenantId],
    );
    // 判定ロジック自体は parseKnownPlan に集約済み。未確定時に free_ad へ
    // 丸めず null を返す点が queryTenantPlan/queryTenantPlanOrThrow と異なる
    // (このfail-safeの向きの違いが本関数の存在理由なので、ここは変えない)。
    return parseKnownPlan(result.rows[0]?.plan);
  } catch {
    return null;
  }
}

// resolveShareForPlan の戻り値。「強制されているか」と「(強制でない場合の)既定値」を
// 呼び出し側が区別できる形にする。強制されていない場合、default は常に false
// (share は外部提供を伴うため、fail-safeとしても既定は無効側に倒す)。
export type ShareForPlanResolution = { forced: true; value: true } | { forced: false; default: boolean };

/**
 * 「確実に判明したプラン(または未確定=null)」から、share(共有プール参加)の
 * 既定値・強制を解決する。
 *
 * - plan が確実に free_ad と判明した場合のみ、強制ON({forced:true, value:true})。
 * - plan が null(取得失敗・未知・未設定などプラン確定不能)の場合は、
 *   free_ad 扱いにせず強制しない({forced:false, default:false})。
 *   ★ここが本タスク最大の罠: queryTenantPlan の fail-safe(未知→free_ad)に
 *   相乗りしてはいけない。相乗りすると DB障害時に全テナントが強制共有になる。★
 * - starter/standard/growth/enterprise は選択可能・既定OFF({forced:false, default:false})。
 */
export function resolveShareForPlan(plan: TenantPlan | null): ShareForPlanResolution {
  if (plan === "free_ad") {
    return { forced: true, value: true };
  }
  return { forced: false, default: false };
}

/**
 * queryTenantPlanResult + resolveShareForPlan をまとめた便宜関数。
 * 呼び出し元が独自にPoolを注入できる箇所(actionExecutor.ts等、テストのモックPoolと
 * 食い違わせないため getPool() を直接呼ばない箇所)向け。
 */
export async function resolveShareForTenantPlan(
  pool: Pick<Pool, "query">,
  tenantId: string,
): Promise<ShareForPlanResolution> {
  const plan = await queryTenantPlanResult(pool, tenantId);
  return resolveShareForPlan(plan);
}
