// src/api/widget/shopifySettingsRoutes.ts
//
// Shopify連携(docs/SHOPIFY_APP_REQUIREMENTS.md) FR-06〜FR-08: 表示面選択・表示位置の
// 設定同期API。wpSettingsRoutes.ts(WordPress版, D9/FR-21)と同じ「設定の真実は常に
// R2C側DB」方式をそのまま踏襲する。埋め込み管理画面(shopify-app/、本タスクの対象外)は
// ここをGET/PATCHするだけの薄いクライアントになる想定。
//
// ★認証はタスク03(App Bridge Token Exchange)未着手のための暫定実装★
// 本来は Shopify のセッショントークンを検証してtenantIdを一意に確定させるが、
// このブランチ時点ではその実装が無いため、ヘッダで受け取った
// shopドメイン(x-shopify-shop-domain)とテナントID(x-tenant-id)の組み合わせを
// tenantsテーブルに照合するだけの簡易チェックに留める(過剰に作り込まない、との
// タスク指示に従う)。shopドメイン単体は`*.myshopify.com`で推測されうるため
// (禁止1のテナント越境防止の考え方に沿い)、単純化しつつも2値の組み合わせ照合とする。
// タスク03でApp Bridgeセッション検証に置き換える。
//
// ★表示面選択のZodスキーマ設計(FR-06)★
// 「商品ページ/カート/配送ポリシーページ」のチェックボックスは、既存TriggerEngine
// (src/api/admin/agent/engagementSuggest.ts の EngagementTriggerType 4種)の
// page_url_match にマッピングする。埋め込み管理画面には trigger_type/trigger_config
// のような内部語彙を出さず、素朴な boolean のsurfacesとして受け渡しし、GETレスポンス
// 側で対応するtriggersを併記する(CLAUDE.md「画面に出す語彙は内部語と分ける」と同型)。
//
// ★DBスキーマは新設しない★
// widget_theme(JSONB, `COALESCE(widget_theme, '{}') || $1::jsonb` の浅いマージ)を
// wpSettingsRoutes.ts と同じ要領で再利用する。surfaceごとに独立したトップレベルキー
// (shopifySurfaceProductPage 等)として保存することで、浅いマージでも他surfaceの値を
// 巻き込んで消さない(ネストしたオブジェクトを1キーに詰めると、浅いマージが
// オブジェクト全体を置換してしまい部分更新で他surfaceの値が消える。これを避けるため
// フラットなキーにしている)。
//
// オフセットの検証は widgetPlacement.ts の validateWidgetPlacement /
// parseWidgetOffset をそのまま使う(0〜320pxの値域は public/widget.js と一致させる
// 既存の唯一の実装)。第2の検証ロジックを作らない。

import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { createRateLimitMiddleware } from "../../lib/rate-limit";
import {
  isValidWidgetPosition,
  parseWidgetOffset,
  validateWidgetPlacement,
  DEFAULT_WIDGET_POSITION,
  DEFAULT_WIDGET_OFFSET,
  type WidgetPosition,
} from "../admin/agent/widgetPlacement";

// ---------------------------------------------------------------------------
// レート制限(wpSettingsRoutes.ts と同じ ip 段のみ)
// ---------------------------------------------------------------------------
const SHOPIFY_SETTINGS_IP_LIMIT = 60;

const shopifySettingsRateLimiter = createRateLimitMiddleware({
  stage: "ip",
  getLimit: () => SHOPIFY_SETTINGS_IP_LIMIT,
});

// ---------------------------------------------------------------------------
// 表示面(surfaces) ⇔ 既存TriggerEngine(page_url_match)マッピング
// ---------------------------------------------------------------------------
export const SHOPIFY_SURFACES = ["product_page", "cart", "shipping_policy"] as const;
export type ShopifySurface = (typeof SHOPIFY_SURFACES)[number];

/** widget_theme 内でのフラットな保存キー(浅いマージで他surfaceを巻き込まないため)。 */
const SURFACE_THEME_KEYS: Record<ShopifySurface, string> = {
  product_page: "shopifySurfaceProductPage",
  cart: "shopifySurfaceCart",
  shipping_policy: "shopifySurfaceShippingPolicy",
};

/** Shopifyの標準URL構造(https://shopify.dev)に基づく既定パターン。 */
export interface ShopifyTrigger {
  trigger_type: "page_url_match";
  trigger_config: { patterns: string[]; match_type: "glob" };
}

const SURFACE_TRIGGER_MAP: Record<ShopifySurface, ShopifyTrigger> = {
  product_page: { trigger_type: "page_url_match", trigger_config: { patterns: ["/products/*"], match_type: "glob" } },
  cart: { trigger_type: "page_url_match", trigger_config: { patterns: ["/cart"], match_type: "glob" } },
  shipping_policy: {
    trigger_type: "page_url_match",
    trigger_config: { patterns: ["/policies/shipping-policy"], match_type: "glob" },
  },
};

function normalizeSurfaces(widgetTheme: Record<string, unknown> | null | undefined): Record<ShopifySurface, boolean> {
  const result = {} as Record<ShopifySurface, boolean>;
  for (const surface of SHOPIFY_SURFACES) {
    result[surface] = widgetTheme?.[SURFACE_THEME_KEYS[surface]] === true;
  }
  return result;
}

function buildTriggersFromSurfaces(surfaces: Record<ShopifySurface, boolean>): ShopifyTrigger[] {
  return SHOPIFY_SURFACES.filter((s) => surfaces[s]).map((s) => SURFACE_TRIGGER_MAP[s]);
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------
const shopifySurfacesPatchSchema = z
  .object({
    product_page: z.boolean().optional(),
    cart: z.boolean().optional(),
    shipping_policy: z.boolean().optional(),
  })
  .strict();

const shopifySettingsPatchSchema = z.object({
  position: z.string().max(50).optional(),
  offset_x: z.union([z.number(), z.string()]).optional(),
  offset_y: z.union([z.number(), z.string()]).optional(),
  surfaces: shopifySurfacesPatchSchema.optional(),
});

type ShopifySettingsResponseBody = {
  tenant_id: string;
  plan: string;
  is_active: boolean;
  position: WidgetPosition;
  offset_x: number;
  offset_y: number;
  surfaces: Record<ShopifySurface, boolean>;
  triggers: ShopifyTrigger[];
};

function buildSettingsResponse(
  tenantId: string,
  plan: string,
  isActive: boolean,
  widgetTheme: Record<string, unknown> | null
): ShopifySettingsResponseBody {
  const rawPosition = widgetTheme?.["position"];
  const position: WidgetPosition = isValidWidgetPosition(rawPosition) ? rawPosition : DEFAULT_WIDGET_POSITION;
  const offsetX = parseWidgetOffset(widgetTheme?.["offsetX"]) ?? DEFAULT_WIDGET_OFFSET;
  const offsetY = parseWidgetOffset(widgetTheme?.["offsetY"]) ?? DEFAULT_WIDGET_OFFSET;
  const surfaces = normalizeSurfaces(widgetTheme);

  return {
    tenant_id: tenantId,
    plan,
    is_active: isActive,
    position,
    offset_x: offsetX,
    offset_y: offsetY,
    surfaces,
    triggers: buildTriggersFromSurfaces(surfaces),
  };
}

export function registerShopifySettingsRoutes(app: Express, db: Pool | null): void {
  function requireDb(_req: Request, res: Response, next: NextFunction): void {
    if (!db) {
      res.status(503).json({ error: "service_unavailable", message: "現在この機能は利用できません。" });
      return;
    }
    next();
  }

  // タスク03のApp Bridgeセッション検証と後で統合する(ファイル冒頭コメント参照)。
  // shopドメインとテナントIDの組み合わせが一致しなければ、存在有無を漏らさず
  // 同一の401にする(wpSettingsRoutes.ts の「無効/失効いずれも同じ401」と同型)。
  async function authenticate(req: Request, res: Response): Promise<string | null> {
    const shopDomain = req.header("x-shopify-shop-domain");
    if (!shopDomain) {
      res.status(401).json({ error: "missing_shop_domain", message: "ショップドメインが指定されていません。" });
      return null;
    }
    const tenantIdHeader = req.header("x-tenant-id");
    if (!tenantIdHeader) {
      res.status(401).json({ error: "missing_tenant_id", message: "テナントIDが指定されていません。" });
      return null;
    }
    const result = await (db as Pool).query<{ id: string }>(
      `SELECT id FROM tenants WHERE shopify_shop_domain = $1 AND id = $2`,
      [shopDomain, tenantIdHeader]
    );
    if (result.rowCount === 0) {
      res.status(401).json({
        error: "shop_domain_mismatch",
        message: "ショップドメインとテナントIDの組み合わせが正しくありません。",
      });
      return null;
    }
    return result.rows[0]!.id;
  }

  // -------------------------------------------------------------------------
  // GET /v1/public/shopify/settings
  // -------------------------------------------------------------------------
  app.get(
    "/v1/public/shopify/settings",
    shopifySettingsRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      try {
        const tenantId = await authenticate(req, res);
        if (!tenantId) return;

        const result = await (db as Pool).query<{
          plan: string;
          is_active: boolean;
          widget_theme: Record<string, unknown> | null;
        }>(`SELECT plan, is_active, widget_theme FROM tenants WHERE id = $1`, [tenantId]);
        if (result.rowCount === 0) {
          res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
          return;
        }
        const row = result.rows[0]!;
        res.status(200).json(buildSettingsResponse(tenantId, row.plan, row.is_active, row.widget_theme));
      } catch (err) {
        logger.warn({ err }, "[GET /v1/public/shopify/settings]");
        res.status(500).json({ error: "settings_fetch_failed", message: "設定の取得に失敗しました。" });
      }
    }
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/public/shopify/settings
  // -------------------------------------------------------------------------
  app.patch(
    "/v1/public/shopify/settings",
    shopifySettingsRateLimiter,
    requireDb,
    async (req: Request, res: Response) => {
      try {
        const tenantId = await authenticate(req, res);
        if (!tenantId) return;

        const parsed = shopifySettingsPatchSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
          return;
        }
        const fields = parsed.data;
        if (Object.keys(fields).length === 0) {
          res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
          return;
        }

        const themePatch: Record<string, unknown> = {};
        if (fields.position !== undefined) themePatch["position"] = fields.position;
        if (fields.offset_x !== undefined) themePatch["offsetX"] = fields.offset_x;
        if (fields.offset_y !== undefined) themePatch["offsetY"] = fields.offset_y;

        // position/offsetの値域チェックは widgetPlacement.ts に一本化(禁止6)。
        // 0〜320pxの範囲外・不正値はここで弾き、DBには一切触れない(FR-24型の担保)。
        if (Object.keys(themePatch).length > 0) {
          const placementError = validateWidgetPlacement(themePatch);
          if (placementError) {
            res.status(400).json({ error: "invalid_placement", message: placementError });
            return;
          }
        }

        if (fields.surfaces !== undefined) {
          for (const surface of SHOPIFY_SURFACES) {
            const value = fields.surfaces[surface];
            if (value !== undefined) {
              themePatch[SURFACE_THEME_KEYS[surface]] = value;
            }
          }
        }

        if (Object.keys(themePatch).length === 0) {
          // surfacesオブジェクトは指定されたが中身が空(全キーundefined)のケース。
          res.status(400).json({ error: "no_fields", message: "更新フィールドが必要です。" });
          return;
        }

        const result = await (db as Pool).query<{
          plan: string;
          is_active: boolean;
          widget_theme: Record<string, unknown> | null;
        }>(
          `UPDATE tenants
           SET widget_theme = COALESCE(widget_theme, '{}') || $1::jsonb, updated_at = NOW()
           WHERE id = $2
           RETURNING plan, is_active, widget_theme`,
          [JSON.stringify(themePatch), tenantId]
        );
        if (result.rowCount === 0) {
          res.status(404).json({ error: "not_found", message: "テナントが見つかりません。" });
          return;
        }
        const row = result.rows[0]!;

        // FR-08/D9: 保存できたように見せて実際は保存されていない、を作らない。
        // 更新後の全体設定をその場で返す(wpSettingsRoutes.ts のFR-24と同型)。
        res.status(200).json(buildSettingsResponse(tenantId, row.plan, row.is_active, row.widget_theme));
      } catch (err) {
        logger.warn({ err }, "[PATCH /v1/public/shopify/settings]");
        res.status(500).json({ error: "settings_update_failed", message: "設定の更新に失敗しました。" });
      }
    }
  );
}
