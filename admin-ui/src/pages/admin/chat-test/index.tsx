import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";
import { API_BASE, authFetch } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";

interface TenantOption {
  id: string;
  name: string;
}

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed.session?.access_token ?? null;
}

async function checkHasActiveKey(tenantId: string): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { keys?: Array<{ is_active: boolean }> };
    return (data.keys ?? []).some((k) => k.is_active);
  } catch {
    return false;
  }
}

export default function ChatTestPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user, isSuperAdmin } = useAuth();

  // テナント選択（Super Admin 用）
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>(
    isSuperAdmin ? "" : (user?.tenantId ?? "")
  );

  // APIキー確認
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [checkingKey, setCheckingKey] = useState(false);

  // APIキー入力 & ウィジェット
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [started, setStarted] = useState(false);
  const widgetScriptRef = useRef<HTMLScriptElement | null>(null);

  const effectiveTenantId = isSuperAdmin ? selectedTenantId : (user?.tenantId ?? "");
  const displayTenantName =
    isSuperAdmin
      ? (tenants.find((t) => t.id === selectedTenantId)?.name ?? selectedTenantId)
      : (user?.tenantName ?? effectiveTenantId);

  // Super Admin: テナント一覧取得
  useEffect(() => {
    if (!isSuperAdmin) return;
    void authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tenants?: TenantOption[] } | null) => {
        if (data?.tenants) setTenants(data.tenants);
      })
      .catch(() => {});
  }, [isSuperAdmin]);

  // テナントが確定したらAPIキー存在確認
  useEffect(() => {
    if (!effectiveTenantId) {
      setHasApiKey(null);
      return;
    }
    setCheckingKey(true);
    setHasApiKey(null);
    void checkHasActiveKey(effectiveTenantId).then((has) => {
      setHasApiKey(has);
      setCheckingKey(false);
    });
  }, [effectiveTenantId]);

  // ウィジェット埋め込み（started かつ apiKeyInput が設定済みの場合のみ）
  useEffect(() => {
    if (!started || !apiKeyInput) return;

    const cleanup = () => {
      const host = document.getElementById("faq-chat-widget-host");
      if (host) host.remove();
      if (widgetScriptRef.current) {
        widgetScriptRef.current.remove();
        widgetScriptRef.current = null;
      }
    };

    cleanup();

    const script = document.createElement("script");
    script.src = `${API_BASE}/widget.js`;
    script.setAttribute("data-tenant", effectiveTenantId);
    script.setAttribute("data-api-key", apiKeyInput.trim());
    script.async = true;
    widgetScriptRef.current = script;
    document.body.appendChild(script);

    return cleanup;
  }, [started, apiKeyInput, effectiveTenantId]);

  const handleReset = () => {
    const host = document.getElementById("faq-chat-widget-host");
    if (host) host.remove();
    if (widgetScriptRef.current) {
      widgetScriptRef.current.remove();
      widgetScriptRef.current = null;
    }
    setStarted(false);
    setApiKeyInput("");
  };

  const handleLaunch = () => {
    if (!apiKeyInput.trim()) return;
    setStarted(true);
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
        }}
      >
        {/* ─── Super Admin: テナント選択ドロップダウン ─── */}
        {isSuperAdmin && (
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 8 }}>
              {t("chat_test.select_tenant")}
            </label>
            <select
              value={selectedTenantId}
              onChange={(e) => {
                setSelectedTenantId(e.target.value);
                setStarted(false);
                setApiKeyInput("");
              }}
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: 10,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.9)",
                color: "#e5e7eb",
                fontSize: 15,
                outline: "none",
                cursor: "pointer",
              }}
            >
              <option value="">— テナントを選択 —</option>
              {tenants.map((ten) => (
                <option key={ten.id} value={ten.id}>
                  {ten.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* ─── テナント未選択 ─── */}
        {!effectiveTenantId && (
          <p style={{ textAlign: "center", color: "#6b7280", fontSize: 15, padding: "32px 0" }}>
            {t("chat_test.select_tenant")}
          </p>
        )}

        {/* ─── テナント選択済み ─── */}
        {effectiveTenantId && (
          <>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 20 }}>
              {t("chat_test.tenant_label")}:{" "}
              <strong style={{ color: "#9ca3af" }}>{displayTenantName}</strong>
            </p>

            {/* APIキー確認中 */}
            {checkingKey && (
              <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 16 }}>
                {t("chat_test.checking")}
              </p>
            )}

            {/* APIキー未発行 */}
            {!checkingKey && hasApiKey === false && (
              <div
                style={{
                  marginBottom: 24,
                  padding: "16px 20px",
                  borderRadius: 12,
                  background: "rgba(120,53,15,0.3)",
                  border: "1px solid rgba(251,191,36,0.3)",
                  color: "#fbbf24",
                  fontSize: 14,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 10 }}>
                  ⚠️ {t("chat_test.no_api_key")}
                </div>
                {isSuperAdmin ? (
                  <button
                    onClick={() => navigate(`/admin/tenants/${effectiveTenantId}`)}
                    style={{
                      padding: "10px 18px",
                      minHeight: 44,
                      borderRadius: 8,
                      border: "1px solid rgba(251,191,36,0.5)",
                      background: "rgba(251,191,36,0.1)",
                      color: "#fbbf24",
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    🔑 {t("chat_test.issue_api_key")}
                  </button>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: "#d97706" }}>
                    管理者にAPIキーの発行を依頼してください。
                  </p>
                )}
              </div>
            )}

            {/* APIキー入力欄（発行済みの場合のみ表示） */}
            {!checkingKey && hasApiKey === true && !started && (
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>
                  {t("chat_test.api_key_label")}
                </label>
                <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, marginTop: 0 }}>
                  {t("chat_test.api_key_hint")}
                </p>
                <div style={{ display: "flex", gap: 10 }}>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleLaunch(); }}
                    placeholder={t("chat_test.api_key_placeholder")}
                    style={{
                      flex: 1,
                      padding: "14px 16px",
                      borderRadius: 10,
                      border: "1px solid #374151",
                      background: "rgba(15,23,42,0.9)",
                      color: "#e5e7eb",
                      fontSize: 15,
                      outline: "none",
                      fontFamily: "monospace",
                    }}
                  />
                  <button
                    onClick={handleLaunch}
                    disabled={!apiKeyInput.trim()}
                    style={{
                      padding: "14px 24px",
                      minHeight: 48,
                      borderRadius: 10,
                      border: "none",
                      background: apiKeyInput.trim()
                        ? "linear-gradient(135deg, #3b82f6 0%, #60a5fa 50%, #3b82f6 100%)"
                        : "#1f2937",
                      color: apiKeyInput.trim() ? "#fff" : "#4b5563",
                      fontSize: 15,
                      fontWeight: 700,
                      cursor: apiKeyInput.trim() ? "pointer" : "not-allowed",
                      whiteSpace: "nowrap",
                    }}
                  >
                    💬 {t("chat_test.launch")}
                  </button>
                </div>
              </div>
            )}

            {/* ウィジェット起動済み */}
            {started && (
              <>
                <div
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
                    textAlign: "center",
                  }}
                >
                  <span>↘ {t("chat_test.widget_placeholder")}</span>
                </div>
                <div style={{ textAlign: "center" }}>
                  <button
                    onClick={handleReset}
                    style={{
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
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
