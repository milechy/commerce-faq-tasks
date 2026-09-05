// shopify-app/app/src/lib/shopifySession.ts
//
// この埋め込み管理画面が API 呼び出しに使う「shop ドメイン」「テナントID」を
// 解決するだけの薄いフック。ロジックは持たない(D9)。
//
// ★暫定実装であることの明記★
// src/api/widget/shopifySettingsRoutes.ts の authenticate() は現状(タスク03
// 「App Bridge Token Exchange」着手前)、x-shopify-shop-domain と x-tenant-id の
// 組み合わせをそのまま照合するだけの暫定認証になっている。Shopify のセッション
// トークン(shopify.idToken())には R2C 内部のテナントIDが含まれないため、
// 「shopドメイン→テナントID」を解決する専用APIが無い現時点では、
// Shopify Admin が埋め込みアプリに渡すURLクエリパラメータ(shop)と、
// OAuth完了後にこのアプリへ渡される tenant_id クエリパラメータから読み取る
// 以外に手段が無い。
//
// タスク03完了後は、ここを shopify.idToken() で取得したセッショントークンを
// Authorization: Bearer で送る方式に置き換える想定(このファイルの責務は
// 「session を解決する」ことだけなので、置き換えの影響はこのファイルに閉じる)。
//
// このタスク(11. 埋め込み管理画面実装)の制約により、shop→tenantId解決APIの
// 新設は行わない(src/ には一切手を入れない)。

import { useEffect, useState } from "react";

export interface ShopifySession {
  shopDomain: string;
  tenantId: string;
}

export type ShopifySessionState =
  | { status: "loading" }
  | { status: "ready"; session: ShopifySession }
  | { status: "missing" };

function readFromLocation(): ShopifySession | null {
  const params = new URLSearchParams(window.location.search);
  const shopDomain = params.get("shop");
  const tenantId = params.get("tenant_id");
  if (!shopDomain || !tenantId) return null;
  return { shopDomain, tenantId };
}

export function useShopifySession(): ShopifySessionState {
  const [state, setState] = useState<ShopifySessionState>({ status: "loading" });

  useEffect(() => {
    const session = readFromLocation();
    setState(session ? { status: "ready", session } : { status: "missing" });
  }, []);

  return state;
}
