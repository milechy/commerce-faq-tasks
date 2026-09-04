// src/api/widget/wpSettingsRoutes.ts
//
// WordPress プラグイン計画 WP-13: 設定の読み書きAPI(docs/WORDPRESS_PLUGIN_REQUIREMENTS.md D9/§13.2)。
//
// ★設定の真実は常にR2C側DB(D9・FR-21)★
// WPは wp_options にキャッシュを持つが権威ではない。ここが唯一の読み書き口であり、
// CopilotUI側の既存ツール(set_widget_theme / update_allowed_origins /
// update_excluded_page_patterns、actionExecutor.ts)には一切分岐を入れない(FR-25)。
// 分岐を足したくなったら設計が間違っているサイン。
//
// 検証は「第3の緩いバリデーション」を作らず、既存の検証関数を直接再利用する:
//   - allowed_origins / excluded_page_patterns: admin/tenants/routes.ts の
//     allowedOriginsSchema / excludedPagePatternsSchema(super_admin用と
//     client_admin自己申告用が既に共有している同一インスタンス)
//   - position / offsetX / offsetY: admin/agent/widgetPlacement.ts の
//     validateWidgetPlacement(actionExecutor.ts の set_widget_theme ケースと同じ)
//   - primaryColor: set_widget_theme ケースと同じ #RRGGBB 正規表現
//     (validateWidgetPlacement 自体はprimaryColorを検証しない。set_widget_theme も
//     regex+validateWidgetPlacementの組み合わせで検証しており、ここはそれをそのまま踏襲する)

import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { createRateLimitMiddleware } from "../../lib/rate-limit";
import { hashApiKey } from "../admin/tenants/apiKeyUtils";
import { allowedOriginsSchema, excludedPagePatternsSchema } from "../admin/tenants/routes";
import {
  isValidWidgetPosition,
  parseWidgetOffset,
  validateWidgetPlacement,
  DEFAULT_WIDGET_POSITION,
  DEFAULT_WIDGET_OFFSET,
  type WidgetPosition,
} from "../admin/agent/widgetPlacement";
import { updateTenantAllowedOrigins } from "../../lib/tenant-context";

// ---------------------------------------------------------------------------
// レート制限
//
// wpProvisionRoutes.ts と同じ ip 段のみ(未認証と同じ扱い——このファイルの認証は
// リクエストごとにDBを引く方式で、認証後もtenantId段のバケットを別途持たない。
// 申告APIより緩めでよい(繰り返しの設定確認・保存操作を想定するため)。
// ---------------------------------------------------------------------------
const WP_SETTINGS_IP_LIMIT = 60;

// createRateLimitMiddleware の logger オプションは生 pino.Logger を要求する
// (src/index.ts が渡す pino() インスタンスと同じ型)。src/lib/logger.ts の
// AppLogger はラッパーで型が合わないため、ここでは渡さない
// (rate-limit.ts 側の logger は省略可能で、渡さなくても動作は変わらない)。
const wpSettingsRateLimiter = createRateLimitMiddleware({
  stage: "ip",
  getLimit: () => WP_SETTINGS_IP_LIMIT,
});

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------
const wpSettingsPatchSchema = z.object({
  position: z.string().max(50).optional(),
  offset_x: z.union([z.number(), z.string()]).optional(),
  offset_y: z.union([z.number(), z.string()]).optional(),
  primary_color: z.string().max(20).optional(),
  allowed_origins: allowedOriginsSchema,
  excluded_page_patterns: excludedPagePatternsSchema,
});

type WpSettingsResponseBody = {
  tenant_id: string;
  position: WidgetPosition;
  offset_x: number;
  offset_y: number;
  primary_color: string | null;
  excluded_page_patterns: string[];
  allowed_origins: string[];
};

function buildSettingsResponse(
  tenantId: string,
  widgetTheme: Record<string, unknown> | null,
  allowedOrigins: string[] | null,
  excludedPagePatterns: string[] | null
): WpSettingsResponseBody {
  const rawPosition = widgetTheme?.["position"];
  const position: WidgetPosition = isValidWidgetPosition(rawPosition) ? rawPosition : DEFAULT_WIDGET_POSITION;
  const offsetX = parseWidgetOffset(widgetTheme?.["offsetX"]) ?? DEFAULT_WIDGET_OFFSET;
  const offsetY = parseWidgetOffset(widgetTheme?.["offsetY"]) ?? DEFAULT_WIDGET_OFFSET;
  const rawColor = widgetTheme?.["primaryColor"];
  const primaryColor = typeof rawColor === "string" && /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : null;

  return {
    tenant_id: tenantId,
    position,
    offset_x: offsetX,
    offset_y: offsetY,
    primary_color: primaryColor,
    excluded_page_patterns: excludedPagePatterns ?? [],
    allowed_origins: allowedOrigins ?? [],
  };
}

export function registerWpSettingsRoutes(app: Express, db: Pool | null): void {
  function requireDb(_req: Request, res: Response, next: NextFunction): void {
    if (!db) {
      res.status(503).json({ error: "service_unavailable", message: "現在この機能は利用できません。" });
      return;
    }
    next();
  }

  // wpProvisionRoutes.ts の disconnect ハンドラと同じ x-api-key ハッシュ照合。
  // キーの存在有無を漏らさないため、無効/失効いずれも同じ401にする。
  async function authenticate(req: Request, res: Response): Promise<string | null> {
    const apiKeyHeader = req.header("x-api-key");
    if (!apiKeyHeader) {
      res.status(401).json({ error: "missing_api_key", message: "APIキーが指定されていません。" });
      return null;
    }
    const keyHash = hashApiKey(apiKeyHeader);
    const result = await (db as Pool).query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_api_keys WHERE key_hash = $1 AND is_active = true`,
      [keyHash]
    );
    if (result.rowCount === 0) {
      res.status(401).json({ error: "invalid_api_key", message: "APIキーが無効です。" });
      return null;
    }
    return result.rows[0]!.tenant_id;
  }

  // -------------------------------------------------------------------------
  // GET /v1/public/wp/settings
  // -------------------------------------------------------------------------
  app.get(
    "/v1/public/wp/settings",
    wpSettingsRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      try {
        const tenantId = await authenticate(req, res);
        if (!tenantId) return;

        const result = await (db as Pool).query<{
          widget_theme: Record<string, unknown> | null;
          allowed_origins: string[] | null;
          excluded_page_patterns: string[] | null;
        }>(
          `SELECT widget_theme, allowed_origins, excluded_page_patterns FROM tenants WHERE id = $1`,
          [tenantId]
        );
        if (result.rowCount === 0) {
          res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
          return;
        }
        const row = result.rows[0]!;
        res.status(200).json(
          buildSettingsResponse(tenantId, row.widget_theme, row.allowed_origins, row.excluded_page_patterns)
        );
      } catch (err) {
        logger.warn({ err }, "[GET /v1/public/wp/settings]");
        res.status(500).json({ error: "settings_fetch_failed", message: "設定の取得に失敗しました。" });
      }
    }
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/public/wp/settings
  // -------------------------------------------------------------------------
  app.patch(
    "/v1/public/wp/settings",
    wpSettingsRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      try {
        const tenantId = await authenticate(req, res);
        if (!tenantId) return;

        const parsed = wpSettingsPatchSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
          return;
        }
        const fields = parsed.data;
        if (Object.keys(fields).length === 0) {
          res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
          return;
        }

        // set_widget_theme(actionExecutor.ts)と同じ組み立て: primaryColorはregexで
        // 別途検証し(validateWidgetPlacement自体はprimaryColorを見ない)、
        // position/offsetX/offsetYはvalidateWidgetPlacementに委ねる。
        if (fields.primary_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(fields.primary_color)) {
          res.status(400).json({
            error: "invalid_primary_color",
            message: "primary_color は #RRGGBB 形式の16進数カラーコードで指定してください（例: #3B82F6）",
          });
          return;
        }
        const themePatch: Record<string, unknown> = {};
        if (fields.position !== undefined) themePatch["position"] = fields.position;
        if (fields.offset_x !== undefined) themePatch["offsetX"] = fields.offset_x;
        if (fields.offset_y !== undefined) themePatch["offsetY"] = fields.offset_y;
        if (fields.primary_color !== undefined) themePatch["primaryColor"] = fields.primary_color;

        const placementError = validateWidgetPlacement(themePatch);
        if (placementError) {
          res.status(400).json({ error: "invalid_placement", message: placementError });
          return;
        }

        // set_widget_theme(actionExecutor.ts)と同じ jsonb マージパターン。
        // allowed_origins/excluded_page_patternsはPATCH /v1/admin/tenants/:idと同じ
        // 単純な列UPDATE。
        const setClauses: string[] = [];
        const params: unknown[] = [];
        if (Object.keys(themePatch).length > 0) {
          params.push(JSON.stringify(themePatch));
          setClauses.push(`widget_theme = COALESCE(widget_theme, '{}') || $${params.length}::jsonb`);
        }
        if (fields.allowed_origins !== undefined) {
          params.push(fields.allowed_origins);
          setClauses.push(`allowed_origins = $${params.length}`);
        }
        if (fields.excluded_page_patterns !== undefined) {
          params.push(fields.excluded_page_patterns);
          setClauses.push(`excluded_page_patterns = $${params.length}`);
        }
        setClauses.push(`updated_at = NOW()`);
        params.push(tenantId);

        const result = await (db as Pool).query<{
          widget_theme: Record<string, unknown> | null;
          allowed_origins: string[] | null;
          excluded_page_patterns: string[] | null;
        }>(
          `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = $${params.length}
           RETURNING widget_theme, allowed_origins, excluded_page_patterns`,
          params
        );
        if (result.rowCount === 0) {
          res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
          return;
        }
        const row = result.rows[0]!;

        // allowed_originsはインメモリのtenantStoreも参照される(originCheck.ts)ため
        // 即時反映する。PATCH /v1/admin/my-tenant / PATCH /v1/admin/tenants/:id と同じ扱い。
        if (fields.allowed_origins !== undefined) {
          updateTenantAllowedOrigins(tenantId, fields.allowed_origins);
        }

        // FR-24: 保存できたように見せて実際は保存されていない、を作らない——
        // 更新後の全体設定をその場で返し、WP側がこれをそのまま画面に反映できるようにする。
        res.status(200).json(
          buildSettingsResponse(tenantId, row.widget_theme, row.allowed_origins, row.excluded_page_patterns)
        );
      } catch (err) {
        logger.warn({ err }, "[PATCH /v1/public/wp/settings]");
        res.status(500).json({ error: "settings_update_failed", message: "設定の更新に失敗しました。" });
      }
    }
  );
}
