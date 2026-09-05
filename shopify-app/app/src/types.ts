// shopify-app/app/src/types.ts
//
// GET/PATCH /v1/public/shopify/settings のリクエスト/レスポンス形状を、
// このアプリ内で独自に薄く定義したもの。
//
// ★ src/api/widget/shopifySettingsRoutes.ts の型を直接 import しない ★
// shopify-app/ は本体(src/)とは独立ビルド・独立デプロイのため
// (docs/SHOPIFY_APP_REQUIREMENTS.md §3.2)、ビルド時 import 依存を作らず、
// API 契約として手動で型を同期させる。shopifySettingsRoutes.ts の
// ShopifySettingsResponseBody / SHOPIFY_SURFACES / WIDGET_POSITIONS が
// 正典であり、変更があればこちらも手動で追従すること。

export const SHOPIFY_SURFACES = ["product_page", "cart", "shipping_policy"] as const;
export type ShopifySurface = (typeof SHOPIFY_SURFACES)[number];

export const WIDGET_POSITIONS = ["bottom-right", "bottom-left"] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export interface ShopifyTrigger {
  trigger_type: "page_url_match";
  trigger_config: { patterns: string[]; match_type: "glob" };
}

/** GET /v1/public/shopify/settings のレスポンス、および PATCH のレスポンス。 */
export interface ShopifySettings {
  tenant_id: string;
  plan: string;
  is_active: boolean;
  position: WidgetPosition;
  offset_x: number;
  offset_y: number;
  surfaces: Record<ShopifySurface, boolean>;
  triggers: ShopifyTrigger[];
}

/** PATCH /v1/public/shopify/settings のリクエストボディ。 */
export interface ShopifySettingsPatch {
  position?: WidgetPosition;
  offset_x?: number;
  offset_y?: number;
  surfaces?: Partial<Record<ShopifySurface, boolean>>;
}

/** バックエンド共通のエラー応答形式({ error: snake_case, message: 日本語 })。 */
export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
}
