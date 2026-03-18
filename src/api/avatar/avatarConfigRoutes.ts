// src/api/avatar/avatarConfigRoutes.ts
// Phase40 Step3a: Widget用アバター設定・LiveKitトークン取得エンドポイント
//
// GET /api/avatar/config
//   認証: x-api-key (apiStack 経由 — authMiddleware で tenantId 解決済み)
//   テナントの features.avatar + lemonslice_agent_id を確認し、
//   LiveKit 接続用の一時トークンを発行して返す。
//
// CLAUDE.md Anti-Slop:
//   - tenantId は authMiddleware 解決済み req.tenantId から取得（query/body 禁止）
//   - PII・書籍内容をレスポンスに含めない

import crypto from "crypto";
import type { Express, Request, Response, RequestHandler } from "express";
// @ts-ignore
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import type { AuthedRequest } from "../../agent/http/authMiddleware";

// ─── DB ──────────────────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// ─── LiveKit JWT 生成（livekit-server-sdk 不要） ─────────────────────────────

interface LiveKitTokenParams {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  ttlSeconds?: number;
}

function generateLiveKitToken(params: LiveKitTokenParams): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: params.apiKey,
    sub: params.identity,
    nbf: now,
    exp: now + (params.ttlSeconds ?? 3600),
    video: {
      roomJoin: true,
      room: params.roomName,
      canPublish: false,   // Widget viewer: 映像受信のみ
      canSubscribe: true,
    },
  };
  return jwt.sign(payload, params.apiSecret, { algorithm: "HS256" });
}

// ─── ルーム名生成 ─────────────────────────────────────────────────────────────

function generateRoomName(tenantId: string): string {
  const uuid = crypto.randomBytes(8).toString("hex");
  // テナントIDをサニタイズ（英数字・ハイフンのみ許可）
  const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return `tenant-${safeTenantId}-${uuid}`;
}

// ─── ルート登録 ───────────────────────────────────────────────────────────────

export function registerAvatarConfigRoutes(
  app: Express,
  apiStack: RequestHandler[]
): void {
  if (!pool) {
    console.warn("[avatarConfigRoutes] DATABASE_URL not set. Route disabled.");
    return;
  }

  /**
   * GET /api/avatar/config
   *
   * Widget から呼ばれる。apiStack（authMiddleware 済み）で保護されるため、
   * tenantId は req.tenantId から取得する（query/body 禁止）。
   */
  app.get("/api/avatar/config", ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as AuthedRequest).tenantId;

    if (!tenantId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    try {
      const result = await pool.query(
        `SELECT features, lemonslice_agent_id FROM tenants WHERE id = $1 AND is_active = true`,
        [tenantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "tenant_not_found" });
      }

      const row = result.rows[0] as {
        features: { avatar?: boolean; voice?: boolean; rag?: boolean } | null;
        lemonslice_agent_id: string | null;
      };

      const avatarEnabled = row.features?.avatar === true;
      const agentId = row.lemonslice_agent_id?.trim() || null;

      // avatar 無効 or Agent ID 未設定 → enabled: false（エラーにしない）
      if (!avatarEnabled || !agentId) {
        return res.json({ enabled: false });
      }

      // LiveKit 環境変数チェック
      const wsUrl     = process.env.LIVEKIT_WS_URL?.trim();
      const apiKey    = process.env.LIVEKIT_API_KEY?.trim();
      const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

      if (!wsUrl || !apiKey || !apiSecret) {
        // 設定不足の場合もエラーにせず disabled 扱い
        console.warn("[avatarConfigRoutes] LiveKit env vars not set for tenant:", tenantId);
        return res.json({ enabled: false });
      }

      const roomName = generateRoomName(tenantId);
      const identity = `widget-${tenantId}-${crypto.randomBytes(4).toString("hex")}`;
      const token    = generateLiveKitToken({ apiKey, apiSecret, roomName, identity });

      return res.json({
        enabled: true,
        provider: "lemon_slice",
        lemonsliceAgentId: agentId,
        livekit: {
          wsUrl,
          token,
          roomName,
        },
      });
    } catch (err) {
      console.error("[GET /api/avatar/config]", err);
      // Widget への影響を最小化: エラー時も enabled: false で返す
      return res.json({ enabled: false });
    }
  });
}
