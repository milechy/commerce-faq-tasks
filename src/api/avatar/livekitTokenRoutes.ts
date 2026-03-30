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
import { RoomServiceClient, AgentDispatchClient } from "livekit-server-sdk";
import type { AuthedRequest } from "../../agent/http/authMiddleware";

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
  roomName: string
): Promise<void> {
  const roomClient = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  const dispatchClient = new AgentDispatchClient(livekitUrl, apiKey, apiSecret);

  // 1. Room 作成（既存の場合は無害 — SDK が例外を投げないよう catch する）
  try {
    await roomClient.createRoom({
      name: roomName,
      emptyTimeout: 1800,    // 30分（デフォルト5分→延長）
      maxParticipants: 3,    // widget + agent + lemonslice
    });
    console.log(`[livekitTokenRoutes] Room created: ${roomName}`);
  } catch (err: any) {
    // "already exists" は無害
    console.warn(`[livekitTokenRoutes] CreateRoom warn: ${err?.message ?? err}`);
  }

  // 2. Agent Dispatch
  const dispatch = await dispatchClient.createDispatch(roomName, "rajiuce-avatar");
  console.log(`[livekitTokenRoutes] Agent dispatched to room: ${roomName} id=${dispatch.id} room=${dispatch.room}`);
}

// ─── ルート登録 ───────────────────────────────────────────────────────────────

export function registerLiveKitTokenRoutes(
  app: Express,
  apiStack: RequestHandler[]
): void {
  console.log("[livekitTokenRoutes] POST /api/avatar/room-token registered");
  app.post("/api/avatar/room-token", ...apiStack, async (req: Request, res: Response) => {
    if (!pool) {
      console.warn("[livekitTokenRoutes] DATABASE_URL not set.");
      return res.json({ enabled: false });
    }

    const tenantId = (req as AuthedRequest).tenantId;

    if (!tenantId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    try {
      const result = await pool.query(
        `SELECT features, lemonslice_agent_id, is_active FROM tenants WHERE id = $1`,
        [tenantId]
      );

      if (result.rowCount === 0) {
        console.warn(`[livekitTokenRoutes] tenant not found in DB: ${tenantId}`);
        return res.json({ enabled: false });
      }

      const row = result.rows[0] as {
        features: { avatar?: boolean; voice?: boolean; rag?: boolean } | null;
        lemonslice_agent_id: string | null;
        is_active: boolean;
      };

      // 診断ログ（問題特定後に削除可）
      console.log(`[livekitTokenRoutes] tenant=${tenantId} is_active=${row.is_active} features=${JSON.stringify(row.features)} agentId=${row.lemonslice_agent_id}`);

      if (!row.is_active) {
        console.warn(`[livekitTokenRoutes] tenant inactive: ${tenantId}`);
        return res.json({ enabled: false });
      }

      const avatarEnabled = row.features?.avatar === true;
      const agentId = row.lemonslice_agent_id?.trim() || null;

      if (!avatarEnabled) {
        console.warn(`[livekitTokenRoutes] avatar feature disabled for tenant: ${tenantId}`);
        return res.status(403).json({ error: 'Avatar not enabled for this tenant' });
      }

      if (!agentId) {
        console.warn(`[livekitTokenRoutes] lemonslice_agent_id missing for tenant: ${tenantId}`);
        return res.json({ enabled: false });
      }

      // LiveKit 環境変数チェック
      const livekitUrl = process.env.LIVEKIT_URL?.trim();
      const apiKey     = process.env.LIVEKIT_API_KEY?.trim();
      const apiSecret  = process.env.LIVEKIT_API_SECRET?.trim();

      if (!livekitUrl || !apiKey || !apiSecret) {
        console.warn(`[livekitTokenRoutes] LiveKit env vars not set: LIVEKIT_URL=${!!livekitUrl} LIVEKIT_API_KEY=${!!apiKey} LIVEKIT_API_SECRET=${!!apiSecret}`);
        return res.json({ enabled: false });
      }

      const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      const roomName = `rajiuce-${safeTenantId}-${crypto.randomBytes(8).toString("hex")}`;
      const identity = `widget-${safeTenantId}-${crypto.randomBytes(4).toString("hex")}`;
      const token    = generateLiveKitToken({ apiKey, apiSecret, roomName, identity });

      // アクティブなavatar_configのimage_urlとnameを取得
      let imageUrl: string | null = null;
      let avatarName: string | null = null;
      try {
        const avatarConfigResult = await pool.query(
          "SELECT image_url, name FROM avatar_configs WHERE tenant_id = $1 AND is_active = true LIMIT 1",
          [tenantId]
        );
        imageUrl = (avatarConfigResult.rows[0]?.image_url as string | null) ?? null;
        avatarName = (avatarConfigResult.rows[0]?.name as string | null) ?? null;
      } catch (avatarErr: any) {
        // avatar_configs テーブルが存在しない場合は無視
        if (avatarErr?.code !== "42P01") {
          console.warn("[livekitTokenRoutes] avatar_configs query warn:", avatarErr?.message);
        }
      }

      // Room 作成 + Agent Dispatch（SDK 経由 — await して結果をログ、失敗してもトークンは返す）
      try {
        await dispatchAgentToRoom(livekitUrl, apiKey, apiSecret, roomName);
      } catch (err) {
        console.error("[livekitTokenRoutes] dispatchAgentToRoom error:", err);
      }

      return res.json({
        enabled: true,
        livekitUrl,
        token,
        roomName,
        agentId,
        imageUrl,
        avatarName,
      });
    } catch (err: any) {
      // カラム未存在エラー (42703) = マイグレーション未実行
      if (err?.code === "42703") {
        console.error("[livekitTokenRoutes] Missing DB column — run migration_tenant_features.sql:", err.message);
      } else {
        console.error("[POST /api/avatar/room-token]", err);
      }
      return res.json({ enabled: false });
    }
  });
}
