// src/api/internal/avatarConfigRoutes.ts
//
// GET /api/internal/avatar-config?tenantId=xxx
//   認証: X-Internal-Request: 1
//   テナント別アバター設定を返す。avatar-agent/agent.py から呼び出される。

// @ts-ignore
import { Pool } from "pg";
import type { Express, Request, Response } from "express";
import { INTERNAL_REQUEST_HEADER } from "../../lib/metrics/kpiDefinitions";

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

export function registerInternalAvatarConfigRoutes(app: Express): void {
  app.get("/api/internal/avatar-config", async (req: Request, res: Response) => {
    if (req.headers[INTERNAL_REQUEST_HEADER] !== "1") {
      return res.status(403).json({ error: "forbidden" });
    }

    const tenantId = req.query.tenantId;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenantId required" });
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        "SELECT voice_id, personality_prompt, emotion_tags, lemonslice_agent_id, behavior_description, avatar_provider, image_url FROM avatar_configs WHERE tenant_id = $1 AND is_active = true LIMIT 1",
        [tenantId],
      );

      if (result.rows.length === 0) {
        return res.json({ config: null });
      }

      return res.json({ config: result.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ error: "internal error" });
    }
  });
}
