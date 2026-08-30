// src/api/internal/avatarConfigRoutes.ts
//
// GET /api/internal/avatar-config?tenantId=xxx
//   認証: X-Internal-Request: 1
//   テナント別アバター設定を返す。avatar-agent/agent.py から呼び出される。

import type { Express, Request, Response } from "express";
import { INTERNAL_REQUEST_HEADER } from "../../lib/metrics/kpiDefinitions";
import { getPool } from "../../lib/db";
import { logger } from "../../lib/logger";
import { internalNetworkOnly } from "../middleware/internalNetworkOnly";
import { internalHmacMiddleware } from "../../lib/crypto/hmacVerifier";

export function registerInternalAvatarConfigRoutes(app: Express): void {
  // 多層防御: loopback限定に加え HMAC 署名検証を課す。固定ヘッダのみでは
  // 任意の tenantId を指定して他テナントのアバター設定(voice_id/persona 等)を
  // 読み出せた (P0)。GET は空ボディ {} を署名対象とする。secret 未設定時は
  // fail-closed(500)。tenantId は query 由来だが、HMAC は「secret を持つ正規の
  // 呼び出し元であること」を保証し、非正規呼び出しからの読取を遮断する。
  app.get("/api/internal/avatar-config", internalNetworkOnly, internalHmacMiddleware, async (req: Request, res: Response) => {
    if (req.headers[INTERNAL_REQUEST_HEADER] !== "1") {
      return res.status(403).json({ error: "forbidden" });
    }

    const tenantId = req.query.tenantId;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenantId required" });
    }

    const _rawConfigId = typeof req.query.avatarConfigId === "string" ? req.query.avatarConfigId : undefined;
    // UUID形式のみ受け付ける（ログインジェクション・不正入力を排除）
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const avatarConfigId = _rawConfigId && UUID_RE.test(_rawConfigId) ? _rawConfigId : undefined;

    const COLS = "voice_id, personality_prompt, emotion_tags, lemonslice_agent_id, behavior_description, avatar_provider, image_url, agent_prompt, agent_idle_prompt, category_persona_map";

    try {
      const pool = getPool();
      let result;
      if (avatarConfigId) {
        // 特定アバターをID指定で取得（自テナント or r2c_default 限定 + is_active）
        // is_active 必須 — 無効化済み config が ID 指定で復活する穴を塞ぐ
        // (admin UI の inactive プレビューは別経路の別タスクで対応 — #210 スコープ外)
        result = await pool.query(
          `SELECT ${COLS} FROM avatar_configs WHERE id = $1 AND (tenant_id = $2 OR tenant_id = 'r2c_default') AND is_active = true LIMIT 1`,
          [avatarConfigId, tenantId],
        );
      } else {
        // アクティブアバターを決定的に取得（ORDER BY で非決定性を排除）
        result = await pool.query(
          `SELECT ${COLS} FROM avatar_configs WHERE tenant_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
          [tenantId],
        );
      }

      if (result.rows.length === 0) {
        return res.json({ config: null });
      }

      return res.json({ config: result.rows[0] });
    } catch (err) {
      // 握りつぶさない: ここが無言で 500 を返していたため、本番でマイグレーション未適用による
      // カラム欠落が起きても誰も気づけず、avatar-agent 側が「設定なし」と誤認して
      // 環境変数の汎用 LemonSlice エージェント(テナントと無関係な第三者の顔)に
      // 無言でフォールバックし続けた。原因特定に3週間かかった実例がある。
      logger.warn("[GET /api/internal/avatar-config] query failed", err);
      return res.status(500).json({ error: "internal error" });
    }
  });
}
