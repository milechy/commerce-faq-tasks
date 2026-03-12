import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";
import { API_BASE } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed.session?.access_token ?? null;
}

async function fetchFirstActiveKey(tenantId: string): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { keys?: Array<{ status: string; maskedKey?: string }>; items?: Array<{ status: string; maskedKey?: string }> };
    const keys = data.keys ?? data.items ?? [];
    const active = keys.find((k) => k.status === "active");
    return active ? (active.maskedKey ?? null) : null;
  } catch {
    return null;
  }
}

export default function ChatTestPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user, previewMode, previewTenantId } = useAuth();
  const [started, setStarted] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const widgetContainerRef = useRef<HTMLDivElement>(null);
  const widgetScriptRef = useRef<HTMLScriptElement | null>(null);

  const effectiveTenantId = previewMode && previewTenantId ? previewTenantId : (user?.tenantId ?? "demo");
  const displayTenantName = user?.tenantName ?? effectiveTenantId;

  // APIキー存在確認
  useEffect(() => {
    if (!started) return;
    void fetchFirstActiveKey(effectiveTenantId).then((key) => {
      setHasApiKey(key !== null);
    });
  }, [started, effectiveTenantId]);

  // widget.js 埋め込み
  useEffect(() => {
    if (!started) return;

    // 既存のウィジェットホストをクリーンアップ
    const cleanup = () => {
      const existingHost = document.getElementById("faq-chat-widget-host");
      if (existingHost) existingHost.remove();
      if (widgetScriptRef.current) {
        widgetScriptRef.current.remove();
        widgetScriptRef.current = null;
      }
    };

    cleanup();

    const script = document.createElement("script");
    script.src = `${API_BASE}/widget.js`;
    script.setAttribute("data-tenant", effectiveTenantId);
    script.setAttribute("data-api-key", "");
    script.async = true;
    widgetScriptRef.current = script;

    document.body.appendChild(script);

    return cleanup;
  }, [started, effectiveTenantId]);

  const handleReset = () => {
    // ウィジェット削除してリセット
    const existingHost = document.getElementById("faq-chat-widget-host");
    if (existingHost) existingHost.remove();
    if (widgetScriptRef.current) {
      widgetScriptRef.current.remove();
      widgetScriptRef.current = null;
    }
    setStarted(false);
    setHasApiKey(null);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
        <button
          onClick={() => navigate("/admin")}
          style={{
            padding: "10px 16px",
            minHeight: 44,
            borderRadius: 999,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 14,
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {t("common.back_to_dashboard")}
        </button>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("chat_test.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("chat_test.description")}
          </p>
        </div>
      </header>

      <section
        style={{
          borderRadius: 16,
          border: "1px solid #1f2937",
          background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          padding: "32px 24px",
          textAlign: "center",
        }}
      >
        {!started ? (
          <>
            <div style={{ fontSize: 64, marginBottom: 16 }}>💬</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", marginBottom: 8 }}>
              {t("chat_test.title")}
            </h2>
            <p style={{ fontSize: 15, color: "#9ca3af", marginBottom: 32, maxWidth: 400, margin: "0 auto 32px" }}>
              {t("chat_test.description")}
            </p>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 24 }}>
              {t("chat_test.tenant_label")}: <strong style={{ color: "#9ca3af" }}>{displayTenantName}</strong>
            </p>
            <button
              onClick={() => setStarted(true)}
              style={{
                padding: "18px 40px",
                minHeight: 56,
                borderRadius: 12,
                border: "none",
                background: "linear-gradient(135deg, #3b82f6 0%, #60a5fa 50%, #3b82f6 100%)",
                color: "#fff",
                fontSize: 18,
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 8px 25px rgba(59,130,246,0.35)",
              }}
            >
              {t("chat_test.start")}
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 12 }}>
              {t("chat_test.tenant_label")}: <strong style={{ color: "#9ca3af" }}>{displayTenantName}</strong>
            </p>

            {hasApiKey === false && (
              <div
                style={{
                  marginBottom: 20,
                  padding: "14px 18px",
                  borderRadius: 12,
                  background: "rgba(120,53,15,0.3)",
                  border: "1px solid rgba(251,191,36,0.3)",
                  color: "#fbbf24",
                  fontSize: 14,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                ⚠️ {t("chat_test.need_api_key")}
              </div>
            )}

            {/* ウィジェット表示エリア — widget.js が Shadow DOM を body に追加 */}
            <div
              ref={widgetContainerRef}
              style={{
                width: "100%",
                maxWidth: 420,
                minHeight: 120,
                margin: "0 auto 16px",
                borderRadius: 12,
                border: "1px dashed #374151",
                padding: "20px",
                color: "#4b5563",
                fontSize: 13,
              }}
            >
              <span>↘ {t("chat_test.widget_placeholder")}</span>
            </div>

            <button
              onClick={handleReset}
              style={{
                marginTop: 8,
                padding: "12px 24px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {t("chat_test.reset")}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
