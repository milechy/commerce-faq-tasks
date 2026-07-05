import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useAdminAgentUI } from "../contexts/AdminAgentUIContext";
import { authFetch, API_BASE } from "../lib/api";
import { supabase } from "../lib/supabaseClient";

const AAAS_ADMIN_URL = import.meta.env.VITE_AAAS_ADMIN_URL as string | undefined;

/** Hand off the current Supabase session to R2C2 (AaaS) via /auth/bridge.
 *
 * Both apps share the same Supabase project but have no shared session
 * mechanism (each app's session lives in its own origin's localStorage) —
 * so switching passes the access/refresh token pair through the URL
 * fragment (never sent to a server) rather than requiring a shared
 * cookie domain.
 */
async function bridgeToR2C2() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session || !AAAS_ADMIN_URL) return;
  const hash = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  }).toString();
  window.location.href = `${AAAS_ADMIN_URL}/auth/bridge#${hash}`;
}

export default function AppSwitcher() {
  const { isSuperAdmin, isLoading } = useAuth();
  const { openWithQuery } = useAdminAgentUI();
  const [hasR2c2, setHasR2c2] = useState(isSuperAdmin);

  useEffect(() => {
    // 認証ロード完了前は isSuperAdmin が一時的に false になる。ここで確定前に
    // fetch すると super_admin でも /v1/admin/my-tenant が 403 になり、後から
    // その古い応答が isSuperAdmin=true 判定後の setHasR2c2(true) を上書きしてしまう
    // (race condition)。ロード完了を待ち、かつ ignore フラグで古い応答を捨てる。
    if (isLoading) return;
    if (isSuperAdmin) {
      setHasR2c2(true);
      return;
    }
    let ignore = false;
    authFetch(`${API_BASE}/v1/admin/my-tenant`)
      .then((r) => r.json())
      .then((data: { has_r2c2?: boolean }) => {
        if (!ignore) setHasR2c2(Boolean(data.has_r2c2));
      })
      .catch(() => {
        if (!ignore) setHasR2c2(false);
      });
    return () => {
      ignore = true;
    };
  }, [isSuperAdmin, isLoading]);

  if (!AAAS_ADMIN_URL) return null;

  return (
    <div style={{ display: "flex", borderRadius: 9999, background: "var(--sidebar-accent)", padding: 3, gap: 2 }}>
      <span
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 9999,
          fontSize: 12,
          fontWeight: 700,
          background: "var(--card)",
          color: "var(--primary)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
        R2C
      </span>
      <button
        onClick={() => (hasR2c2 ? void bridgeToR2C2() : openWithQuery("R2C2について教えて"))}
        title={hasR2c2 ? "R2C2に切り替え" : "R2C2とは？ AIアシスタントに聞いてみる"}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 9999,
          fontSize: 12,
          fontWeight: 700,
          border: "none",
          background: "transparent",
          color: hasR2c2 ? "var(--muted-foreground)" : "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
          cursor: "pointer",
        }}
      >
        R2C2{!hasR2c2 && " 🔒"}
      </button>
    </div>
  );
}
