// src/api/internal/avatarConfigRoutes.ts
//
// GET /api/internal/avatar-config?tenantId=xxx
//   認証: X-Internal-Request: 1
//   テナント別アバター設定を返す。avatar-agent/agent.py から呼び出される。

import type { Express, Request, Response } from "express";
import { INTERNAL_REQUEST_HEADER } from "../../lib/metrics/kpiDefinitions";
import { getPool } from "../../lib/db";

export function registerInternalAvatarConfigRoutes(app: Express): void {
  app.get("/api/internal/avatar-config", async (req: Request, res: Response) => {
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

    const COLS = "voice_id, personality_prompt, emotion_tags, lemonslice_agent_id, behavior_description, avatar_provider, image_url, agent_prompt, agent_idle_prompt";

    try {
      const pool = getPool();
      let result;
      if (avatarConfigId) {
        // 特定アバターをID指定で取得（自テナント or r2c_default 限定）
        result = await pool.query(
          `SELECT ${COLS} FROM avatar_configs WHERE id = $1 AND (tenant_id = $2 OR tenant_id = 'r2c_default') LIMIT 1`,
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
    } catch {
      return res.status(500).json({ error: "internal error" });
    }
  });
}
