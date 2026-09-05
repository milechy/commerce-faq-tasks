---
name: project-shopify-settings-routes-stopgap-auth
description: shopifySettingsRoutes.ts(GID 1218199958289532)の暫定認証とsurface→trigger設計。タスク03(OAuth)着手時に置き換え/整合が必要な箇所
metadata:
  type: project
---

`src/api/widget/shopifySettingsRoutes.ts`(GET/PATCH `/v1/public/shopify/settings`)は
タスク03(App Bridge Token Exchange)が未実装のブランチ時点で実装した。以下2点は
タスク03着手時に必ず見直すこと。

**1. 認証は暫定実装。** `authenticate()` は `x-shopify-shop-domain` + `x-tenant-id`
ヘッダの組み合わせを `SELECT id FROM tenants WHERE shopify_shop_domain = $1 AND id = $2`
で照合するだけ(セッション検証なし)。タスク03でApp Bridgeのセッショントークン検証に
置き換える際は、この関数のシグネチャ(`Promise<string | null>`、tenantIdを返す)を
維持すればGET/PATCHハンドラ側は変更不要になるよう設計してある。

**2. 表示面(surfaces)はwidget_themeにフラットな独立キーで保存する。**
`shopifySurfaceProductPage` / `shopifySurfaceCart` / `shopifySurfaceShippingPolicy` を
widget_theme(JSONB)のトップレベルに直接持たせている。**ネストしたオブジェクト
(例: `widget_theme.shopifySurfaces = {product_page: true, ...}`)にしてはいけない** —
既存のUPDATE文は `COALESCE(widget_theme, '{}') || $1::jsonb` という浅いマージのため、
ネストしたオブジェクトを持たせると部分更新のたびに未指定の他surfaceの値が消える
(jsonbの`||`はトップレベルのみマージし、ネストしたオブジェクトは丸ごと置換される)。
新しいsurfaceを追加する場合も同じくフラットキーで追加すること。

**3. surface→TriggerEngineマッピングは `SURFACE_TRIGGER_MAP` に一本化。**
`product_page`→`page_url_match{patterns:['/products/*']}` 等、Shopifyの標準URL構造
(shopify.dev)に基づく固定パターン。GETレスポンスの `triggers` フィールドは
このマップから導出した表示専用の値であり、DBに別途保存はしていない
(surfacesのboolean状態のみが真実、triggersは毎回再計算)。

**How to apply**: タスク03(OAuth)・埋め込み管理画面(`shopify-app/`)実装時、
このファイルの `authenticate()` を置き換える際は既存のGET/PATCH成功系テスト
(`shopifySettingsRoutes.test.ts`)のモック方式(`dbQuery.mockResolvedValueOnce`の
1呼び出し目=認証、2呼び出し目=データ取得/更新)を維持できるよう、新認証も
「1回のDB問い合わせでtenantIdを確定する」形に保つとテスト差分が最小になる。
