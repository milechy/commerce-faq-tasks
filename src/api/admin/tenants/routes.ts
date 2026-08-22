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
import { planHasFeature, type TenantPlan } from "../../../lib/billing/planFeatures";
import { deriveOnboardingStage, type OnboardingStageStatus } from "../agent/onboardingStage";
import { isValidOriginPattern } from "../../middleware/originCheck";

const planValues = ["starter", "growth", "enterprise"] as const;

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
});

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  plan: z.enum(planValues).optional(),
  is_active: z.boolean().optional(),
  allowed_origins: allowedOriginsSchema,
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
        `SELECT id, name, plan, features, lemonslice_agent_id, conversion_types, faq_question_hint, faq_answer_hint, onboarding_industry, onboarding_completed_at, onboarding_widget_seen_at, widget_theme, created_at FROM tenants WHERE id = $1`,
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
    });
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
    }
    // GID: LP料金表(Growth〜: AIアバター)に基づくプラン制限。
    // avatar/voiceをtrueにするにはGrowth以上のプランが必要（UIの非表示に加えAPI側でも防御）。
    if (fields.features?.avatar === true || fields.features?.voice === true) {
      const planResult = await db.query<{ plan: TenantPlan | null }>(
        `SELECT plan FROM tenants WHERE id = $1`,
        [tenantId]
      );
      if (!planHasFeature(planResult.rows[0]?.plan, "avatar")) {
        return res.status(403).json({
          error: "plan_upgrade_required",
          message: "AIアバター機能はGrowthプラン以上でご利用いただけます",
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
      setClauses.push(`updated_at = NOW()`);
      params.push(tenantId);
      const result = await db.query(
        `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = $${params.length}
         RETURNING id, name, features, lemonslice_agent_id, faq_question_hint, faq_answer_hint, onboarding_industry, onboarding_completed_at, allowed_origins`,
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
      return res.json(result.rows[0]);
    } catch (err) {
      logger.warn("[PATCH /v1/admin/my-tenant]", err);
      return res.status(500).json({ error: "更新に失敗しました" });
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
        `SELECT id, name, plan, is_active, allowed_origins, system_prompt, billing_enabled, billing_free_from, billing_free_until, features, conversion_types, created_at, updated_at FROM tenants ORDER BY created_at DESC`
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
        `SELECT id, name, plan, is_active, allowed_origins, system_prompt, billing_enabled, billing_free_from, billing_free_until, features, lemonslice_agent_id, conversion_types, faq_question_hint, faq_answer_hint, onboarding_industry, onboarding_widget_seen_at, widget_theme, created_at, updated_at FROM tenants WHERE id = $1`,
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
    try {
      // 存在チェック + Phase72-A: 変更前の監査対象フィールドを取得
      const check = await db.query("SELECT id, plan, features, billing_enabled, is_active FROM tenants WHERE id = $1", [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
      }
      const beforeRow = check.rows[0] as { plan: string; features: unknown; billing_enabled: boolean; is_active: boolean };
      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (fields.name !== undefined) { params.push(fields.name); setClauses.push(`name = $${params.length}`); }
      if (fields.plan !== undefined) { params.push(fields.plan); setClauses.push(`plan = $${params.length}`); }
      if (fields.is_active !== undefined) { params.push(fields.is_active); setClauses.push(`is_active = $${params.length}`); }
      if (fields.allowed_origins !== undefined) { params.push(fields.allowed_origins); setClauses.push(`allowed_origins = $${params.length}`); }
      // Phase38 Step6: system_prompt の更新（空文字列による削除も許可）
      if (fields.system_prompt !== undefined) { params.push(fields.system_prompt); setClauses.push(`system_prompt = $${params.length}`); }
      // Phase39: 課金管理
      if (fields.billing_enabled !== undefined) { params.push(fields.billing_enabled); setClauses.push(`billing_enabled = $${params.length}`); }
      if ('billing_free_from' in fields) { params.push(fields.billing_free_from ?? null); setClauses.push(`billing_free_from = $${params.length}`); }
      if ('billing_free_until' in fields) { params.push(fields.billing_free_until ?? null); setClauses.push(`billing_free_until = $${params.length}`); }
      // Phase40: アバター機能フラグ
      if (fields.features !== undefined) { params.push(JSON.stringify(fields.features)); setClauses.push(`features = COALESCE(features, '{}'::jsonb) || $${params.length}::jsonb`); }
      if ('lemonslice_agent_id' in fields) { params.push(fields.lemonslice_agent_id ?? null); setClauses.push(`lemonslice_agent_id = $${params.length}`); }
      if (fields.conversion_types !== undefined) { params.push(JSON.stringify(fields.conversion_types)); setClauses.push(`conversion_types = $${params.length}::jsonb`); }
      if ('tenant_contact_email' in fields) { params.push(fields.tenant_contact_email ?? null); setClauses.push(`tenant_contact_email = $${params.length}`); }
      if ('faq_question_hint' in fields) { params.push(fields.faq_question_hint ?? null); setClauses.push(`faq_question_hint = $${params.length}`); }
      if ('faq_answer_hint' in fields) { params.push(fields.faq_answer_hint ?? null); setClauses.push(`faq_answer_hint = $${params.length}`); }
      setClauses.push(`updated_at = NOW()`);
      params.push(id);
      const result = await db.query(
        `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = $${params.length} RETURNING id, name, plan, is_active, allowed_origins, system_prompt, billing_enabled, billing_free_from, billing_free_until, features, lemonslice_agent_id, conversion_types, tenant_contact_email, faq_question_hint, faq_answer_hint, created_at, updated_at`,
        params
      );
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
      return res.json(result.rows[0]);
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
      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        email,
        { data: { role: "client_admin", tenant_id: id } }
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
