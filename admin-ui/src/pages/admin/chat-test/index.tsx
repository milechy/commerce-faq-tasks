import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";
import { API_BASE, authFetch } from "../../../lib/api";

interface TenantOption {
  id: string;
  name: string;
}

interface ChatTestToken {
  token: string;
  tenantId: string;
  expiresIn: number;
}

async function fetchChatTestToken(tenantId: string): Promise<ChatTestToken> {
  const res = await authFetch(
    `${API_BASE}/v1/admin/chat-test/token?tenantId=${encodeURIComponent(tenantId)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<ChatTestToken>;
}

export default function ChatTestPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user, isSuperAdmin, previewMode, previewTenantId, previewTenantName } = useAuth();

  // テナント選択 (Super Admin 用)
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantFetchError, setTenantFetchError] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");

  // トークン状態
  const [token, setToken] = useState<string | null>(null);
  const [gettingToken, setGettingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const tokenExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ウィジェット
  const widgetScriptRef = useRef<HTMLScriptElement | null>(null);

  // プレビューモード中は previewTenantId を使用（super_admin の role が client_admin に上書きされるため）
  const effectiveTenantId = isSuperAdmin
    ? selectedTenantId
    : (user?.tenantId ?? (previewMode ? (previewTenantId ?? "") : ""));
  const displayTenantName = isSuperAdmin
    ? (tenants.find((ten) => ten.id === selectedTenantId)?.name ?? selectedTenantId)
    : (previewMode ? (previewTenantName ?? effectiveTenantId) : (user?.tenantName ?? effectiveTenantId));

  // ウィジェット cleanup
  const cleanupWidget = useCallback(() => {
    const host = document.getElementById("faq-chat-widget-host");
    if (host) host.remove();
    if (widgetScriptRef.current) {
      widgetScriptRef.current.remove();
      widgetScriptRef.current = null;
    }
  }, []);

  // Super Admin: テナント一覧取得
  useEffect(() => {
    if (!isSuperAdmin) return;
    setTenantFetchError(false);
    void authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { tenants?: TenantOption[] }) => {
        setTenants(data.tenants ?? []);
      })
      .catch(() => { setTenantFetchError(true); });
  }, [isSuperAdmin]);

  // テナントが確定したら自動でトークン取得
  useEffect(() => {
    if (!effectiveTenantId) return;

    // クリーンアップ
    cleanupWidget();
    setToken(null);
    setTokenError(null);
    if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);

    setGettingToken(true);
    void fetchChatTestToken(effectiveTenantId)
      .then((result) => {
        setToken(result.token);
        setGettingToken(false);
        // 期限切れタイマー（expiresIn 秒後に警告）
        tokenExpiryRef.current = setTimeout(() => {
          setToken(null);
          setTokenError(t("chat_test.token_expired"));
          cleanupWidget();
        }, result.expiresIn * 1000);
      })
      .catch((err: Error) => {
        setTokenError(err.message || t("chat_test.token_error"));
        setGettingToken(false);
      });

    return () => {
      if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTenantId]);

  // トークン取得後にウィジェット起動
  useEffect(() => {
    if (!token || !effectiveTenantId) return;

    cleanupWidget();

    const script = document.createElement("script");
    script.src = `${API_BASE}/widget.js`;
    script.setAttribute("data-tenant", effectiveTenantId);
    script.setAttribute("data-api-key", token);
    script.async = true;
    widgetScriptRef.current = script;
    document.body.appendChild(script);

    return cleanupWidget;
  }, [token, effectiveTenantId, cleanupWidget]);

  // アンマウント時クリーンアップ
  useEffect(() => {
    return () => {
      cleanupWidget();
      if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    };
  }, [cleanupWidget]);

  const handleTenantChange = (newTenantId: string) => {
    setSelectedTenantId(newTenantId);
  };

  const handleReload = () => {
    if (!effectiveTenantId) return;
    setToken(null);
    setTokenError(null);
    if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    cleanupWidget();

    setGettingToken(true);
    void fetchChatTestToken(effectiveTenantId)
      .then((result) => {
        setToken(result.token);
        setGettingToken(false);
        tokenExpiryRef.current = setTimeout(() => {
          setToken(null);
          setTokenError(t("chat_test.token_expired"));
          cleanupWidget();
        }, result.expiresIn * 1000);
      })
      .catch((err: Error) => {
        setTokenError(err.message || t("chat_test.token_error"));
        setGettingToken(false);
      });
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
            {tenantFetchError ? (
              <div style={{ color: "#fca5a5", fontSize: 14, padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(248,113,113,0.3)", background: "rgba(127,29,29,0.3)" }}>
                ⚠️ テナント一覧の取得に失敗しました。ページを再読み込みしてください。
              </div>
            ) : (
              <select
                value={selectedTenantId}
                onChange={(e) => handleTenantChange(e.target.value)}
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
            )}
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

            {/* トークン取得中 */}
            {gettingToken && (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#6b7280", fontSize: 15 }}>
                <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
                {t("chat_test.getting_token")}
              </div>
            )}

            {/* エラー（期限切れ含む） */}
            {tokenError && (
              <div
                style={{
                  marginBottom: 20,
                  padding: "16px 20px",
                  borderRadius: 12,
                  background: "rgba(127,29,29,0.4)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  color: "#fca5a5",
                  fontSize: 14,
                }}
              >
                <div style={{ marginBottom: 12 }}>⚠️ {tokenError}</div>
                <button
                  onClick={handleReload}
                  style={{
                    padding: "10px 18px",
                    minHeight: 44,
                    borderRadius: 8,
                    border: "1px solid rgba(248,113,113,0.4)",
                    background: "rgba(248,113,113,0.1)",
                    color: "#fca5a5",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  🔄 {t("common.retry")}
                </button>
              </div>
            )}

            {/* ウィジェット起動済み */}
            {token && !gettingToken && (
              <>
                <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 15, marginBottom: 16 }}>
                  👇 右下のボタンからチャットを開けます
                </p>
                <div style={{ textAlign: "center" }}>
                  <button
                    onClick={handleReload}
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
