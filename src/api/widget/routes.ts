// src/api/widget/routes.ts
// GET /widget/:tenantSlug.js — serve per-tenant dynamically generated widget JS.
//
// - Looks up tenant by ID (slug = tenant ID).
// - Injects tenant config + 24h session token.
// - Returns obfuscated JS with Cache-Control: public, max-age=86400.
// - 404 if tenant not found or inactive.

import type { Express, Request, Response } from "express";
import { Pool } from "pg";
import { generateWidgetJs } from "./widgetGenerator";
import { resolveAvatarAssignment } from "../conversion/avatarAbExperiment";

const API_BASE_URL =
  process.env.API_BASE_URL ?? "https://api.r2c.biz";

export function registerWidgetRoutes(app: Express, db: Pool | null): void {
  app.get("/widget/:tenantSlug.js", async (req: Request, res: Response) => {
    const { tenantSlug } = req.params;

    if (!db) {
      // No DB — fall back to static widget.js redirect
      return res.redirect("/widget.js");
    }

    try {
      const result = await db.query(
        `SELECT id, is_active, features
         FROM tenants
         WHERE id = $1`,
        [tenantSlug]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "tenant_not_found" });
      }

      const tenant = result.rows[0];
      if (!tenant.is_active) {
        return res.status(404).json({ error: "tenant_inactive" });
      }

      const features = tenant.features ?? {};
      const defaultAvatarEnabled: boolean = features.avatar ?? false;

      // GID 1216978855735482: 「アバターあり vs テキストのみ」A/Bテスト。
      // このエンドポイントは24hブラウザキャッシュされ、かつ生成時点ではまだ
      // chat_sessionのsession_idが存在しない（ページ読み込み時に1回だけ呼ばれる）。
      // そのため厳密なsession単位ではなく、visitor近似のsticky key（IP+テナントID）で
      // 決定的に割り当てる。同じ訪問者はブラウザキャッシュにより最大24h同じ結果になり、
      // 副次的にセッションをまたいだstickinessも得られる。
      // features.avatar=false のテナントでは実験を一切参照しない（ガード）。
      const stickyKey = `${req.ip ?? "unknown"}:${tenant.id}`;
      const assignment = await resolveAvatarAssignment(db, tenant.id, stickyKey, defaultAvatarEnabled);

      const js = await generateWidgetJs({
        tenantId: tenant.id,
        apiBaseUrl: API_BASE_URL,
        avatarEnabled: assignment.avatarEnabled,
        themeColor: "#22c55e",
        abExperimentId: assignment.experimentId,
        abVariant: assignment.variant,
      });

      res.set("Content-Type", "application/javascript; charset=utf-8");
      res.set("Cache-Control", "public, max-age=86400");
      res.set("X-Content-Type-Options", "nosniff");
      return res.send(js);
    } catch (err) {
      return res.status(500).json({ error: "widget_generation_failed" });
    }
  });
}
