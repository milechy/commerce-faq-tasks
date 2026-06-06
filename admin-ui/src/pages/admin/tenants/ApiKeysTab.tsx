import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ApiKeyCreateModal from "../../../components/ApiKeyCreateModal";
import { useLang } from "../../../i18n/LangContext";
import { authFetch, API_BASE } from "../../../lib/api";
import type { ApiKey } from "./types";
import { CARD_STYLE } from "./types";

export async function fetchApiKeys(tenantId: string): Promise<ApiKey[]> {
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    keys?: Array<{ id: string; key_prefix: string; prefix?: string; is_active: boolean; created_at: string; last_used_at: string | null }>;
  };
  return (data.keys ?? []).map((k) => ({
    id: k.id,
    maskedKey: k.prefix ?? (k.key_prefix + "****"),
    status: k.is_active ? "active" : "revoked",
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
  }));
}

async function revokeApiKey(tenantId: string, keyId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys/${keyId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export default function ApiKeysTab({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copiedPrefixId, setCopiedPrefixId] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchApiKeys(tenantId);
        setKeys(data);
      } catch (err) {
        if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
          navigate("/login", { replace: true });
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [tenantId, navigate]);

  const handleRevoke = async (keyId: string) => {
    if (!window.confirm(t("tenant_detail.revoke_confirm"))) return;
    setRevoking(keyId);
    try {
      await revokeApiKey(tenantId, keyId);
      setKeys((prev) =>
        prev.map((k) => (k.id === keyId ? { ...k, status: "revoked" as const } : k))
      );
      showToast(t("tenant_detail.revoke_success"));
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      showToast(t("tenant_detail.revoke_error"));
    } finally {
      setRevoking(null);
    }
  };

  const handleKeyIssued = (newKey: string) => {
    const newEntry: ApiKey = {
      id: `k_${Date.now()}`,
      maskedKey: `${newKey.slice(0, 16)}...****`,
      status: "active",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    setKeys((prev) => [newEntry, ...prev]);
    showToast(t("tenant_detail.key_issued"));
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div>
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "14px 24px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.98)",
            border: "1px solid #22c55e",
            color: "#4ade80",
            fontSize: 15,
            fontWeight: 600,
            zIndex: 2000,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}

      <button
        onClick={() => setShowModal(true)}
        style={{
          width: "100%",
          padding: "16px 24px",
          minHeight: 56,
          borderRadius: 12,
          border: "none",
          background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 16,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          marginBottom: 20,
        }}
      >
        {t("tenant_detail.issue_key")}
      </button>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 80,
            color: "#9ca3af",
            fontSize: 15,
          }}
        >
          <span style={{ marginRight: 8 }}>⏳</span>
          {t("tenant_detail.key_loading")}
        </div>
      ) : keys.length === 0 ? (
        <div
          style={{
            ...CARD_STYLE,
            textAlign: "center",
            color: "#6b7280",
            fontSize: 15,
            padding: "32px 20px",
          }}
        >
          {t("tenant_detail.key_empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {keys.map((key) => (
            <div
              key={key.id}
              style={{
                ...CARD_STYLE,
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <button
                    title="プレフィックスをコピー（識別用）"
                    onClick={() => {
                      const prefix = key.maskedKey;
                      const doCopy = async () => {
                        let ok = false;
                        try {
                          await navigator.clipboard.writeText(prefix);
                          ok = true;
                        } catch {
                          try {
                            const inp = document.createElement("input");
                            inp.value = prefix;
                            inp.style.position = "fixed";
                            inp.style.opacity = "0";
                            document.body.appendChild(inp);
                            inp.select();
                            ok = document.execCommand("copy");
                            document.body.removeChild(inp);
                          } catch { /* ignore */ }
                        }
                        if (ok) {
                          setCopiedPrefixId(key.id);
                          setTimeout(() => setCopiedPrefixId(null), 2000);
                        }
                      };
                      void doCopy();
                    }}
                    style={{
                      fontFamily: "monospace",
                      fontSize: 14,
                      color: copiedPrefixId === key.id ? "#4ade80" : "#86efac",
                      wordBreak: "break-all",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "copy",
                      textAlign: "left",
                    }}
                  >
                    {copiedPrefixId === key.id ? "✅ コピー済み" : key.maskedKey}
                  </button>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      background: key.status === "active" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                      color: key.status === "active" ? "#4ade80" : "#f87171",
                      border: `1px solid ${key.status === "active" ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {key.status === "active" ? t("tenant_detail.key_status_active") : t("tenant_detail.key_status_revoked")}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span>{t("tenant_detail.key_created_at", { date: formatDate(key.createdAt) })}</span>
                  <span>
                    {key.lastUsedAt
                      ? t("tenant_detail.key_last_used", { date: formatDate(key.lastUsedAt) })
                      : t("tenant_detail.key_never_used")}
                  </span>
                </div>
              </div>

              {key.status === "active" && (
                <button
                  onClick={() => handleRevoke(key.id)}
                  disabled={revoking === key.id}
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid rgba(239,68,68,0.4)",
                    background: "rgba(239,68,68,0.1)",
                    color: "#f87171",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: revoking === key.id ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {revoking === key.id ? t("tenant_detail.revoking") : t("tenant_detail.revoke")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <ApiKeyCreateModal
          tenantId={tenantId}
          onClose={() => setShowModal(false)}
          onSuccess={handleKeyIssued}
        />
      )}
    </div>
  );
}
