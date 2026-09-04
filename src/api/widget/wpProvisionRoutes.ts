// src/api/widget/wpProvisionRoutes.ts
//
// WordPress プラグインのセルフサインアップ(WP-1/WP-2/WP-3)。
// 「申告 → サイト所有証明 → テナント発行」の一連を、既存の各層(純関数・
// repository・SSRFガード付き検証)を組み立てるだけで実装する。
//
// ★設定の真実はこの経路にない(D9)★
// 位置・除外ページ・許可ドメインの読み書きは wpProvisionRoutes.ts の
// 責務ではない(WP-13で別途実装する GET/PATCH /v1/public/wp/settings が担う)。
// ここで作るのはテナントの「発行」までであり、以後の設定変更はここを経由しない。
//
// ★メール到達確認はブロッカーではない(D12)★
// サイト所有証明が通った時点で発行する。メールは
// supabaseAdmin.auth.admin.inviteUserByEmail による client_admin 招待として
// 送り、R2C App(CopilotUI)への導線として機能させる。招待の成否はテナント
// 発行の成否と独立させる(招待メール送信に失敗してもテナントは使える状態にする)。

import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import crypto from "node:crypto";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { createRateLimitMiddleware } from "../../lib/rate-limit";
import { getDayStartJst } from "../../lib/date/jstOffset";
import { normalizeWpSiteUrl, buildWpTenantId } from "./wpSiteUrl";
import {
  generateWpChallenge,
  generateWpPollToken,
  hashWpSecret,
  isWpSecretExpired,
  WP_CHALLENGE_TTL_MINUTES,
  WP_PROVISION_TTL_HOURS,
} from "./wpProvisionToken";
import { verifyWpSiteChallenge, WP_VERIFY_PATH } from "./wpSiteVerifier";
import {
  createWpProvisioning,
  findWpProvisioningByPollTokenHash,
  findProvisionedWpProvisioningBySiteOrigin,
  markWpProvisioningSiteVerified,
  markWpProvisioningProvisioned,
  expireStaleWpProvisionings,
  countProvisionedWpTenants,
  countWpProvisioningsCreatedSince,
  getWpProvisioningChallengeHashForVerification,
  type WpProvisioningRow,
} from "./wpProvisionRepository";
import {
  isFreeAdTenantCapReached,
  isFreeAdDailyProvisionCapReached,
} from "../../lib/billing/planQuota";
import { generateApiKey, hashApiKey } from "../admin/tenants/apiKeyUtils";
import { registerTenant } from "../../lib/tenant-context";

// ---------------------------------------------------------------------------
// レート制限
//
// このファイルの3ルートはすべて未認証(pre-auth)なので、tenantId ベースの
// 段は存在せず ip 段のみを掛ける(CLAUDE.md 禁止28)。index.ts の apiStack が
// 持つ ipRateLimiter とは別インスタンスだが、rate-limit.ts の store は
// モジュール単位のため同じ ip:xxx バケットを共有する(意図的: チャットからの
// floodと合算されるのは適切な多層防御)。ここではその共有バケットに加えて、
// プロビジョニング固有の低い上限を getLimit で明示する — 既定の100req/分は
// サイト所有証明の申告には緩すぎる。
// ---------------------------------------------------------------------------
const WP_PROVISION_IP_LIMIT = 20;

// createRateLimitMiddleware の logger オプションは生 pino.Logger を要求する
// (src/index.ts が渡す pino() インスタンスと同じ型)。src/lib/logger.ts の
// AppLogger はラッパーで型が合わないため、ここでは渡さない
// (rate-limit.ts 側の logger は省略可能で、渡さなくても動作は変わらない)。
const wpRateLimiter = createRateLimitMiddleware({
  stage: "ip",
  getLimit: () => WP_PROVISION_IP_LIMIT,
});

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------
const provisionRequestSchema = z.object({
  site_url: z.string().min(1).max(2000),
  email: z.string().email().max(320),
  // FR-03 の範囲。投稿内容・ユーザー情報・アクセスログは受け取らない。
  site_name: z.string().max(200).optional(),
  wp_version: z.string().max(50).optional(),
  plugin_version: z.string().max(50).optional(),
  locale: z.string().max(35).optional(),
});

/** normalizeWpSiteUrl() の失敗理由を、利用者に伝わるエラーコードへ変換する。 */
function siteUrlRejectionResponse(reason: string): { error: string; message: string } {
  switch (reason) {
    case "not_https":
      return { error: "site_url_not_https", message: "サイトURLは https:// で始まる必要があります。" };
    case "not_public_host":
      return {
        error: "site_url_not_public",
        message: "外部から到達できる公開URLを指定してください（localhost・内部IPは指定できません）。",
      };
    case "rejected_pattern":
      return { error: "site_url_rejected", message: "このサイトURLの形式は登録できません。" };
    default:
      return { error: "invalid_site_url", message: "サイトURLの形式が正しくありません。" };
  }
}

// ---------------------------------------------------------------------------
// GET レスポンス組み立て
// ---------------------------------------------------------------------------
type PollResponseBody =
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "failed"; reason: string | null }
  | { status: "provisioned"; tenantId: string; apiKey?: string }
  | { status: "pending"; waitReason?: "capacity_reached" | "daily_limit_reached"; verifyReason?: string };

/**
 * サイト所有証明〜発行までの本体。GET ポーリングから呼ぶ。
 *
 * ★DB へ触れる箇所を1つに集約する★
 * 検証(safeFetch)はトランザクション外で行う(外部HTTP呼び出しをDBロック中に
 * 抱えると、相手サイトの応答が遅いだけでロックが長時間残る)。
 * テナント発行はトランザクション内(BEGIN〜COMMIT)で行う——
 * src/lib/billing/changeTenantPlan.ts と同じ「SELECT...FOR UPDATE→計算→
 * 更新」の手順を踏襲する(同一 provisioning row への並行ポーリングでも
 * 二重発行が起きないようにするため)。
 */
async function advanceWpProvisioning(
  pool: Pool,
  row: WpProvisioningRow
): Promise<PollResponseBody> {
  if (row.status === "pending") {
    const challengeHash = await getWpProvisioningChallengeHashForVerification(pool, row.id);
    if (challengeHash === null) {
      // 直前の呼び出しの間に状態が進んだ(別ポーリングとの競合)。再取得して
      // 続きを判断する側の責務にする——ここでは「まだ確認中」を返すだけでよい。
      return { status: "pending" };
    }
    const verified = await verifyWpSiteChallenge(row.site_origin, challengeHash);
    if (!verified.ok) {
      return { status: "pending", verifyReason: verified.reason };
    }
    const marked = await markWpProvisioningSiteVerified(pool, row.id);
    if (!marked) {
      // 競合(他のポーリングが先に進めた)。次のポーリングで再評価される。
      return { status: "pending" };
    }
  } else if (row.status !== "site_verified") {
    // provisioned/expired/failed はここに来る前に呼び出し側で分岐済み。
    return { status: "pending" };
  }

  return completeWpProvisioning(pool, row.id);
}

/**
 * site_verified の行を、トランザクション内でテナント発行まで進める。
 * 総量ガード(D7)に引っかかった場合はロールバックし、行を pending 相当のまま
 * 残す(エラーにしない。次のポーリングで再試行される「順番待ち」)。
 */
async function completeWpProvisioning(pool: Pool, provisioningId: string): Promise<PollResponseBody> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");

    const locked = await client.query<{
      status: WpProvisioningRow["status"];
      site_origin: string;
      site_name: string | null;
      tenant_id: string | null;
    }>(
      `SELECT status, site_origin, site_name, tenant_id FROM wp_provisionings WHERE id = $1 FOR UPDATE`,
      [provisioningId]
    );
    if (locked.rowCount === 0) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }
    const row = locked.rows[0];

    if (row.status === "provisioned") {
      await client.query("ROLLBACK");
      return { status: "provisioned", tenantId: row.tenant_id as string };
    }
    if (row.status !== "site_verified") {
      await client.query("ROLLBACK");
      return { status: "pending" };
    }

    // ★同一originの確定行が既にある場合は新規発行しない★(要件書 X-3 / I-3 / I-4)。
    // 部分ユニークインデックス(uq_wp_provisionings_provisioned_site)が最終防衛だが、
    // ここで先に検出できれば例外を投げずに済む。
    const existing = await findProvisionedWpProvisioningBySiteOrigin(client, row.site_origin);
    if (existing) {
      await client.query("ROLLBACK");
      return { status: "provisioned", tenantId: existing.tenant_id as string };
    }

    const activeCount = await countProvisionedWpTenants(client);
    if (isFreeAdTenantCapReached(activeCount)) {
      await client.query("ROLLBACK");
      logger.warn({ activeCount }, "[wp-provision] tenant cap reached, deferring");
      return { status: "pending", waitReason: "capacity_reached" };
    }
    const todayCount = await countWpProvisioningsCreatedSince(client, getDayStartJst(new Date()));
    if (isFreeAdDailyProvisionCapReached(todayCount)) {
      await client.query("ROLLBACK");
      logger.warn({ todayCount }, "[wp-provision] daily cap reached, deferring");
      return { status: "pending", waitReason: "daily_limit_reached" };
    }

    const tenantId = buildWpTenantId(row.site_origin, crypto.randomBytes(4).toString("hex"));
    const tenantName = (row.site_name ?? "").trim() || tenantId;

    await client.query(
      `INSERT INTO tenants (id, name, plan, is_active, allowed_origins)
       VALUES ($1, $2, 'free_ad', true, $3)`,
      [tenantId, tenantName, [row.site_origin]]
    );

    const plainKey = generateApiKey();
    const keyHash = hashApiKey(plainKey);
    const keyPrefix = plainKey.slice(0, 12);
    await client.query(
      `INSERT INTO tenant_api_keys (tenant_id, key_hash, key_prefix, is_active)
       VALUES ($1, $2, $3, true)`,
      [tenantId, keyHash, keyPrefix]
    );

    const marked = await markWpProvisioningProvisioned(client, provisioningId, tenantId);
    if (!marked) {
      // FOR UPDATE で行をロックした直後の UPDATE が失敗するのは理論上
      // 起こらない(同一トランザクション内に他の書き手が入れないため)。
      // fail-safe としてロールバックし、原因をログに残す。
      await client.query("ROLLBACK");
      throw new Error(
        `[wp-provision] markWpProvisioningProvisioned failed after FOR UPDATE lock (id=${provisioningId})`
      );
    }

    await client.query("COMMIT");

    // in-memory ストアへの同期は POST /v1/admin/tenants と同じ理由
    // (既存の認証フローとの互換性)。★apiKeyHash は必ず実際のハッシュを渡す★
    // 空文字を渡すと getTenantByApiKeyHash の `cfg.security.apiKeyHash && ...`
    // が常に false になり、発行した鍵が永久に /api/chat を通らない。
    registerTenant({
      tenantId,
      name: tenantName,
      plan: "free_ad",
      features: { avatar: false, voice: false, rag: true },
      security: {
        apiKeyHash: keyHash,
        hashAlgorithm: "sha256",
        allowedOrigins: [row.site_origin],
        rateLimit: 100,
        rateLimitWindowMs: 60_000,
      },
      enabled: true,
    });

    return { status: "provisioned", tenantId, apiKey: plainKey };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function registerWpProvisionRoutes(app: Express, db: Pool | null): void {
  function requireDb(_req: Request, res: Response, next: NextFunction): void {
    if (!db) {
      res.status(503).json({ error: "service_unavailable", message: "現在この機能は利用できません。" });
      return;
    }
    next();
  }

  // -------------------------------------------------------------------------
  // POST /v1/public/wp/provision
  // -------------------------------------------------------------------------
  app.post(
    "/v1/public/wp/provision",
    wpRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      const parsed = provisionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
        return;
      }

      const normalized = normalizeWpSiteUrl(parsed.data.site_url);
      if (!normalized.ok) {
        res.status(400).json(siteUrlRejectionResponse(normalized.reason));
        return;
      }
      const origin = normalized.origin;

      try {
        // ★同一ドメインで既にテナントがある場合は新規作成しない★(要件書 X-3)。
        // 新規作成せず、手動キー貼り付け(FR-05)へ誘導する。tenantId は返さない
        // (未認証の申告者にテナントの存在有無以上の情報を渡さない)。
        const existing = await findProvisionedWpProvisioningBySiteOrigin(db as Pool, origin);
        if (existing) {
          res.status(409).json({
            error: "already_connected",
            message:
              "このサイトは既に接続済みです。設定を変更する場合は、発行済みのAPIキーをプラグイン設定画面に貼り付けてください。",
          });
          return;
        }

        const challenge = generateWpChallenge();
        const pollToken = generateWpPollToken();

        await createWpProvisioning(db as Pool, {
          siteOrigin: origin,
          email: parsed.data.email,
          challengeHash: hashWpSecret(challenge),
          pollTokenHash: hashWpSecret(pollToken),
          siteName: parsed.data.site_name,
          wpVersion: parsed.data.wp_version,
          pluginVersion: parsed.data.plugin_version,
          locale: parsed.data.locale,
        });

        res.status(201).json({
          challenge,
          poll_token: pollToken,
          verify_path: WP_VERIFY_PATH,
          challenge_expires_in_minutes: WP_CHALLENGE_TTL_MINUTES,
          provisioning_expires_in_hours: WP_PROVISION_TTL_HOURS,
        });
      } catch (err) {
        logger.warn({ err }, "[POST /v1/public/wp/provision]");
        res.status(500).json({ error: "provision_failed", message: "申告の処理に失敗しました。" });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /v1/public/wp/provision/:token
  // -------------------------------------------------------------------------
  app.get(
    "/v1/public/wp/provision/:token",
    wpRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      const token = req.params.token;
      if (typeof token !== "string" || token.length === 0 || token.length > 200) {
        res.status(404).json({ status: "not_found" });
        return;
      }

      try {
        // 期限切れの一括掃除を先に行う。DELETE ではなく status を書き換えるだけ
        // なので、直後の SELECT で「存在しない」と「期限切れ」を区別できる(禁止20)。
        await expireStaleWpProvisionings(db as Pool, WP_PROVISION_TTL_HOURS);

        const pollTokenHash = hashWpSecret(token);
        const row = await findWpProvisioningByPollTokenHash(db as Pool, pollTokenHash);
        if (!row) {
          res.status(404).json({ status: "not_found" });
          return;
        }

        if (row.status === "provisioned") {
          // 平文キーは発行の瞬間(completeWpProvisioning内)にしか返さない。
          // 再ポーリングでは tenantId のみ返す。
          res.status(200).json({ status: "provisioned", tenant_id: row.tenant_id });
          return;
        }
        if (row.status === "expired") {
          res.status(200).json({
            status: "expired",
            message: "サイトの確認が完了しないまま期限切れになりました。もう一度お試しください。",
          });
          return;
        }
        if (row.status === "failed") {
          res.status(200).json({ status: "failed", reason: row.failure_reason });
          return;
        }

        // ここに来るのは pending / site_verified のみ。念のため created_at 基準の
        // 期限切れも直接確認する(expireStaleWpProvisionings と同じTTLだが、
        // 掃除クエリと本チェックの間にタイミングのずれがあっても二重に安全)。
        if (isWpSecretExpired(row.created_at, new Date(), WP_PROVISION_TTL_HOURS * 60)) {
          res.status(200).json({
            status: "expired",
            message: "サイトの確認が完了しないまま期限切れになりました。もう一度お試しください。",
          });
          return;
        }

        const result = await advanceWpProvisioning(db as Pool, row);
        const body: Record<string, unknown> = { status: result.status };
        if (result.status === "provisioned") {
          body.tenant_id = result.tenantId;
          if (result.apiKey) body.api_key = result.apiKey;
        } else if (result.status === "pending") {
          if (result.waitReason) body.wait_reason = result.waitReason;
          if (result.verifyReason) body.verify_reason = result.verifyReason;
        }
        res.status(200).json(body);
      } catch (err) {
        logger.warn({ err }, "[GET /v1/public/wp/provision/:token]");
        res.status(500).json({ error: "poll_failed", message: "状態の確認に失敗しました。" });
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /v1/public/wp/disconnect
  // -------------------------------------------------------------------------
  app.post(
    "/v1/public/wp/disconnect",
    wpRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      const apiKeyHeader = req.header("x-api-key");
      if (!apiKeyHeader) {
        res.status(401).json({ error: "missing_api_key", message: "APIキーが指定されていません。" });
        return;
      }

      try {
        const keyHash = hashApiKey(apiKeyHeader);
        const result = await (db as Pool).query(
          `UPDATE tenant_api_keys SET is_active = false, updated_at = NOW()
           WHERE key_hash = $1 AND is_active = true
           RETURNING tenant_id`,
          [keyHash]
        );
        if (result.rowCount === 0) {
          // キーが存在するかどうかを漏らさない(存在しない/既に失効済みを同じ応答にする)。
          res.status(401).json({ error: "invalid_api_key", message: "APIキーが無効です。" });
          return;
        }

        // 会話データ・テナント自体は削除しない(FR-07)。ここで消すのはキーの有効性のみ。
        res.status(200).json({
          ok: true,
          message: "接続を解除しました。会話データとテナントは削除されません。",
        });
      } catch (err) {
        logger.warn({ err }, "[POST /v1/public/wp/disconnect]");
        res.status(500).json({ error: "disconnect_failed", message: "解除処理に失敗しました。" });
      }
    }
  );
}
