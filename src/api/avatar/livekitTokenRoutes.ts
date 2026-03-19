// src/api/avatar/livekitTokenRoutes.ts
//
// POST /api/avatar/room-token
//   認証: x-api-key (apiStack 経由 — authMiddleware で tenantId 解決済み)
//   DBからテナントの features.avatar + lemonslice_agent_id を確認し、
//   LiveKit Room接続用の一時トークンを発行して返す。
//
// CLAUDE.md Anti-Slop:
//   - tenantId は authMiddleware 解決済み req.tenantId から取得（body/query 禁止）
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

// ─── LiveKit JWT 生成（livekit-server-sdk 不要、jsonwebtoken で手動生成） ──

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
      canSubscribe: true,  // Widget viewer: 映像受信
      canPublish: false,   // Widget viewer: 映像送信なし
    },
  };
  return jwt.sign(payload, params.apiSecret, { algorithm: "HS256" });
}

// ─── ルート登録 ───────────────────────────────────────────────────────────────

export function registerLiveKitTokenRoutes(
  app: Express,
  apiStack: RequestHandler[]
): void {
  /**
   * POST /api/avatar/room-token
   *
   * Widget から呼ばれる。apiStack（authMiddleware 済み）で保護されるため、
   * tenantId は req.tenantId から取得する（body/query から禁止）。
   * pool null チェックはルート登録後にハンドラ内で行う（ルート未登録による 404 を防ぐ）。
   */
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
      const livekitUrl = process.env.LIVEKIT_URL?.trim();
      const apiKey     = process.env.LIVEKIT_API_KEY?.trim();
      const apiSecret  = process.env.LIVEKIT_API_SECRET?.trim();

      if (!livekitUrl || !apiKey || !apiSecret) {
        console.warn("[livekitTokenRoutes] LiveKit env vars not set for tenant:", tenantId);
        return res.json({ enabled: false });
      }

      const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      const roomName = `rajiuce-${safeTenantId}-${crypto.randomBytes(8).toString("hex")}`;
      const identity = `widget-${safeTenantId}-${crypto.randomBytes(4).toString("hex")}`;
      const token    = generateLiveKitToken({ apiKey, apiSecret, roomName, identity });

      return res.json({
        enabled: true,
        livekitUrl,
        token,
        roomName,
        agentId,
      });
    } catch (err) {
      console.error("[POST /api/avatar/room-token]", err);
      // Widget への影響を最小化: エラー時も enabled: false で返す
      return res.json({ enabled: false });
    }
  });
}
