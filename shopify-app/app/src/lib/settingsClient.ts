// shopify-app/app/src/lib/settingsClient.ts
//
// GET/PATCH /v1/public/shopify/settings を呼ぶだけの薄いクライアント。
// 表示面選択・オフセット等のロジック(値域チェック等)は一切ここに持たない —
// すべてサーバ側(src/api/widget/shopifySettingsRoutes.ts、widgetPlacement.ts)が
// 唯一の真実(D9)。ここではリクエストの組み立てとエラー形状の解釈のみを行う。

import { API_BASE_URL } from "./config";
import type { ApiErrorBody, ShopifySettings, ShopifySettingsPatch } from "../types";
import type { ShopifySession } from "./shopifySession";

const SETTINGS_PATH = "/v1/public/shopify/settings";

/** サーバの { error, message } 形式をそのまま保持する例外(CLAUDE.md エラー方針に沿い、HTTPの意味を潰さない)。 */
export class ShopifySettingsApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? `request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

function buildHeaders(session: ShopifySession, withJsonBody: boolean): HeadersInit {
  const headers: Record<string, string> = {
    "x-shopify-shop-domain": session.shopDomain,
    "x-tenant-id": session.tenantId,
  };
  if (withJsonBody) headers["Content-Type"] = "application/json";
  return headers;
}

async function parseJsonSafely(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchShopifySettings(session: ShopifySession): Promise<ShopifySettings> {
  const res = await fetch(`${API_BASE_URL}${SETTINGS_PATH}`, {
    method: "GET",
    headers: buildHeaders(session, false),
  });
  const body = await parseJsonSafely(res);
  if (!res.ok) {
    throw new ShopifySettingsApiError(res.status, body as ApiErrorBody | null);
  }
  return body as ShopifySettings;
}

export async function patchShopifySettings(
  session: ShopifySession,
  patch: ShopifySettingsPatch
): Promise<ShopifySettings> {
  const res = await fetch(`${API_BASE_URL}${SETTINGS_PATH}`, {
    method: "PATCH",
    headers: buildHeaders(session, true),
    body: JSON.stringify(patch),
  });
  const body = await parseJsonSafely(res);
  if (!res.ok) {
    throw new ShopifySettingsApiError(res.status, body as ApiErrorBody | null);
  }
  return body as ShopifySettings;
}
