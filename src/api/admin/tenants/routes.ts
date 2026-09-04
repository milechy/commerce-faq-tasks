// src/api/admin/tenants/routes.ts
import type { Express, NextFunction, Request, Response } from "express";
import type { AuthedReq } from "../../middleware/roleAuth";
import { isAllowedAdminRole } from "../../middleware/roleAuth";

import { Pool } from "pg";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { registerTenant, updateTenantEnabled, updateTenantAllowedOrigins, setTenantApiKeyExpiry, revokeTenantApiKey, addTenantApiKey } from "../../../lib/tenant-context";
import { invalidateWorkspaceCache } from "../../../agent/openclaw/workspaceCache";
import { generateApiKey, hashApiKey, maskApiKeyPrefix } from "./apiKeyUtils";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import { DEFAULT_AVATARS } from "../avatar/routes";
import { logger } from '../../../lib/logger';
import { planHasFeature, resolveShareForPlan, resolveShareForTenantPlan, invalidateTenantPlanCache, type TenantPlan } from "../../../lib/billing/planFeatures";
import { invalidateBillingPlanCache } from "../../../lib/billing/usageTracker";
import { syncSubscriptionForTenant, needsBillingAttention, type SubscriptionSyncResult } from "../../../lib/billing/subscriptionSync";
// CP-3(GID 1218086647623729): PUT /v1/admin/my-tenant/plan の本体を切り出した共通関数。
// change_my_plan ツール(agent/actionExecutor.ts)もこれを直接呼ぶ(ロジックを2箇所に書き写さない)。
import { changeTenantPlan, computeFeatureRevocationOnDowngrade } from "../../../lib/billing/changeTenantPlan";
import { deriveOnboardingStage, type OnboardingStageStatus } from "../agent/onboardingStage";
import { isValidOriginPattern } from "../../middleware/originCheck";
import { isValidExcludedPagePattern } from "../../../lib/excludedPagePattern";
import { purgeTenantChatData } from "../chat-history/retentionRepository";
import { computeExpectedBilling } from "../../../lib/billing/stripeSync";
import { getMonthRangeJst } from "../../../lib/billing/planQuota";
import { computeUpsellSignals, type UpsellSignal } from "../../../lib/billing/upsellSignals";
import { buildTenantUpsellFigures } from "../../../lib/billing/billingApi";
import { renderUpsellForTenant } from "../../../lib/billing/upsellRenderer";

// free_ad(starterより下の最下段。広告原資の無料プラン)と
// standard(starter と growth の間。既定アバターの利用を開放する段)を含む5値。
// src/lib/billing/planFeatures.ts の TenantPlan と一致させること
// (既知の多重化。DBのCHECK制約は migration_free_ad_plan.sql /
//  migration_standard_plan.sql で別途対応が必要)。
//
// ★このZod enumがプラン段の「到達可能性」そのもの★
// ここに無い値は POST/PATCH /v1/admin/tenants も PUT /v1/admin/my-tenant/plan も
// 400 で弾くため、PLAN_RANK や CHECK 制約を直しても誰もそのプランになれない。
// export: change_my_plan ツール(toolDefinitions.ts/actionExecutor.ts)が
// JSONスキーマのenumと実行時バリデーションの両方でこの配列を直接参照するため
// (5値をツール側に書き写すと、ここに値を足したときの追随漏れが起きる)。
export const planValues = ["free_ad", "starter", "standard", "growth", "enterprise"] as const;

// CP-3(GID 1218086647623729): change_my_plan ツールが選ばせてよい値。
// テナント自己申告経路(このファイルのPUT /v1/admin/my-tenant/plan、および
// change_my_plan)は free_ad/enterprise を常に拒否する
// (blockFreeAdTransition/blockEnterpriseSelfUpgrade、下記)ため、ツールの
// JSONスキーマ enum に含めても選べるだけ無駄になる。除外対象をここ1箇所にする
// ことで、toolDefinitions.ts 側に別の配列を書き写す事故を防ぐ。
export const SELF_SERVICE_PLAN_VALUES = planValues.filter(
  (p) => p !== "enterprise" && p !== "free_ad"
);

// S5b(共有学習プールの参加モデル・D1決定案): free_adはshareが強制ONだが、消費者向け
// 同意バナーの開示基盤が整うまでfree_adテナントを増やさない、という一時的なブロック。
//
// ★free_ad へ遷移しうる経路が増えたら、必ずこの関数を通すこと★
// 導入時(PR #918)は super_admin の POST/PATCH の2経路しか無かったが、その後
// テナント自身のプラン変更(PUT /v1/admin/my-tenant/plan)が加わった。経路ごとに
// if を書き写すと、新しい経路がガードを素通りする(実際に一度素通りした)。
// 環境変数化しない(CLAUDE.md 禁止41の精神。誰にも開ける余地を残さないため)。
//
// 撤去する際は、この関数の呼び出し元をすべて外すのではなく、この関数の中身だけを
// 変えれば全経路に効く。撤去の前提だったバナー実装(S5a・PR #919)は完了済み。

// computeFeatureRevocationOnDowngrade は src/lib/billing/changeTenantPlan.ts へ移設した
// (CP-3, GID 1218086647623729)。PUT /v1/admin/my-tenant/plan の本体を丸ごとそちらへ
// 切り出したのに合わせ、PATCH /v1/admin/tenants/:id(このファイル内、下記)からは
// 移設先を re-import して使う。定義を2箇所に持たない。

// CP-3: blockFreeAdTransition/blockEnterpriseSelfUpgrade は res を直接書くため
// change_my_plan ツール(agent/actionExecutor.ts)からは共有できない。判定部分だけを
// 下の純関数(isFreeAdTransition/isEnterpriseSelfUpgrade)に割り、ツール側はこちらを
// 呼んで拒否理由の文字列を独自に組み立てる。判定基準の値("free_ad"/"enterprise")は
// この2つの純関数だけが持ち、他のどこにも書き写さないこと。

/** nextPlan が free_ad への遷移かどうかの判定だけを行う純関数。 */
export function isFreeAdTransition(plan: string | undefined): boolean {
  return plan === "free_ad";
}

function blockFreeAdTransition(plan: string | undefined, res: Response): boolean {
  if (!isFreeAdTransition(plan)) return false;
  res.status(403).json({
    error: "free_ad_plan_not_yet_available",
    message: "free_adプランは消費者向け同意バナー実装まで新規発行できません(D1決定案)。",
  });
  return true;
}

// enterprise は個別契約(planPricing.ts の isSelfServeBillablePlan が既に
// plan_not_self_serve として弾いている線)なので、テナント自己申告での昇格は
// 許さない。ここを抜くと、無制限利用枠 + voice_clone/deep_research/sai_task
// (planFeatures.ts)が請求経路の無いまま即座に開く(2026-08-26 レビュー是正
// GID 1217860479559418)。syncSubscriptionItemsToPlan は enterprise を
// manual_plan として返すだけで Stripe に触れないため、サーバ側で防がない限り
// UI 側だけの制限になる(CLAUDE.md 禁止14)。

/** nextPlan が enterprise への自己申告アップグレードかどうかの判定だけを行う純関数。 */
export function isEnterpriseSelfUpgrade(plan: string | undefined): boolean {
  return plan === "enterprise";
}

function blockEnterpriseSelfUpgrade(plan: string | undefined, res: Response): boolean {
  if (!isEnterpriseSelfUpgrade(plan)) return false;
  res.status(403).json({
    error: "enterprise_requires_sales",
    message: "Enterprise は個別契約です。担当までお問い合わせください。",
  });
  return true;
}

// 許可オリジンの検証。super_admin用(updateTenantSchema)と client_admin 自己申告用
// (PATCH /v1/admin/my-tenant)で同一インスタンスを共有し、片方だけ緩いという事故を防ぐ。
// 判定本体は originCheck.ts の isValidOriginPattern に置き、照合ロジックと同じ定義を使う。
const allowedOriginsSchema = z
  .array(
    z
      .string()
      .refine(isValidOriginPattern, {
        message:
          "URLはhttps://で始まる必要があります。ワイルドカードは https://*.example.com の形式のみ使用できます",
      })
  )
  .max(20)
  .optional();

// 許可ドメイン内でも特定ページではウィジェットを出したくない、というテナント自己設定。
// allowedOriginsSchema と同じ理由(super_admin用とclient_admin自己申告用で片方だけ緩い
// 状態を作らない)で単一インスタンスを共有する。判定本体は isValidExcludedPagePattern
// (src/lib/excludedPagePattern.ts)に置き、チャットツール側(actionExecutor.ts)とも
// 同じ定義を使う(allowed_originsのisValidOriginPatternと同じパターン)。
const excludedPagePatternsSchema = z
  .array(
    z
      .string()
      .refine(isValidExcludedPagePattern, {
        message: "パスは / から始め、?や#を含まない200文字以内の形式で指定してください（例: /cart, /products/*, /blog/**）",
      })
  )
  .max(20)
  .optional();

// S2: 共有学習プールの参加モデル。同意を「1フラグ」から独立した2軸に分ける。
// - learn : 自社内学習。自テナントの会話から自テナント用に学習する(データは外に出ない)。
// - share : 共有プール参加。R2C共有プールに「出し、かつ読む」(外部Hermes VPSへ出る)。
// learn=false かつ share=true(自社が学ばないのに他社へ出す)は不整合として拒否する。
// 同意は本来テナント自身のものなので、super_admin用スキーマ(featuresSchema)と
// client_admin自己申告用(PATCH /v1/admin/my-tenant)の両方に足す必要がある。ただし
// featuresSchema全体を共有インスタンス化すると sales_stage_continuity 等の
// 運用者限定フラグ(上記コメント参照)まで自己申告できてしまうため、featuresSchema自体は
// 共有せず、learning部分だけを切り出して同一インスタンスを共有する
// (allowed_originsSchemaと同じ考え方: 検証ロジック・エラーメッセージの重複による
// 片方だけ緩くなる事故を防ぐ)。
const learningConsentSchema = z
  .object({
    learn: z.boolean(),
    share: z.boolean(),
  })
  .refine((v) => !(v.learn === false && v.share === true), {
    message: "learn=false かつ share=true は指定できません",
  });

// 日付のみの文字列("2026-01-01"等)はUTC深夜と解釈されるため、意図したタイムゾーンと
// ズレて「まだ未来のつもりが過去判定される」事故が起きやすい。バリデーションのロジックは
// 変えず、エラーメッセージでタイムゾーン付きISO-8601形式を案内する。
const EXPIRES_AT_FORMAT_HINT = "expires_atはタイムゾーンを含むISO-8601形式（例: 2026-01-01T00:00:00+09:00）で指定してください。日付のみの指定はUTC深夜として解釈されます。";

// APIキー発行時の expires_at 検証。super_admin向け・client_admin向け両方の
// キー発行エンドポイントで共有する（複製しない）。
function validateExpiresAt(
  raw: unknown
): { expiresAt: Date | null } | { error: string; message: string } {
  if (!raw) return { expiresAt: null };
  const expiresAt = new Date(raw as string);
  if (isNaN(expiresAt.getTime())) {
    return { error: "invalid_expires_at", message: EXPIRES_AT_FORMAT_HINT };
  }
  // 過去日時を許可すると、発行直後から使えない「死んだキー」が201で作れてしまう。
  if (expiresAt.getTime() <= Date.now()) {
    return { error: "expires_at_in_past", message: `expires_atは未来の日時である必要があります。${EXPIRES_AT_FORMAT_HINT}` };
  }
  return { expiresAt };
}

// GID 1216274591838389: 初回ログイン時オンボーディングの業種選択肢
const onboardingIndustryValues = ["auto", "beauty", "food", "realestate", "retail", "other"] as const;

const createTenantSchema = z.object({
  id: z.string().min(3).max(50).regex(/^[a-z0-9_-]+$/, "IDは英小文字・数字・ハイフン・アンダースコアのみ"),
  name: z.string().min(1).max(100),
  plan: z.enum(planValues).default("starter"),
});

const featuresSchema = z.object({
  avatar: z.boolean(),
  voice: z.boolean(),
  rag: z.boolean(),
  deep_research: z.boolean().optional(),
  pre_dispatch: z.boolean().optional(),
  // Phase75: Hermes Agent(CVR学習エージェント)が会話ログ生データを横断利用することへの
  // テナント同意フラグ。既定false(未設定=同意なし、fail-safe)。同意は本来テナント自身が
  // 行うべきものなので、super_admin用スキーマだけでなく client_admin 自己申告の
  // PATCH /v1/admin/my-tenant(下記)にも同じキーを追加している。
  hermes_raw_data_consent: z.boolean().optional(),
  // 会話の段階引き継ぎ(SalesFlow)。dialogAgent.ts の isSalesStageContinuityEnabled が
  // features->>'sales_stage_continuity' === "true" で読む。実装済みだがこのスキーマに
  // 無かったため、super_admin の PATCH が zod で弾かれ **DB直更新でしか開けられなかった**。
  // CLAUDE.md 禁止35: 会話の振る舞いを変える機能なので全テナント一斉に開けない。
  // 運用者が開ける機能であり、client_admin 自己申告の PATCH /v1/admin/my-tenant には足さない。
  sales_stage_continuity: z.boolean().optional(),
  // お客様がAIの回答を評価する(👍👎)UIをウィジェットに出すか。
  // **未設定は「出す」**(決定 D1: 既定ON)。教師信号を集めるのが目的で、
  // 出さない選択はテナント側の事情(購入導線を邪魔したくない等)にのみ使う。
  // false を明示したテナントだけ非表示にする。
  answer_feedback: z.boolean().optional(),
  // S2: 共有学習プールの参加モデル。同意の2軸(learn/share)。詳細は learningConsentSchema
  // のコメント参照。未設定時の後方互換解決(learn=true固定、shareは旧hermes_raw_data_consent
  // から)は src/lib/hermesConsent.ts の resolveLearningConsent が行う。
  learning: learningConsentSchema.optional(),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  plan: z.enum(planValues).optional(),
  is_active: z.boolean().optional(),
  allowed_origins: allowedOriginsSchema,
  excluded_page_patterns: excludedPagePatternsSchema,
  // Phase38 Step6: テナント固有システムプロンプト（空文字でリセット可）
  system_prompt: z.string().max(5000).optional(),
  // Phase39: 課金管理（Super Adminのみ）
  billing_enabled: z.boolean().optional(),
  billing_free_from: z.string().datetime({ offset: true }).nullable().optional(),
  billing_free_until: z.string().datetime({ offset: true }).nullable().optional(),
  // Phase40: アバター機能フラグ
  features: featuresSchema.optional(),
  lemonslice_agent_id: z.string().max(200).nullable().optional(),
  // Phase52f: コンバージョンタイプ（文字列配列、最大10件、各50文字以内）
  conversion_types: z.array(z.string().max(50)).max(10).optional(),
  // Phase A Day 6: テナント担当者メールアドレス
  tenant_contact_email: z.string().email().nullable().optional(),
  // GID 1216274385106667: FAQ登録フォームの質問/回答欄カスタムヒント（空文字/nullで既定プレースホルダーに戻す）
  faq_question_hint: z.string().max(200).nullable().optional(),
  faq_answer_hint: z.string().max(200).nullable().optional(),
});

// aaas_clients は共有Supabaseプロジェクト内のAaaS(R2C2)側所有テーブル
// (r2c_tenant_id で tenants.id を参照)。AaaS側マイグレーション未適用環境でも
// /v1/admin/my-tenant 全体を壊さないよう、失敗時は「R2C2未契約」扱いにフォールバックする。
async function checkHasR2c2(db: Pool, tenantId: string): Promise<boolean> {
  try {
    const result = await db.query(
      `SELECT 1 FROM aaas_clients WHERE r2c_tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn("[checkHasR2c2] aaas_clients query failed (migration not applied yet?)", err);
    return false;
  }
}

// Asana 1217040568432160: オンボーディング4段階(docs/ONBOARDING_FIRST_LOGIN.md §3.1③)のうち、
// tenants テーブルの列だけでは導出できない2段階(知識公開/初回実会話)を取得する。
// checkHasR2c2 と同じくフェイルセーフ(各クエリ失敗時は false のまま返し、
// my-tenant 応答全体を壊さない)。導出ロジック自体は onboardingStage.ts の単一情報源に従う。
async function fetchOnboardingStageStatus(
  db: Pool,
  tenantId: string,
  tenantCreatedAt: string,
  onboardingIndustry: string | null,
  onboardingWidgetSeenAt: string | null
): Promise<OnboardingStageStatus | null> {
  // オンボ 是正A-2: 公開済み/下書きの両方の有無を1クエリで取る(hasDraftFaqは
  // stage2の「下書きを見る」と「たたき台を作る」を切り分けるためのヒント)。
  let hasPublishedFaq = false;
  let hasDraftFaq = false;
  try {
    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_published) AS published_count,
         COUNT(*) FILTER (WHERE NOT is_published) AS draft_count
       FROM faq_docs WHERE tenant_id = $1`,
      [tenantId]
    );
    const row = result.rows[0] as { published_count: string; draft_count: string } | undefined;
    hasPublishedFaq = Number(row?.published_count ?? 0) > 0;
    hasDraftFaq = Number(row?.draft_count ?? 0) > 0;
  } catch (err) {
    logger.warn("[fetchOnboardingStageStatus] faq_docs query failed", err);
  }

  let hasRealConversation = false;
  try {
    const result = await db.query(
      `SELECT 1 FROM chat_sessions WHERE tenant_id = $1 AND metadata->>'source' = 'user' LIMIT 1`,
      [tenantId]
    );
    hasRealConversation = (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn("[fetchOnboardingStageStatus] chat_sessions query failed", err);
  }

  return deriveOnboardingStage({
    tenantCreatedAt,
    onboardingIndustry,
    onboardingWidgetSeenAt,
    hasPublishedFaq,
    hasRealConversation,
    hasDraftFaq,
  });
}

export function registerTenantAdminRoutes(app: Express, db: Pool): void {
  // JWT検証は共有実装(src/admin/http/supabaseAuthMiddleware.ts)に一本化。
  // ここでは req.supabaseUser の型を AuthedReq として扱えるよう別名で束ねるのみ。
  //
  // 以前はこのファイルだけインライン実装が残っており、secret 未設定時に production でも
  // 無条件 next() する fail-open だった（共有実装は production で503）。テナントCRUD・
  // APIキー発行/失効・招待という最高権限面が、他ルータより弱い認証で守られていた状態。
  // alg 固定(HS256)も共有実装側に集約されている。
  const tenantAuth = supabaseAuthMiddleware;

  function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
    const su = (req as AuthedReq).supabaseUser;
    // セキュリティ要件: 認可ロールは app_metadata.role のみを信頼する
    // user_metadata はクライアント編集可能なため、特権判定に使用してはならない
    const rawRole = su?.app_metadata?.role;
    const role = typeof rawRole === "string" ? rawRole : "";
    if (role !== "super_admin") {
      res.status(403).json({ error: "forbidden", message: "スーパー管理者のみアクセスできます" });
      return;
    }
    next();
  }

  // セキュリティ要件: /v1/admin/my-tenant はロールを検証せずtenant_id claimのみで認可していた
  // （どのロールの認証済みユーザーでもapp_metadata.tenant_idさえあれば通過できてしまう不具合）。
  // super_admin / client_admin のみ許可する（roleAuth.ts の ALLOWED_ADMIN_ROLES と同じ判定）。
  function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
    const su = (req as AuthedReq).supabaseUser;
    const role = su?.app_metadata?.role;
    if (!isAllowedAdminRole(role)) {
      res.status(403).json({ error: "forbidden", message: "この操作を行う権限がありません" });
      return;
    }
    next();
  }
  // ─────────────────────────────────────────────────────────────────────────

  // GET /v1/admin/my-tenant — Client Admin専用: JWTのtenant_idで自分のテナント情報を返す
  app.get("/v1/admin/my-tenant", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }
    try {
      const result = await db.query(
        // 既知の不具合修正: allowed_origins がここに無かったため、AllowedOriginsSettings.tsx が
        // 常に空配列を読み込み、1件追加するだけで保存済みの許可ドメインを黙って全消しする
        // データ消失事故になっていた。excluded_page_patterns も同じ経路で読むため同時に追加する。
        `SELECT id, name, plan, features, lemonslice_agent_id, conversion_types, faq_question_hint, faq_answer_hint, onboarding_industry, onboarding_completed_at, onboarding_widget_seen_at, widget_theme, allowed_origins, excluded_page_patterns, created_at FROM tenants WHERE id = $1`,
        [tenantId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません" });
      }
      const row = result.rows[0] as {
        onboarding_industry: string | null;
        onboarding_widget_seen_at: string | null;
        created_at: string;
      };
      const has_r2c2 = await checkHasR2c2(db, tenantId);
      const onboarding_stage = await fetchOnboardingStageStatus(
        db,
        tenantId,
        row.created_at,
        row.onboarding_industry,
        row.onboarding_widget_seen_at
      );
      return res.json({ ...result.rows[0], has_r2c2, onboarding_stage });
    } catch (err) {
      logger.warn("[GET /v1/admin/my-tenant]", err);
      return res.status(500).json({ error: "取得に失敗しました" });
    }
  });

  // PATCH /v1/admin/my-tenant — Client Admin専用: featuresのavatar/voiceのみ更新可
  app.patch("/v1/admin/my-tenant", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }
    const bodySchema = z.object({
      features: z.object({
        avatar: z.boolean(),
        voice: z.boolean(),
        rag: z.boolean(),
        deep_research: z.boolean().optional(),
        pre_dispatch: z.boolean().optional(),
        // Phase75: テナント自身によるHermes Agent向け生データ利用同意の自己申告
        hermes_raw_data_consent: z.boolean().optional(),
        // S2: 共有学習プールの参加モデル。同意はテナント自身のものなので、super_admin用の
        // featuresSchemaと同一インスタンス(learningConsentSchema)を共有する。
        learning: learningConsentSchema.optional(),
      }).optional(),
      // GID 1216274385106667: FAQ登録フォームの質問/回答欄カスタムヒント（client_admin自己申告）
      faq_question_hint: z.string().max(200).nullable().optional(),
      faq_answer_hint: z.string().max(200).nullable().optional(),
      // GID 1216274591838389: 初回ログインオンボーディングの回答業種（設定時にonboarding_completed_atも自動更新）
      onboarding_industry: z.enum(onboardingIndustryValues).optional(),
      // LAUNCH: ウィジェット許可オリジンのテナント自己設定。super_admin用updateTenantSchemaと
      // 同一のスキーマインスタンスを共有する（片方だけ検証が緩い状態を作らないため）。
      // client_admin向けフォーム(AllowedOriginsSettings.tsx)はワイルドカードを一律拒否する
      // より厳しいUIだが、バックエンドはここで安全な形(https://*.example.com)のみ通す。
      allowed_origins: allowedOriginsSchema,
      // ページ除外設定のテナント自己申告。同じくsuper_admin用updateTenantSchemaと
      // 同一インスタンス(excludedPagePatternsSchema)を共有する。
      excluded_page_patterns: excludedPagePatternsSchema,
    });
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
    }
    // LP料金表(Standard〜: AIアバター)に基づくプラン制限。
    // avatar/voiceをtrueにするにはStandard以上のプランが必要（UIの非表示に加えAPI側でも防御）。
    // 自社アバターの作成(avatar_customize)はGrowth以上で、そちらは
    // generationRoutes.ts / falGenerationRoutes.ts が別途ゲートする。
    if (fields.features?.avatar === true || fields.features?.voice === true) {
      const planResult = await db.query<{ plan: TenantPlan | null }>(
        `SELECT plan FROM tenants WHERE id = $1`,
        [tenantId]
      );
      if (!planHasFeature(planResult.rows[0]?.plan, "avatar")) {
        return res.status(403).json({
          error: "plan_upgrade_required",
          message: "AIアバター機能はStandardプラン以上でご利用いただけます",
        });
      }
    }
    // S5: 共有学習プールの参加モデル。free_ad(確実に判定できた場合のみ)は share 強制ON。
    // actionExecutor.ts の set_hermes_consent ツールと同じ判定を、テナント自身が直接叩ける
    // このPATCHルートにも適用する(でないとCopilot経由をすり抜けて強制を回避できてしまう)。
    if (fields.features?.learning?.share === false) {
      const shareResolution = await resolveShareForTenantPlan(db, tenantId);
      if (shareResolution.forced) {
        return res.status(403).json({
          error: "share_forced_by_plan",
          message: "広告プランでは共有プールへの参加が必須です。有料プランへの変更が必要です。",
        });
      }
    }
    try {
      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (fields.features !== undefined) { params.push(JSON.stringify(fields.features)); setClauses.push(`features = COALESCE(features, '{}'::jsonb) || $${params.length}::jsonb`); }
      if ('faq_question_hint' in fields) { params.push(fields.faq_question_hint ?? null); setClauses.push(`faq_question_hint = $${params.length}`); }
      if ('faq_answer_hint' in fields) { params.push(fields.faq_answer_hint ?? null); setClauses.push(`faq_answer_hint = $${params.length}`); }
      if (fields.onboarding_industry !== undefined) {
        params.push(fields.onboarding_industry);
        setClauses.push(`onboarding_industry = $${params.length}`);
        setClauses.push(`onboarding_completed_at = NOW()`);
      }
      if (fields.allowed_origins !== undefined) { params.push(fields.allowed_origins); setClauses.push(`allowed_origins = $${params.length}`); }
      if (fields.excluded_page_patterns !== undefined) { params.push(fields.excluded_page_patterns); setClauses.push(`excluded_page_patterns = $${params.length}`); }
      setClauses.push(`updated_at = NOW()`);
      params.push(tenantId);
      const result = await db.query(
        `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = $${params.length}
         RETURNING id, name, features, lemonslice_agent_id, faq_question_hint, faq_answer_hint, onboarding_industry, onboarding_completed_at, allowed_origins, excluded_page_patterns`,
        params
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません" });
      }
      // allowed_originsはインメモリのtenantStoreも参照されるため即時反映する
      // （未指定なら呼ばない。空配列指定=制限全解除と未指定=変更なしを区別する）。
      if (fields.allowed_origins !== undefined) {
        updateTenantAllowedOrigins(tenantId, fields.allowed_origins);
      }
      // excluded_page_patternsはミドルウェアが参照する値ではなく、ウィジェット生成時に
      // DBから直接読むため、tenantStoreのミラー更新は不要（allowed_originsとの違い）。
      return res.json(result.rows[0]);
    } catch (err) {
      logger.warn("[PATCH /v1/admin/my-tenant]", err);
      return res.status(500).json({ error: "更新に失敗しました" });
    }
  });

  // PUT /v1/admin/my-tenant/plan — Client Admin専用: テナント自身によるプラン変更。
  //
  // なぜ PATCH /v1/admin/my-tenant に相乗りさせないか:
  // プランは課金額と権能の両方を動かす操作で、監査記録・キャッシュ無効化・
  // 変更内容の返却が他フィールドと異なる。汎用PATCHに混ぜると、将来
  // allowed_origins などを更新する呼び出しが plan を巻き添えで変えうる。
  //
  // tenantId は JWT の app_metadata.tenant_id のみから解決する
  // （CLAUDE.md 禁止1: client 由来の tenantId を信用しない）。body にテナント項目は無い。
  app.put("/v1/admin/my-tenant/plan", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }

    const parsed = z.object({ plan: z.enum(planValues) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const nextPlan = parsed.data.plan;

    // super_admin の POST/PATCH と同じ一時ブロックを、テナント自己申告にも適用する。
    // ここを抜くと、#918 が塞いだ「free_ad テナントを増やさない」方針を
    // テナント側の導線が素通りする（CLAUDE.md 禁止14: UIだけの制限にしない）。
    // DBに触れる前(接続確立前)に弾く。
    if (blockFreeAdTransition(nextPlan, res)) return;
    // super_admin の POST/PATCH は enterprise を個別契約として受け付けるが、
    // テナント自己申告のこの経路だけは常に拒否する(この関数は POST/PATCH からは呼ばない)。
    if (blockEnterpriseSelfUpgrade(nextPlan, res)) return;

    const appMeta = su?.app_metadata as Record<string, unknown> | undefined;
    const changedBy: string = su?.email ?? (typeof appMeta?.email === "string" ? appMeta.email : "");

    // ★実処理は src/lib/billing/changeTenantPlan.ts に切り出してある(CP-3)★
    // BEGIN → SET LOCAL lock_timeout → SELECT...FOR UPDATE → no-op判定 →
    // features降格計算 → UPDATE → COMMIT → キャッシュ無効化 → 監査INSERT
    // (fire-and-forget) → Stripe同期(await) の手順はそちらを参照。
    // change_my_plan ツール(agent/actionExecutor.ts)も同じ関数を直接呼ぶ
    // (ロジックを2箇所に書き写さない。挙動は元実装と無変更)。
    const result = await changeTenantPlan(db, logger, tenantId, nextPlan, changedBy);
    return res.status(result.status).json(result.body);
  });

  // GET /v1/admin/my-tenant/upsell-suggestion — Client Admin専用: 自テナントの
  // 利用状況からアップセル訴求を返す(D8-2, MG-8)。
  //
  // ★原価が絶対に漏れない設計★
  // このハンドラは fetchTenantBillingSnapshot(全テナント横断の粗利分析が使う、
  // 原価入りのスナップショット)を呼ばない。呼ぶのは buildTenantUpsellFigures
  // (TenantUpsellFigures だけを組み立てる別関数)のみで、原価・マージン・粗利の
  // 値がこの経路のどこにも存在しない(型としても値としても)。
  //
  // レスポンスは renderUpsellForTenant() が返す構造化されていない文字列
  // (headline / lines)だけで、個別の数値フィールドを一切持たない。
  // フロント側でパースして再構成する必要が無く、「どのフィールドが
  // 原価由来か」をフロントが判断する余地自体が無い。
  app.get("/v1/admin/my-tenant/upsell-suggestion", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }

    try {
      const planRow = await db.query<{ plan: string | null }>(
        `SELECT plan FROM tenants WHERE id = $1`,
        [tenantId]
      );
      if (planRow.rowCount === 0) {
        return res.status(404).json({ error: "not_found" });
      }
      const currentPlan = planRow.rows[0]!.plan ?? "starter";

      const { monthStart, monthEnd } = getMonthRangeJst(new Date());
      const from = monthStart.toISOString();
      const to = monthEnd.toISOString();
      const { textUnits, avatarMinutes } = await computeExpectedBilling(db, tenantId, from, to, currentPlan);
      const signalResult = computeUpsellSignals({ plan: currentPlan, textUnits, avatarMinutes });

      if (signalResult.signals.length === 0 || !signalResult.nextPlanCandidate) {
        // ★訴求すること自体がないのを 200 + available:false で表現する★
        // 404/204 にすると「未取得」と「対象外」の区別がフロントで付かない。
        return res.json({ available: false });
      }

      // 複数シグナルが同時に立つことがある(例: 超過 + near_limit)。
      // 優先度: 実際に超過している方が「上限が近い」より訴求として強い。
      const priority: UpsellSignal[] = [
        "text_overage", "avatar_overage", "starter_cap_reached",
        "free_ad_limit_reached", "enterprise_nudge", "text_near_limit",
      ];
      const signal = priority.find((s) => signalResult.signals.includes(s)) ?? signalResult.signals[0]!;

      const figures = await buildTenantUpsellFigures(
        db, tenantId, signal, currentPlan, signalResult.nextPlanCandidate,
      );
      const rendered = renderUpsellForTenant(figures);
      return res.json({ available: true, headline: rendered.headline, lines: rendered.lines });
    } catch (err) {
      logger.warn("[GET /v1/admin/my-tenant/upsell-suggestion]", err);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // POST /v1/admin/my-tenant/keys — Client Admin専用: 自テナントのAPIキーを自力発行する。
  // super_admin向け POST /v1/admin/tenants/:id/keys と異なり、in-memory側は
  // registerTenant(既存キーを上書き)ではなく addTenantApiKey(既存キーを維持したまま追加)を
  // 使う。旧キーはclient_adminが明示的に失効させるまで有効のまま＝無停止ローテーション。
  app.post("/v1/admin/my-tenant/keys", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }
    try {
      const tenantCheck = await db.query("SELECT id, is_active FROM tenants WHERE id = $1", [tenantId]);
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      if (!tenantCheck.rows[0].is_active) {
        return res.status(403).json({ error: "tenant_disabled", message: "無効なテナントにはAPIキーを発行できません。" });
      }

      const expiresAtResult = validateExpiresAt(req.body?.expires_at);
      if ("error" in expiresAtResult) {
        return res.status(400).json({ error: expiresAtResult.error, message: expiresAtResult.message });
      }
      const expiresAt = expiresAtResult.expiresAt;

      const plainKey = generateApiKey();
      const keyHash = hashApiKey(plainKey);
      const keyPrefix = plainKey.slice(0, 12);

      const result = await db.query(
        `INSERT INTO tenant_api_keys (tenant_id, key_hash, key_prefix, is_active, expires_at)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id, tenant_id, key_prefix, is_active, created_at, expires_at`,
        [tenantId, keyHash, keyPrefix, expiresAt]
      );
      const row = result.rows[0];

      // 既存キー(主キー・追加キー問わず)を失効させず、新キーを追加で有効化する。
      // addTenantApiKey は tenantStore に既存エントリがある場合のみ true を返す
      // （DB-onlyテナント=in-memory未登録の場合は静かにスキップ。DBが正なので発行自体は成功扱い）。
      addTenantApiKey(tenantId, keyHash, expiresAt);

      // 平文キーはこのレスポンスでのみ返す（二度と取得不可）
      return res.status(201).json({
        api_key: plainKey,
        tenant_id: row.tenant_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        id: row.id,
      });
    } catch (err) {
      logger.warn("[POST /v1/admin/my-tenant/keys]", err);
      return res.status(500).json({ error: "APIキー発行に失敗しました" });
    }
  });

  // GET /v1/admin/my-tenant/keys — Client Admin専用: 自テナントのAPIキー一覧（マスク表示）
  app.get("/v1/admin/my-tenant/keys", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }
    try {
      const result = await db.query(
        `SELECT id, key_prefix, is_active, created_at, expires_at, last_used_at
         FROM tenant_api_keys
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId]
      );
      const keys = (result.rows as Array<{ id: string; key_prefix: string; is_active: boolean; created_at: string; expires_at: string | null; last_used_at: string | null }>).map((row) => ({
        ...row,
        prefix: maskApiKeyPrefix(row.key_prefix),
      }));
      return res.json({ keys, total: keys.length });
    } catch (err) {
      logger.warn("[GET /v1/admin/my-tenant/keys]", err);
      return res.status(500).json({ error: "APIキー一覧の取得に失敗しました" });
    }
  });

  // DELETE /v1/admin/my-tenant/keys/:keyId — Client Admin専用: 自テナントのAPIキーを失効する
  app.delete("/v1/admin/my-tenant/keys/:keyId", tenantAuth, requireAdminRole, async (req: Request, res: Response) => {
    const su = (req as AuthedReq).supabaseUser;
    const tenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      return res.status(403).json({ error: "forbidden", message: "テナントIDが見つかりません" });
    }
    const { keyId } = req.params;
    try {
      // tenant_id = $2 で自テナント以外のキーIDを指定されても404にする(越境防止)
      const result = await db.query(
        `UPDATE tenant_api_keys
         SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, is_active, key_hash`,
        [keyId, tenantId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "APIキーが見つかりません。" });
      }
      const revokedHash = result.rows[0].key_hash;
      // 主キー・追加キーのどちらでも失効させる（revokeTenantApiKey が両方を見る）
      revokeTenantApiKey(tenantId, revokedHash);
      return res.json({ ok: true, id: keyId, is_active: false });
    } catch (err) {
      logger.warn("[DELETE /v1/admin/my-tenant/keys/:keyId]", err);
      return res.status(500).json({ error: "APIキー無効化に失敗しました" });
    }
  });

  // GET /v1/admin/tenants
  app.get("/v1/admin/tenants", tenantAuth, requireSuperAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await db.query(
        `SELECT t.id, t.name, t.plan, t.is_active, t.allowed_origins, t.system_prompt,
                t.billing_enabled, t.billing_free_from, t.billing_free_until, t.features,
                t.conversion_types, t.created_at, t.updated_at,
                (SELECT COUNT(*)::int FROM tenant_api_keys k
                 WHERE k.tenant_id = t.id AND k.is_active) AS api_key_count
         FROM tenants t
         ORDER BY t.created_at DESC`
      );
      return res.json({ tenants: result.rows, total: result.rows.length });
    } catch (err) {
      logger.warn("[GET /v1/admin/tenants]", err);
      return res.status(500).json({ error: "一覧の取得に失敗しました" });
    }
  });

  // POST /v1/admin/tenants
  app.post("/v1/admin/tenants", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const parsed = createTenantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const { id, name, plan } = parsed.data;
    if (blockFreeAdTransition(plan, res)) return;
    try {
      const result = await db.query(
        `INSERT INTO tenants (id, name, plan, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING id, name, plan, is_active, created_at, updated_at`,
        [id, name, plan]
      );
      const tenant = result.rows[0];
      // in-memory storeにも同期（既存の認証フローとの互換性）
      registerTenant({
        tenantId: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        features: { avatar: false, voice: false, rag: true },
        security: {
          apiKeyHash: "",
          hashAlgorithm: "sha256",
          allowedOrigins: [],
          rateLimit: 100,
          rateLimitWindowMs: 60_000,
        },
        enabled: tenant.is_active,
      });

      // Phase44/50: デフォルト18体のアバターをバックグラウンドで作成
      (async () => {
        try {
          for (const avatar of DEFAULT_AVATARS) {
            const imageUrl = supabaseAdmin
              ? supabaseAdmin.storage.from("avatar-defaults").getPublicUrl(`${avatar.template_id}.png`).data?.publicUrl ?? null
              : null;

            await db.query(
              `INSERT INTO avatar_configs
                (tenant_id, name, image_url, personality_prompt, is_default,
                 default_template_id, default_name, default_personality_prompt,
                 default_voice_id, lemonslice_agent_id, agent_prompt, agent_idle_prompt,
                 is_active, avatar_provider)
               VALUES ($1, $2, $3, $4, true, $5, $6, $7, null, $8, $9, $10, false, 'lemonslice')
               ON CONFLICT (tenant_id, default_template_id) WHERE default_template_id IS NOT NULL DO NOTHING`,
              [
                tenant.id,
                avatar.name,
                imageUrl,
                avatar.personality_prompt,
                avatar.template_id,
                avatar.name,
                avatar.personality_prompt,
                avatar.lemonslice_agent_id,
                avatar.agent_prompt,
                avatar.agent_idle_prompt,
              ]
            );
          }
        } catch (seedErr) {
          logger.warn('[POST /v1/admin/tenants] デフォルトアバター生成エラー:', seedErr);
        }
      })();

      return res.status(201).json(tenant);
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ error: "conflict", message: "このIDのテナントはすでに存在します。" });
      }
      logger.warn("[POST /v1/admin/tenants]", err);
      return res.status(500).json({ error: "作成に失敗しました" });
    }
  });

  // GET /v1/admin/tenants/:id
  app.get("/v1/admin/tenants/:id", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await db.query(
        `SELECT id, name, plan, is_active, allowed_origins, excluded_page_patterns, system_prompt, billing_enabled, billing_free_from, billing_free_until, features, lemonslice_agent_id, conversion_types, faq_question_hint, faq_answer_hint, onboarding_industry, onboarding_widget_seen_at, widget_theme, created_at, updated_at FROM tenants WHERE id = $1`,
        [id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      const row = result.rows[0] as {
        onboarding_industry: string | null;
        onboarding_widget_seen_at: string | null;
        created_at: string;
      };
      // Asana 1217040568430944(P7): super_adminのクライアントビュー(previewMode)からも
      // オンボーディングの「次の一手」提示を使えるようにするため、my-tenant同様に
      // onboarding_stage を相乗りさせる(新規fetchは作らない)。
      const onboarding_stage = await fetchOnboardingStageStatus(
        db,
        id,
        row.created_at,
        row.onboarding_industry,
        row.onboarding_widget_seen_at
      );
      return res.json({ ...result.rows[0], onboarding_stage });
    } catch (err) {
      logger.warn("[GET /v1/admin/tenants/:id]", err);
      return res.status(500).json({ error: "取得に失敗しました" });
    }
  });

  // PATCH /v1/admin/tenants/:id
  app.patch("/v1/admin/tenants/:id", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsed = updateTenantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
    }
    if (blockFreeAdTransition(fields.plan, res)) return;
    try {
      // 存在チェック + Phase72-A: 変更前の監査対象フィールドを取得
      const check = await db.query("SELECT id, plan, features, billing_enabled, is_active FROM tenants WHERE id = $1", [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      const beforeRow = check.rows[0] as { plan: string; features: unknown; billing_enabled: boolean; is_active: boolean };
      // S5: 共有学習プールの参加モデル。free_ad(確実に判定できた場合のみ)は share 強制ON。
      // 同一リクエストで plan も変更される場合は変更後のプランで判定する
      // (例: free_ad → starter への降格と同時に share=false を送るのは正当な操作)。
      if (fields.features?.learning?.share === false) {
        const effectivePlan = fields.plan ?? beforeRow.plan;
        const knownPlan =
          effectivePlan === "free_ad" || effectivePlan === "starter" ||
          effectivePlan === "standard" || effectivePlan === "growth" ||
          effectivePlan === "enterprise"
            ? effectivePlan
            : null;
        const shareResolution = resolveShareForPlan(knownPlan);
        if (shareResolution.forced) {
          return res.status(403).json({
            error: "share_forced_by_plan",
            message: "広告プランでは共有プールへの参加が必須です。有料プランへの変更が必要です。",
          });
        }
      }
      // ★降格時は新プランで許されない features を落とす★
      // PUT /v1/admin/my-tenant/plan（テナント自己申告）は #933 でこの計算を
      // 実装したが、super_admin用のこのPATCHルートは plan を更新するだけで
      // features を一切見ていなかった(#933 が繰り返し警告していた「経路ごとに
      // 書き写すと新しい経路が素通りする」パターンをこの関数自身がやっていた)。
      // super_admin であってもプランを超えた権能付与はさせない方針
      // (planFeatures.ts 冒頭のバイパス境界コメント参照)なので、同一リクエストで
      // fields.features により明示的に再度trueへ戻そうとしても剥奪が勝つ
      // (下のjsonbマージで revoked を最後に適用する)。
      const revoked = fields.plan !== undefined
        ? computeFeatureRevocationOnDowngrade(beforeRow.features as Record<string, unknown> | null, fields.plan)
        : {};
      const hasRevocation = Object.keys(revoked).length > 0;

      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (fields.name !== undefined) { params.push(fields.name); setClauses.push(`name = $${params.length}`); }
      if (fields.plan !== undefined) { params.push(fields.plan); setClauses.push(`plan = $${params.length}`); }
      if (fields.is_active !== undefined) { params.push(fields.is_active); setClauses.push(`is_active = $${params.length}`); }
      if (fields.allowed_origins !== undefined) { params.push(fields.allowed_origins); setClauses.push(`allowed_origins = $${params.length}`); }
      if (fields.excluded_page_patterns !== undefined) { params.push(fields.excluded_page_patterns); setClauses.push(`excluded_page_patterns = $${params.length}`); }
      // Phase38 Step6: system_prompt の更新（空文字列による削除も許可）
      if (fields.system_prompt !== undefined) { params.push(fields.system_prompt); setClauses.push(`system_prompt = $${params.length}`); }
      // Phase39: 課金管理
      if (fields.billing_enabled !== undefined) { params.push(fields.billing_enabled); setClauses.push(`billing_enabled = $${params.length}`); }
      if ('billing_free_from' in fields) { params.push(fields.billing_free_from ?? null); setClauses.push(`billing_free_from = $${params.length}`); }
      if ('billing_free_until' in fields) { params.push(fields.billing_free_until ?? null); setClauses.push(`billing_free_until = $${params.length}`); }
      // Phase40: アバター機能フラグ。fields.features(管理者の明示指定) → revoked(降格による
      // 剥奪)の順で jsonb を || 連結する。Postgres の jsonb || は右側のキーが勝つため、
      // 同一キーを両方が触っていても剥奪が最終的に勝つ。
      if (fields.features !== undefined || hasRevocation) {
        const layers: string[] = [`COALESCE(features, '{}'::jsonb)`];
        if (fields.features !== undefined) {
          params.push(JSON.stringify(fields.features));
          layers.push(`$${params.length}::jsonb`);
        }
        if (hasRevocation) {
          params.push(JSON.stringify(revoked));
          layers.push(`$${params.length}::jsonb`);
        }
        setClauses.push(`features = ${layers.join(" || ")}`);
      }
      if ('lemonslice_agent_id' in fields) { params.push(fields.lemonslice_agent_id ?? null); setClauses.push(`lemonslice_agent_id = $${params.length}`); }
      if (fields.conversion_types !== undefined) { params.push(JSON.stringify(fields.conversion_types)); setClauses.push(`conversion_types = $${params.length}::jsonb`); }
      if ('tenant_contact_email' in fields) { params.push(fields.tenant_contact_email ?? null); setClauses.push(`tenant_contact_email = $${params.length}`); }
      if ('faq_question_hint' in fields) { params.push(fields.faq_question_hint ?? null); setClauses.push(`faq_question_hint = $${params.length}`); }
      if ('faq_answer_hint' in fields) { params.push(fields.faq_answer_hint ?? null); setClauses.push(`faq_answer_hint = $${params.length}`); }
      setClauses.push(`updated_at = NOW()`);
      params.push(id);
      const result = await db.query(
        `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = $${params.length} RETURNING id, name, plan, is_active, allowed_origins, excluded_page_patterns, system_prompt, billing_enabled, billing_free_from, billing_free_until, features, lemonslice_agent_id, conversion_types, tenant_contact_email, faq_question_hint, faq_answer_hint, created_at, updated_at`,
        params
      );
      // プラン判定のキャッシュは2系統ある（機能ゲート用・請求焼き付け用）。両方消す。
      // PUT /v1/admin/my-tenant/plan は #921 で無効化していたが、このPATCHルートは
      // plan 変更経路として先にあったにもかかわらず素通りしていた(features剥奪と
      // 同じ「新しい経路だけ直して既存経路を見落とす」パターン)。片方だけだと、
      // 機能は開いたのに請求だけ旧倍率、といったズレが最大60秒残る。
      if (fields.plan !== undefined) {
        invalidateTenantPlanCache(id);
        invalidateBillingPlanCache(id);
      }
      // in-memory store を即時同期 (is_active 変更が次リクエストから有効になる)
      if (fields.is_active !== undefined) {
        updateTenantEnabled(id, fields.is_active);
      }
      // allowed_origins も同様。未指定なら呼ばない（フィールド省略と空配列指定を区別する）。
      // これが無いとCORS許可ドメインの追加/削除がPM2再起動まで反映されなかった。
      if (fields.allowed_origins !== undefined) {
        updateTenantAllowedOrigins(id, fields.allowed_origins);
      }
      // Phase47-C: system_prompt 変更時は OpenClaw Workspace キャッシュを無効化
      if (fields.system_prompt !== undefined) {
        invalidateWorkspaceCache(id);
      }
      // Phase72-A: 監査対象フィールドの変更を tenant_settings_history に記録（fire-and-forget）
      const su72 = (req as import("../../middleware/roleAuth").AuthedReq).supabaseUser;
      const appMeta72 = su72?.app_metadata as Record<string, unknown> | undefined;
      const changedBy72: string = su72?.email ?? (typeof appMeta72?.email === "string" ? appMeta72.email : "");
      const afterRow = result.rows[0] as { plan: string; features: unknown; billing_enabled: boolean; is_active: boolean };
      const auditFields: Array<{ field: string; before: unknown; after: unknown }> = [
        { field: "plan",            before: beforeRow.plan,            after: afterRow.plan },
        { field: "features",        before: beforeRow.features,        after: afterRow.features },
        { field: "billing_enabled", before: beforeRow.billing_enabled, after: afterRow.billing_enabled },
        { field: "is_active",       before: beforeRow.is_active,       after: afterRow.is_active },
      ];
      void (async () => {
        for (const f of auditFields) {
          const beforeJson = JSON.stringify(f.before);
          const afterJson  = JSON.stringify(f.after);
          if (beforeJson !== afterJson) {
            await db.query(
              `INSERT INTO tenant_settings_history (tenant_id, changed_by, field_name, old_value, new_value)
               VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
              [id, changedBy72, f.field, beforeJson, afterJson]
            ).catch((e: unknown) => logger.warn("[tenant_settings_history] insert failed", e));
          }
        }
      })();
      // ★プラン変更時・停止状態変更時は Stripe の item 構成も追随させる★
      // PUT /v1/admin/my-tenant/plan と同じ理由・同じ関数を通す。経路ごとに
      // 書き写すと、片方だけ直したときに「super_admin が変えた分だけ請求が動かない」
      // という非対称が生まれる(このファイルが features 剥奪で一度やった失敗）。
      // プラン以外のフィールド更新(名前・allowed_origins 等)では Stripe を触らない。
      //
      // ★is_active の変化だけでも呼ぶ理由(2026-08-26 レビュー是正)★
      // 従来は plan 変更時にしか呼んでいなかったため、「停止(is_active:false)のみ」の
      // PATCHではStripe側の請求が止まらなかった。syncSubscriptionItemsToPlan は
      // ロック獲得後にDBから is_active を読み直して停止中なら期末解約を予約するため、
      // ここでは「plan か is_active のどちらかが変わったら呼ぶ」だけでよい
      // (実際に何をするかの判断は同期処理側のDB再読込に委ねる)。
      let planBillingSync: SubscriptionSyncResult | null = null;
      const planChanged = fields.plan !== undefined && fields.plan !== beforeRow.plan;
      const activeChanged = fields.is_active !== undefined && fields.is_active !== beforeRow.is_active;
      if (planChanged || activeChanged) {
        planBillingSync = await syncSubscriptionForTenant(db, logger, id, afterRow.plan);
        if (needsBillingAttention(planBillingSync)) {
          logger.warn(
            { tenantId: id, plan: afterRow.plan, isActive: afterRow.is_active, billingSyncStatus: planBillingSync.status },
            "[PATCH /v1/admin/tenants/:id] プランは変更したが請求構成が追随していない"
          );
        }
      }
      return res.json(
        planBillingSync
          ? {
              ...result.rows[0],
              billing_sync: planBillingSync.status,
              billing_sync_needs_attention: needsBillingAttention(planBillingSync),
            }
          : result.rows[0]
      );
    } catch (err) {
      logger.warn("[PATCH /v1/admin/tenants/:id]", err);
      return res.status(500).json({ error: "更新に失敗しました" });
    }
  });

  // POST /v1/admin/tenants/:id/kill-switch — テナント即時無効化 (SLA: 1分以内)
  app.post("/v1/admin/tenants/:id/kill-switch", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const activatedAt = Date.now();
    try {
      const check = await db.query("SELECT id, is_active FROM tenants WHERE id = $1", [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      // DB を即時無効化
      await db.query("UPDATE tenants SET is_active = false, updated_at = NOW() WHERE id = $1", [id]);
      // in-memory store も即時反映 (PM2 再起動不要)
      const inMemoryUpdated = updateTenantEnabled(id, false);
      const latencyMs = Date.now() - activatedAt;
      logger.warn({ tenantId: id, latencyMs, inMemoryUpdated }, "kill_switch_activated");
      return res.json({
        ok: true,
        tenantId: id,
        activated_at: new Date(activatedAt).toISOString(),
        latency_ms: latencyMs,
        in_memory_updated: inMemoryUpdated,
      });
    } catch (err) {
      logger.warn("[POST /v1/admin/tenants/:id/kill-switch]", err);
      return res.status(500).json({ error: "kill-switch の実行に失敗しました" });
    }
  });

  // POST /v1/admin/tenants/:id/purge-chat-data — テナント退会時の会話データ消去(Super Admin専用)
  //
  // 会話データの一括消去は取り返しがつかないため、既定は「予約 → 猶予期間後にバッチ消去」。
  // Body:
  //   { mode: "schedule", reason }              → 消去を予約(chat_data_purge_requested_at=NOW)
  //   { mode: "cancel" }                        → 予約を解除
  //   { mode: "immediate", confirm: <id>, reason } → 即時全消去(confirm がテナントIDと一致必須)
  app.post("/v1/admin/tenants/:id/purge-chat-data", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const su = (req as AuthedReq).supabaseUser as Record<string, any> | undefined;
    const actorRole = (su?.app_metadata?.role as string | undefined) ?? "super_admin";
    const actorEmail = (su?.["email"] as string | undefined) ?? (su?.app_metadata?.email as string | undefined) ?? "";

    const bodySchema = z.object({
      mode: z.enum(["schedule", "cancel", "immediate"]),
      reason: z.string().trim().min(5).max(500).optional(),
      confirm: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const { mode, reason, confirm } = parsed.data;

    try {
      const check = await db.query("SELECT id FROM tenants WHERE id = $1", [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }

      if (mode === "cancel") {
        await db.query(
          "UPDATE tenants SET chat_data_purge_requested_at = NULL, updated_at = NOW() WHERE id = $1",
          [id],
        );
        await db.query(
          `INSERT INTO audit_logs (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
           VALUES ($1, 'tenant_chat_data_purge_cancel', $2, $3, 'tenant', $1, '{}'::jsonb)`,
          [id, actorRole, actorEmail],
        );
        return res.json({ ok: true, tenantId: id, mode, chat_data_purge_requested_at: null });
      }

      // schedule / immediate は reason 必須
      if (!reason) {
        return res.status(400).json({ error: "reason は5文字以上500文字以下の文字列が必要です" });
      }

      if (mode === "schedule") {
        const upd = await db.query<{ chat_data_purge_requested_at: string }>(
          "UPDATE tenants SET chat_data_purge_requested_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING chat_data_purge_requested_at",
          [id],
        );
        await db.query(
          `INSERT INTO audit_logs (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
           VALUES ($1, 'tenant_chat_data_purge_schedule', $2, $3, 'tenant', $1, $4)`,
          [id, actorRole, actorEmail, JSON.stringify({ reason })],
        );
        return res.json({
          ok: true,
          tenantId: id,
          mode,
          chat_data_purge_requested_at: upd.rows[0]?.chat_data_purge_requested_at ?? null,
        });
      }

      // mode === "immediate": 事故防止に confirm がテナントIDと完全一致すること
      if (confirm !== id) {
        return res.status(400).json({
          error: "confirm_mismatch",
          message: "即時消去には confirm にテナントIDを指定してください。",
        });
      }
      const result = await purgeTenantChatData({
        tenantId: id,
        actorRole,
        actorEmail,
        reason,
      });
      return res.json({ ok: true, tenantId: id, mode, purged: result });
    } catch (err) {
      logger.warn("[POST /v1/admin/tenants/:id/purge-chat-data]", err);
      return res.status(500).json({ error: "会話データ消去に失敗しました" });
    }
  });

  // POST /v1/admin/tenants/:id/keys — APIキー発行
  app.post("/v1/admin/tenants/:id/keys", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      // テナント存在チェック（in-memory登録を上書きする際に allowedOrigins/features を保持するため取得）
      const tenantCheck = await db.query(
        "SELECT id, name, plan, is_active, features, allowed_origins FROM tenants WHERE id = $1",
        [id]
      );
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      if (!tenantCheck.rows[0].is_active) {
        return res.status(403).json({ error: "tenant_disabled", message: "無効なテナントにはAPIキーを発行できません。" });
      }

      // expires_at (オプション: body.expires_at)
      const expiresAtResult = validateExpiresAt(req.body?.expires_at);
      if ("error" in expiresAtResult) {
        return res.status(400).json({ error: expiresAtResult.error, message: expiresAtResult.message });
      }
      const expiresAt = expiresAtResult.expiresAt;

      const plainKey = generateApiKey();
      const keyHash = hashApiKey(plainKey);
      const keyPrefix = plainKey.slice(0, 12); // "rjc_" + 8文字

      const result = await db.query(
        `INSERT INTO tenant_api_keys (tenant_id, key_hash, key_prefix, is_active, expires_at)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id, tenant_id, key_prefix, is_active, created_at, expires_at`,
        [id, keyHash, keyPrefix, expiresAt]
      );
      const row = result.rows[0];

      // 意味論: このエンドポイントはキーを「追加」する（既存キーは失効しない）。
      // DBのINSERT・UIのキー一覧(個別に失効ボタンを持つ)・client_admin側の
      // POST /my-tenant/keys がいずれも追加型であり、in-memory だけが
      // registerTenant による「上書き」だったため、旧キーが
      // DB上は is_active=true のまま in-memory から消えて 401 になっていた。
      const tenantRow = tenantCheck.rows[0];
      if (!addTenantApiKey(tenantRow.id, keyHash, expiresAt)) {
        // in-memory 未登録(DB-onlyテナント)の場合のみ、新キーを主キーとして登録する。
        // allowedOrigins/features は固定値で潰さず、DB上の現行値を引き継ぐ。
        registerTenant({
          tenantId: tenantRow.id,
          name: tenantRow.name || tenantRow.id,
          plan: tenantRow.plan || "starter",
          features: (tenantRow.features as { avatar: boolean; voice: boolean; rag: boolean }) ?? { avatar: false, voice: false, rag: true },
          security: {
            apiKeyHash: keyHash,
            hashAlgorithm: "sha256",
            allowedOrigins: tenantRow.allowed_origins ?? [],
            rateLimit: 100,
            rateLimitWindowMs: 60_000,
          },
          enabled: true,
        });
        setTenantApiKeyExpiry(tenantRow.id, expiresAt);
      }

      // 平文キーはこのレスポンスでのみ返す（二度と取得不可）
      return res.status(201).json({
        api_key: plainKey,
        tenant_id: row.tenant_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        id: row.id,
      });
    } catch (err) {
      logger.warn("[POST /v1/admin/tenants/:id/keys]", err);
      return res.status(500).json({ error: "APIキー発行に失敗しました" });
    }
  });

  // GET /v1/admin/tenants/:id/keys — APIキー一覧（マスク表示）
  app.get("/v1/admin/tenants/:id/keys", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const tenantCheck = await db.query("SELECT id FROM tenants WHERE id = $1", [id]);
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      const result = await db.query(
        `SELECT id, key_prefix, is_active, created_at, expires_at, last_used_at
         FROM tenant_api_keys
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [id]
      );
      const keys = (result.rows as Array<{ id: string; key_prefix: string; is_active: boolean; created_at: string; expires_at: string | null; last_used_at: string | null }>).map((row) => ({
        ...row,
        prefix: maskApiKeyPrefix(row.key_prefix),
      }));
      return res.json({ keys, total: keys.length });
    } catch (err) {
      logger.warn("[GET /v1/admin/tenants/:id/keys]", err);
      return res.status(500).json({ error: "APIキー一覧の取得に失敗しました" });
    }
  });

  // DELETE /v1/admin/tenants/:id/keys/:keyId — APIキー無効化（論理削除）
  app.delete("/v1/admin/tenants/:id/keys/:keyId", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id, keyId } = req.params;
    try {
      const result = await db.query(
        `UPDATE tenant_api_keys
         SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, is_active, key_hash`,
        [keyId, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "APIキーが見つかりません。" });
      }
      // 失効させたキーを in-memory からも即時に落とす。主キーだけでなく
      // client_admin が無停止ローテーションで追加したキーも対象にする
      // （以前は主キーのみを見ており、追加キーがDB上inactiveでも認証が通り続けていた）。
      revokeTenantApiKey(id, result.rows[0].key_hash);
      return res.json({ ok: true, id: keyId, is_active: false });
    } catch (err) {
      logger.warn("[DELETE /v1/admin/tenants/:id/keys/:keyId]", err);
      return res.status(500).json({ error: "APIキー無効化に失敗しました" });
    }
  });

  // POST /v1/admin/tenants/:id/invite — client_adminユーザー招待（Super Admin専用）
  app.post("/v1/admin/tenants/:id/invite", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;

    const schema = z.object({
      email: z.string().email("有効なメールアドレスを入力してください"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const { email } = parsed.data;

    // テナント存在チェック
    try {
      const tenantCheck = await db.query("SELECT id, name, is_active FROM tenants WHERE id = $1", [id]);
      if (tenantCheck.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      if (!tenantCheck.rows[0].is_active) {
        return res.status(403).json({ error: "tenant_disabled", message: "無効なテナントにはユーザーを招待できません。" });
      }
    } catch (err) {
      logger.warn("[POST /v1/admin/tenants/:id/invite] tenant check failed", err);
      return res.status(500).json({ error: "テナント確認に失敗しました" });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ error: "service_unavailable", message: "Supabase Adminクライアントが設定されていません。" });
    }

    try {
      // ユーザーを招待（メール送信）
      //
      // ★redirectTo を明示する理由★
      // 省略すると着地先が Supabase ダッシュボードの Site URL 設定に依存し、
      // コード側からは何も保証できない(設定変更に無言で追随してしまう)。
      // 招待された人は初回にここでパスワードを自分で設定するため、着地に失敗すると
      // ログインする手段が無い。Login.tsx の resetPasswordForEmail が使う
      // `${origin}/reset-password` と同じ着地先へ明示的に送る。
      const adminUiUrl = (process.env.ADMIN_UI_URL || "https://admin.r2c.biz").replace(/\/$/, "");
      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        email,
        {
          data: { role: "client_admin", tenant_id: id },
          redirectTo: `${adminUiUrl}/reset-password`,
        }
      );

      if (inviteError) {
        logger.warn("[POST /v1/admin/tenants/:id/invite] invite error", inviteError);
        return res.status(400).json({
          error: "invite_failed",
          message: inviteError.message || "招待メールの送信に失敗しました。",
        });
      }

      const userId = inviteData.user?.id;
      if (!userId) {
        return res.status(500).json({ error: "invite_failed", message: "ユーザーIDの取得に失敗しました。" });
      }

      // app_metadata に role と tenant_id を設定
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        app_metadata: { role: "client_admin", tenant_id: id },
      });

      if (updateError) {
        logger.warn("[POST /v1/admin/tenants/:id/invite] app_metadata update error", updateError);
        // 招待は成功しているが app_metadata の更新に失敗した場合も通知
        return res.status(500).json({
          error: "metadata_update_failed",
          message: "招待メールは送信しましたが、ロール設定に失敗しました。手動で設定してください。",
        });
      }

      return res.status(201).json({
        ok: true,
        userId,
        email,
        tenantId: id,
        role: "client_admin",
      });
    } catch (err) {
      logger.warn("[POST /v1/admin/tenants/:id/invite]", err);
      return res.status(500).json({ error: "招待処理に失敗しました" });
    }
  });

  // Phase72-A: GET /v1/admin/tenants/:id/settings-history — 設定変更履歴（super_admin のみ）
  app.get("/v1/admin/tenants/:id/settings-history", tenantAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const rawLimit  = parseInt(String(req.query.limit  ?? "20"), 10);
    const rawOffset = parseInt(String(req.query.offset ?? "0"),  10);
    const fieldName = typeof req.query.field_name === "string" ? req.query.field_name : undefined;

    const limit  = Number.isNaN(rawLimit)  ? 20 : Math.min(Math.max(rawLimit, 1), 100);
    const offset = Number.isNaN(rawOffset) ? 0  : Math.max(rawOffset, 0);

    try {
      const whereClauses = ["tenant_id = $1"];
      const params: unknown[] = [id];
      if (fieldName) {
        params.push(fieldName);
        whereClauses.push(`field_name = $${params.length}`);
      }
      const whereStr = whereClauses.join(" AND ");

      const [dataResult, countResult] = await Promise.all([
        db.query(
          `SELECT id, tenant_id, changed_by, field_name, old_value, new_value, changed_at
           FROM tenant_settings_history
           WHERE ${whereStr}
           ORDER BY changed_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        db.query(
          `SELECT COUNT(*)::int AS total FROM tenant_settings_history WHERE ${whereStr}`,
          params
        ),
      ]);

      return res.json({
        history: dataResult.rows,
        total: (countResult.rows[0] as { total: number }).total,
      });
    } catch (err) {
      logger.warn("[GET /v1/admin/tenants/:id/settings-history]", err);
      return res.status(500).json({ error: "履歴の取得に失敗しました" });
    }
  });

  logger.info("[tenantAdminRoutes] /v1/admin/tenants routes registered");
}
