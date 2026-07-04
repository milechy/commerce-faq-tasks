import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

/**
 * One-time token bridge for the App Switcher (R2C ⇄ R2C2).
 *
 * Neither app shares a session mechanism the other can read directly — each
 * app's Supabase client keeps its session in localStorage, which is
 * per-origin and does not cross subdomains. So switching apps hands off the
 * CURRENT app's access/refresh token pair via the URL fragment (never sent
 * to any server, unlike a query string) to the target app's /auth/bridge
 * route, which calls supabase.auth.setSession() to establish its own local
 * session — both apps share the same Supabase project, so the token is
 * valid on either side.
 */
export default function AuthBridgePage() {
  const [status, setStatus] = useState<"pending" | "ok" | "error">("pending");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (!accessToken || !refreshToken) {
      setStatus("error");
      return;
    }

    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => setStatus(error ? "error" : "ok"))
      .catch(() => setStatus("error"));
  }, []);

  if (status === "ok") return <Navigate to="/admin" replace />;

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#111827", color: "#e5e7eb" }}>
      {status === "pending" ? (
        <p style={{ fontSize: 14, color: "#9ca3af" }}>切り替え中...</p>
      ) : (
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "#fca5a5", marginBottom: 12 }}>セッションの引き継ぎに失敗しました</p>
          <a href="/login" style={{ fontSize: 13, color: "#60a5fa" }}>ログイン画面へ</a>
        </div>
      )}
    </div>
  );
}
