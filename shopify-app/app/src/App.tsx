// shopify-app/app/src/App.tsx
//
// 埋め込み管理画面のルート。ロジックは持たない — session を解決し、
// GET /v1/public/shopify/settings を1回呼び、その結果をそのまま各カードに渡すだけ。
// 表示面のON/OFF・課金状態・プラン判定はすべてサーバ側(shopifySettingsRoutes.ts)が
// 真実であり、このファイルでは計算・分岐条件の合成を行わない(D9)。

import { useEffect, useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";
import { useShopifySession } from "./lib/shopifySession";
import type { ShopifySession } from "./lib/shopifySession";
import { fetchShopifySettings, ShopifySettingsApiError } from "./lib/settingsClient";
import type { ShopifySettings } from "./types";
import { ConnectionStatusCard } from "./components/ConnectionStatusCard";
import { SurfaceSelector } from "./components/SurfaceSelector";
import { NextStepsCard } from "./components/NextStepsCard";
import { NotConnectedBanner } from "./components/NotConnectedBanner";
import "./styles.css";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; settings: ShopifySettings }
  | { status: "error"; message: string };

function useSettings(session: ShopifySession | null): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading" });

    fetchShopifySettings(session)
      .then((settings) => {
        if (!cancelled) setState({ status: "loaded", settings });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // HTTPの意味を潰さず、サーバが返した日本語メッセージをそのまま使う(FR-11)。
        const message =
          err instanceof ShopifySettingsApiError
            ? (err.body?.message ?? "設定の取得に失敗しました。時間をおいてもう一度お試しください。")
            : "R2C サーバーに接続できませんでした。時間をおいてもう一度お試しください。";
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
    // session はプリミティブ2値の組でしか変化しない想定のため、値そのものを依存にする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.shopDomain, session?.tenantId]);

  return state;
}

export function App() {
  const sessionState = useShopifySession();
  const session = sessionState.status === "ready" ? sessionState.session : null;
  const load = useSettings(session);

  return (
    <main className="r2c-app">
      <TitleBar title="R2C – AI Sales Concierge" />

      {sessionState.status === "loading" && <p className="r2c-loading">読み込んでいます…</p>}

      {sessionState.status === "missing" && (
        <NotConnectedBanner message="ストアとの接続情報を確認できませんでした。Shopify 管理画面からもう一度アプリを開いてください。" />
      )}

      {sessionState.status === "ready" && load.status === "loading" && (
        <p className="r2c-loading">読み込んでいます…</p>
      )}

      {sessionState.status === "ready" && load.status === "error" && (
        <NotConnectedBanner message={load.message} />
      )}

      {sessionState.status === "ready" && load.status === "loaded" && (
        <AppBridgeSettingsView session={session as ShopifySession} settings={load.settings} />
      )}
    </main>
  );
}

function AppBridgeSettingsView({
  session,
  settings,
}: {
  session: ShopifySession;
  settings: ShopifySettings;
}) {
  const [current, setCurrent] = useState(settings);

  return (
    <>
      {/* 未接続/未設定時の案内は画面内でこの1箇所に限定する(FR-10)。 */}
      {!current.is_active && (
        <NotConnectedBanner message="現在チャットは稼働していません。Shopify のプランや課金の承認状況をご確認ください。" />
      )}
      <ConnectionStatusCard settings={current} />
      <SurfaceSelector session={session} settings={current} onUpdated={setCurrent} />
      <NextStepsCard settings={current} />
    </>
  );
}
