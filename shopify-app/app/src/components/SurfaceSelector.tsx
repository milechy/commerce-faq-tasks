// shopify-app/app/src/components/SurfaceSelector.tsx
//
// 表示面選択UI(FR-06)。商品ページ/カート/配送ポリシーページのチェックボックス。
//
// ★このチェックボックスの値が「表示面選択の真実」そのもの(D18)★
// Theme App Extension(shopify-app/extensions/、別タスク12)側は ON/OFF と
// 表示位置(オフセット)のみを持ち、商品ページ/カート/配送ポリシーといった
// 面の詳細選択はここにしか持たせない。テーマを切り替えても、この設定は
// テーマに紐付かず R2C 側 DB(tenants.widget_theme)に残り続ける
// (shopifySettingsRoutes.ts のコメント、D9/D18参照)。
//
// このコンポーネント自身は判定ロジック(どのURLパターンに対応するか等)を
// 一切持たない。チェックボックスの真偽値をそのまま PATCH で送るだけで、
// トリガー種別へのマッピング(page_url_match への変換)はサーバ側の責務。

import { useState } from "react";
import type { ShopifySettings, ShopifySurface } from "../types";
import { SHOPIFY_SURFACES } from "../types";
import { patchShopifySettings, ShopifySettingsApiError } from "../lib/settingsClient";
import type { ShopifySession } from "../lib/shopifySession";

const SURFACE_LABELS: Record<ShopifySurface, string> = {
  product_page: "商品ページ",
  cart: "カート",
  shipping_policy: "配送ポリシーページ",
};

interface Props {
  session: ShopifySession;
  settings: ShopifySettings;
  onUpdated: (next: ShopifySettings) => void;
}

export function SurfaceSelector({ session, settings, onUpdated }: Props) {
  const [pendingSurface, setPendingSurface] = useState<ShopifySurface | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(surface: ShopifySurface, checked: boolean): Promise<void> {
    setPendingSurface(surface);
    setError(null);
    try {
      const next = await patchShopifySettings(session, { surfaces: { [surface]: checked } });
      onUpdated(next);
    } catch (err) {
      // エラー時は解決方法を伴うメッセージを出す(FR-11)。次に何をすればよいかを書く。
      setError(
        err instanceof ShopifySettingsApiError
          ? (err.body?.message ?? "保存に失敗しました。時間をおいてもう一度お試しください。")
          : "保存に失敗しました。通信状況をご確認のうえ、もう一度お試しください。"
      );
    } finally {
      setPendingSurface(null);
    }
  }

  return (
    <section className="r2c-card" aria-label="表示面の選択">
      <h2 className="r2c-card__title">チャットを表示する場所</h2>
      <p className="r2c-card__desc">
        チェックした場所にだけチャットが表示されます。保存は自動で行われ、次回のページ表示から反映されます。
      </p>
      <ul className="r2c-surface-list">
        {SHOPIFY_SURFACES.map((surface) => (
          <li key={surface} className="r2c-surface-list__item">
            <label className="r2c-checkbox">
              <input
                type="checkbox"
                checked={settings.surfaces[surface]}
                disabled={pendingSurface !== null}
                onChange={(e) => {
                  void handleToggle(surface, e.target.checked);
                }}
              />
              <span>{SURFACE_LABELS[surface]}</span>
              {pendingSurface === surface && <span className="r2c-inline-status">保存中…</span>}
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p className="r2c-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
