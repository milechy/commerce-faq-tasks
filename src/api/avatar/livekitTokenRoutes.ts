// src/api/avatar/livekitTokenRoutes.ts

//
// POST /api/avatar/room-token
//   認証: x-api-key (apiStack 経由 — authMiddleware で tenantId 解決済み)
//   DBからテナントの features.avatar + lemonslice_agent_id を確認し、
//   LiveKit Room を Server API で作成・Agent Dispatch 後、Widget用JWTを返す。
//
// CLAUDE.md Anti-Slop:
//   - tenantId は authMiddleware 解決済み req.tenantId から取得（body/query 禁止）
//   - PII・書籍内容をレスポンスに含めない

import crypto from "crypto";
import type { Express, Request, Response, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../lib/db";
import { RoomServiceClient, AgentDispatchClient, JobRestartPolicy } from "livekit-server-sdk";
import type { AuthedRequest } from "../../agent/http/authMiddleware";
import { logger } from '../../lib/logger';
import { queryTenantPlan, planHasFeature } from "../../lib/billing/planFeatures";
import { resolveBillingAccess, blocksPaidFeature } from "../../lib/billing/suspensionGate";

// ─── LiveKit JWT 生成 ─────────────────────────────────────────────────────────

function generateLiveKitToken(params: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: params.apiKey,
    sub: params.identity,
    nbf: now,
    exp: now + (params.ttlSeconds ?? 3600),
    video: {
      roomJoin: true,
      room: params.roomName,
      canSubscribe: true,    // Widget viewer: 映像受信
      canPublish: false,     // Widget viewer: 映像送信なし
      canPublishData: true,  // Data Channel送信を許可（映像・音声送信は不要だがデータは必要）
    },
  };
  return jwt.sign(payload, params.apiSecret, { algorithm: "HS256" });
}


// ─── LiveKit Server API 呼び出し（SDK 経由） ──────────────────────────────────
// 手動 Twirp JSON では room_name フィールドが LiveKit Cloud で無視される問題があるため
// livekit-server-sdk を使用してプロトバッファを正しく直列化する。

async function dispatchAgentToRoom(
  livekitUrl: string,
  apiKey: string,
  apiSecret: string,
  roomName: string,
  avatarConfigId?: string
): Promise<void> {
  const roomClient = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  const dispatchClient = new AgentDispatchClient(livekitUrl, apiKey, apiSecret);

  // 1. Room 作成（既存の場合は無害 — SDK が例外を投げないよう catch する）
  try {
    await roomClient.createRoom({
      name: roomName,
      emptyTimeout: 1800,    // 30分（デフォルト5分→延長）
      maxParticipants: 3,    // widget + agent + lemonslice
      // avatarConfigId を metadata に埋め込み → agent.py が特定アバターを選択できる
      metadata: avatarConfigId ? JSON.stringify({ avatarConfigId }) : undefined,
    });
    logger.info(`[livekitTokenRoutes] Room created: ${roomName}`);
  } catch (err: unknown) {
    // "already exists" は無害
    logger.warn(`[livekitTokenRoutes] CreateRoom warn: ${(err as Error)?.message ?? String(err)}`);
  }

  // 2. Agent Dispatch
  // restartPolicy: JRP_ON_FAILURE(デフォルト)を明示指定。会話途中で agent job が
  // 落ちても再起動されるようにする（LiveKit Cloud限定機能。以前は未指定=暗黙のデフォルト依存だった）。
  const dispatch = await dispatchClient.createDispatch(roomName, "rajiuce-avatar", {
    restartPolicy: JobRestartPolicy.JRP_ON_FAILURE,
  });
  logger.info(`[livekitTokenRoutes] Agent dispatched to room: ${roomName} id=${dispatch.id} room=${dispatch.room}`);
}

// ─── ルート登録 ───────────────────────────────────────────────────────────────

export function registerLiveKitTokenRoutes(
  app: Express,
  apiStack: RequestHandler[]
): void {
  logger.info("[livekitTokenRoutes] POST /api/avatar/room-token registered");
  app.post("/api/avatar/room-token", ...apiStack, async (req: Request, res: Response) => {
    if (!pool) {
      logger.warn("[livekitTokenRoutes] DATABASE_URL not set.");
      return res.json({ enabled: false, reason: "server_error" });
    }

    const tenantId = (req as AuthedRequest).tenantId;

    if (!tenantId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    try {
      // fix/unpaid-suspension: 停止ゲート判定に必要な billing 列も同じ SELECT で引く
      // (最高頻度でない経路だが、追加のラウンドトリップを増やさないため既存クエリに相乗り)。
      // subscription_status / delinquent_since が未適用(42703)の場合は、下の
      // catch が migration_required を返す(既存の 42703 ハンドリングと同じ・原価安全側)。
      const result = await pool.query(
        `SELECT t.features, t.lemonslice_agent_id, t.is_active,
                t.plan, t.subscription_status, t.delinquent_since,
                s.is_active AS sub_active
           FROM tenants t
           LEFT JOIN stripe_subscriptions s ON s.tenant_id = t.id
          WHERE t.id = $1`,
        [tenantId]
      );

      if (result.rowCount === 0) {
        logger.warn(`[livekitTokenRoutes] tenant not found in DB: ${tenantId}`);
        return res.json({ enabled: false, reason: "tenant_not_found" });
      }

      const row = result.rows[0] as {
        features: { avatar?: boolean; voice?: boolean; rag?: boolean; pre_dispatch?: boolean } | null;
        lemonslice_agent_id: string | null;
        is_active: boolean;
        plan: string | null;
        subscription_status: string | null;
        delinquent_since: Date | string | null;
        sub_active: boolean | null;
      };

      // 診断ログ（問題特定後に削除可）
      logger.info(`[livekitTokenRoutes] tenant=${tenantId} is_active=${row.is_active} features=${JSON.stringify(row.features)} agentId=${row.lemonslice_agent_id}`);

      if (!row.is_active) {
        logger.warn(`[livekitTokenRoutes] tenant inactive: ${tenantId}`);
        return res.json({ enabled: false, reason: "tenant_inactive" });
      }

      const avatarEnabled = row.features?.avatar === true;
      // lemonslice_agent_id は avatar-agent (Python) の実際の顔解決には使われない
      // （agent.py は avatar_configs テーブルの is_active な行を見る）。
      // 純粋な情報フィールドとしてレスポンスに残すが、ゲート判定には使わない
      // （テナント自身は PATCH /my-tenant からこの列を書けず、書けるsuper_adminが
      //  代行しない限りアバターが永久に起動できなかった）。
      const agentId = row.lemonslice_agent_id?.trim() || null;

      if (!avatarEnabled) {
        logger.warn(`[livekitTokenRoutes] avatar feature disabled for tenant: ${tenantId}`);
        return res.status(403).json({ error: 'Avatar not enabled for this tenant', enabled: false, reason: "avatar_disabled" });
      }

      // fix/unpaid-suspension [P0]: 未払・退会テナントの有料機能停止ゲート。
      // avatar は LiveKit セッション時間で従量原価が出る経路。restricted(猶予超過)・
      // suspended(未払/退会)の両方で止める。上の SELECT で引いた row から純関数で判定
      // (追加クエリ無し)。free_ad/enterprise/未知プランは resolveBillingAccess が
      // active を返すため従来どおり起動する。
      const billingAccess = resolveBillingAccess({
        plan: row.plan,
        subscriptionStatus: row.subscription_status,
        subActive: row.sub_active,
        delinquentSince: row.delinquent_since,
      });
      if (blocksPaidFeature(billingAccess)) {
        logger.warn(`[livekitTokenRoutes] billing suspended/restricted for tenant: ${tenantId} (access=${billingAccess})`);
        return res.status(402).json({ enabled: false, reason: "billing_suspended" });
      }

      // LiveKit 環境変数チェック
      const livekitUrl = process.env.LIVEKIT_URL?.trim();
      const apiKey     = process.env.LIVEKIT_API_KEY?.trim();
      const apiSecret  = process.env.LIVEKIT_API_SECRET?.trim();

      if (!livekitUrl || !apiKey || !apiSecret) {
        logger.warn(`[livekitTokenRoutes] LiveKit env vars not set: LIVEKIT_URL=${!!livekitUrl} LIVEKIT_API_KEY=${!!apiKey} LIVEKIT_API_SECRET=${!!apiSecret}`);
        return res.json({ enabled: false, reason: "livekit_not_configured" });
      }

      const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      const roomName = `rajiuce-${safeTenantId}-${crypto.randomBytes(8).toString("hex")}`;
      const identity = `widget-${safeTenantId}-${crypto.randomBytes(4).toString("hex")}`;
      const token    = generateLiveKitToken({ apiKey, apiSecret, roomName, identity });

      // アクティブなavatar_configのimage_urlとnameを取得
      // avatarConfigId が指定された場合はそのconfigを優先（テスト用途 — 特定アバターのプレビュー）
      let imageUrl: string | null = null;
      let avatarName: string | null = null;
      // UUID形式のみ受け付ける（DB lookup 前に不正入力を 400 で弾く — ログインジェクション・型混入対策）
      // avatarConfigRoutes.ts と同一の strict UUID regex
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const rawRequestedAvatarConfigId = req.body?.avatarConfigId;
      if (rawRequestedAvatarConfigId !== undefined && rawRequestedAvatarConfigId !== null) {
        if (typeof rawRequestedAvatarConfigId !== "string" || !UUID_RE.test(rawRequestedAvatarConfigId)) {
          return res.status(400).json({ error: "invalid avatarConfigId format (UUID required)" });
        }
      }
      const requestedAvatarConfigId = typeof rawRequestedAvatarConfigId === "string" ? rawRequestedAvatarConfigId : null;
      // SQL ownership check が通ったときのみ room metadata に伝搬（cross-tenant UUID が素通りするのを防ぐ）
      let verifiedAvatarConfigId: string | null = null;
      try {
        let avatarConfigResult;
        if (requestedAvatarConfigId) {
          // is_active 必須 — 無効化済み config が ID 指定で復活する穴を塞ぐ
          // (本番 token route は信頼できない入力 widget→エンドユーザ改竄可。
          //  admin UI の inactive プレビューは別経路の別タスクで対応 — #210 スコープ外)
          avatarConfigResult = await pool.query(
            "SELECT image_url, name FROM avatar_configs WHERE id = $1 AND (tenant_id = $2 OR tenant_id = 'r2c_default') AND is_active = true LIMIT 1",
            [requestedAvatarConfigId, tenantId]
          );
          if (avatarConfigResult.rows.length > 0) {
            verifiedAvatarConfigId = requestedAvatarConfigId;
          }
        } else {
          avatarConfigResult = await pool.query(
            "SELECT image_url, name FROM avatar_configs WHERE tenant_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
            [tenantId]
          );
        }
        imageUrl = (avatarConfigResult.rows[0]?.image_url as string | null) ?? null;
        avatarName = (avatarConfigResult.rows[0]?.name as string | null) ?? null;
      } catch (avatarErr: any) {
        // avatar_configs テーブルが存在しない場合は無視
        if (avatarErr?.code !== "42P01") {
          logger.warn("[livekitTokenRoutes] avatar_configs query warn:", avatarErr?.message);
        }
      }

      // active な avatar_config が無いままエージェントを dispatch すると、agent.py が
      // 顔を解決できず15秒でタイムアウトする（無駄なLiveKit dispatch）か、env
      // LEMONSLICE_AGENT_ID フォールバックで無関係な第三者の顔が出る事故経路になる。
      // features.avatar=true でも「設定未完了」を明示して早期returnする。
      // ただし avatarConfigId 明示指定時（テスト用途の特定アバタープレビュー）は対象外 —
      // 指定IDが見つからない場合の挙動は既存のまま変更しない（別のテスト観点のため）。
      if (!requestedAvatarConfigId && !imageUrl) {
        logger.warn(`[livekitTokenRoutes] no active avatar_config for tenant: ${tenantId}`);
        return res.json({ enabled: false, reason: "no_active_config" });
      }

      // GID 1216945619969548: features.pre_dispatch はテナント側フラグに過ぎず、
      // プラン制限(Enterprise限定, GID 1216944004404664)はバックエンドで強制する。
      // admin-ui のトグル表示制御だけでは、既に features.pre_dispatch=true が立っている
      // Starter/Growth テナントでサーバ側の事前ディスパッチが動き続けてしまう
      // （LiveKitセッション時間が先行発生する原価ゲート漏れ）。
      // フラグが false の場合はプラン確認自体が不要なのでDBクエリをスキップする。
      const preDispatchFeatureFlag = row.features?.pre_dispatch === true;
      let preDispatchEnabled = false;
      if (preDispatchFeatureFlag) {
        // fail-safe: plan取得失敗時は queryTenantPlan が free_ad を返す(=事前ディスパッチしない)
        const plan = await queryTenantPlan(pool, tenantId);
        preDispatchEnabled = planHasFeature(plan, "pre_dispatch");
        if (!preDispatchEnabled) {
          logger.info(
            `[livekitTokenRoutes] pre_dispatch feature flag is true but plan=${plan} does not include pre_dispatch — enforcing backend gate for tenant: ${tenantId}`
          );
        }
      }
      // connect=true はウィジェットがパネルを開いた瞬間の呼び出しを示す（pre_dispatch=false 時のオンデマンド起動）
      // オンデマンド起動はプラン制限の対象外 — 全プランで従来どおり動作させる。
      const connectRequested = req.body?.connect === true;
      const shouldDispatch = preDispatchEnabled || connectRequested;

      if (shouldDispatch) {
        dispatchAgentToRoom(livekitUrl, apiKey, apiSecret, roomName, verifiedAvatarConfigId ?? undefined)
          .catch(err => logger.error("[livekitTokenRoutes] dispatchAgentToRoom error:", err));
      } else {
        logger.info(`[livekitTokenRoutes] pre_dispatch=false, connect=false — skipping agent dispatch for tenant: ${tenantId}`);
      }

      return res.json({
        enabled: true,
        livekitUrl,
        token,
        roomName,
        agentId,
        imageUrl,
        avatarName,
        preDispatchEnabled,
      });
    } catch (err: any) {
      // カラム未存在エラー (42703) = マイグレーション未実行
      if (err?.code === "42703") {
        logger.error("[livekitTokenRoutes] Missing DB column — run migration_tenant_features.sql:", err.message);
        return res.json({ enabled: false, reason: "migration_required" });
      }
      logger.error("[POST /api/avatar/room-token]", err);
      return res.json({ enabled: false, reason: "server_error" });
    }
  });
}
