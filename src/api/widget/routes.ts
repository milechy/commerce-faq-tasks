// src/api/widget/routes.ts
// GET /widget/:tenantSlug.js — serve per-tenant dynamically generated widget JS.
//
// - Looks up tenant by ID (slug = tenant ID).
// - Injects tenant config + 24h session token.
// - Returns obfuscated JS with Cache-Control: public, max-age=86400.
// - 404 if tenant not found or inactive.

import type { Express, Request, Response } from "express";
// @ts-ignore
import { Pool } from "pg";
import { generateWidgetJs } from "./widgetGenerator";

const API_BASE_URL =
  process.env.API_BASE_URL ?? "https://api.rajiuce.com";

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
      const js = await generateWidgetJs({
        tenantId: tenant.id,
        apiBaseUrl: API_BASE_URL,
        avatarEnabled: features.avatar ?? false,
        themeColor: "#22c55e",
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
