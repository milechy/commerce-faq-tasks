import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ApiKeyCreateModal from "../../../components/ApiKeyCreateModal";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
  createdAt: string;
  widgetTitle: string;
  widgetColor: string;
}

interface ApiKey {
  id: string;
  maskedKey: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

// ─── モックデータ ─────────────────────────────────────────────────────────────

const MOCK_TENANT_DETAIL: TenantDetail = {
  id: "1",
  name: "カーネーション自動車",
  slug: "carnation",
  plan: "pro",
  status: "active",
  createdAt: "2024-01-15T00:00:00Z",
  widgetTitle: "カーネーション自動車 AIアシスタント",
  widgetColor: "#22c55e",
};

const MOCK_API_KEYS: ApiKey[] = [
  { id: "k1", maskedKey: "rjc_live_xxxx...****", status: "active", createdAt: "2024-01-15T00:00:00Z", lastUsedAt: "2024-03-10T00:00:00Z" },
  { id: "k2", maskedKey: "rjc_live_yyyy...****", status: "revoked", createdAt: "2024-02-01T00:00:00Z", lastUsedAt: null },
];

// ─── API関数 ─────────────────────────────────────────────────────────────────

async function fetchTenantDetail(tenantId: string): Promise<TenantDetail> {
  // TODO: APIが完成したら fetchWithAuth(`${API_BASE}/v1/admin/tenants/${tenantId}`) に差し替え
  void tenantId;
  return { ...MOCK_TENANT_DETAIL, id: tenantId };
}

async function updateTenant(
  tenantId: string,
  data: { name: string; plan: "starter" | "pro"; status: "active" | "inactive" }
): Promise<TenantDetail> {
  // TODO: APIが完成したら fetchWithAuth(`${API_BASE}/v1/admin/tenants/${tenantId}`, { method: "PUT", ... }) に差し替え
  void tenantId;
  return { ...MOCK_TENANT_DETAIL, ...data, id: tenantId };
}

async function fetchApiKeys(tenantId: string): Promise<ApiKey[]> {
  // TODO: APIが完成したら fetchWithAuth(`${API_BASE}/v1/admin/tenants/${tenantId}/keys`) に差し替え
  void tenantId;
  return MOCK_API_KEYS;
}

async function revokeApiKey(tenantId: string, keyId: string): Promise<void> {
  // TODO: APIが完成したら fetchWithAuth(`${API_BASE}/v1/admin/tenants/${tenantId}/keys/${keyId}`, { method: "DELETE" }) に差し替え
  void tenantId;
  void keyId;
}

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(0,0,0,0.3)",
  color: "#f9fafb",
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#9ca3af",
  marginBottom: 6,
};

// ─── タブ: 設定 ───────────────────────────────────────────────────────────────

function SettingsTab({
  tenant,
  onSave,
}: {
  tenant: TenantDetail;
  onSave: (data: { name: string; plan: "starter" | "pro"; status: "active" | "inactive" }) => Promise<void>;
}) {
  const [name, setName] = useState(tenant.name);
  const [plan, setPlan] = useState<"starter" | "pro">(tenant.plan);
  const [status, setStatus] = useState<"active" | "inactive">(tenant.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), plan, status });
    } catch {
      setError("保存に失敗しました。もう一度お試しください 🙏");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave}>
      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "12px 16px",
            borderRadius: 10,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ ...CARD_STYLE, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <label style={LABEL_STYLE}>テナント名</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={INPUT_STYLE}
            required
          />
        </div>

        <div>
          <label style={LABEL_STYLE}>プラン</label>
          <div style={{ display: "flex", gap: 12 }}>
            {(["starter", "pro"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlan(p)}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: plan === p ? "1px solid #4ade80" : "1px solid #374151",
                  background: plan === p ? "rgba(34,197,94,0.15)" : "rgba(0,0,0,0.3)",
                  color: plan === p ? "#4ade80" : "#9ca3af",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {p === "starter" ? "Starter" : "Pro"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={LABEL_STYLE}>状態</label>
          <div style={{ display: "flex", gap: 12 }}>
            {(["active", "inactive"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: status === s ? `1px solid ${s === "active" ? "#4ade80" : "#9ca3af"}` : "1px solid #374151",
                  background: status === s
                    ? s === "active" ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.15)"
                    : "rgba(0,0,0,0.3)",
                  color: status === s
                    ? s === "active" ? "#4ade80" : "#d1d5db"
                    : "#9ca3af",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {s === "active" ? "有効" : "無効"}
              </button>
            ))}
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          style={{
            padding: "16px 24px",
            minHeight: 56,
            borderRadius: 12,
            border: "none",
            background: saving
              ? "rgba(34,197,94,0.3)"
              : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
            color: "#022c22",
            fontSize: 17,
            fontWeight: 700,
            cursor: saving ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {saving ? "⏳ 保存中..." : "💾 設定を保存する"}
        </button>
      </div>
    </form>
  );
}

// ─── タブ: APIキー ────────────────────────────────────────────────────────────

function ApiKeysTab({ tenantId }: { tenantId: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [tenantId]);

  const handleRevoke = async (keyId: string) => {
    if (!window.confirm("このAPIキーを無効化しますか？この操作は元に戻せません。")) return;
    setRevoking(keyId);
    try {
      await revokeApiKey(tenantId, keyId);
      setKeys((prev) =>
        prev.map((k) => (k.id === keyId ? { ...k, status: "revoked" as const } : k))
      );
      showToast("🔒 APIキーを無効化しました");
    } catch {
      showToast("❌ 無効化に失敗しました。もう一度お試しください");
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
    showToast("✅ 新しいAPIキーを発行しました！");
  };

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
        🔑 新しいAPIキーを発行
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
          読み込んでいます...
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
          APIキーがまだ発行されていません
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
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: 14,
                      color: "#86efac",
                      wordBreak: "break-all",
                    }}
                  >
                    {key.maskedKey}
                  </span>
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
                    {key.status === "active" ? "有効" : "無効化済み"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span>作成日: {formatDate(key.createdAt)}</span>
                  <span>
                    最終使用: {key.lastUsedAt ? formatDate(key.lastUsedAt) : "未使用"}
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
                  {revoking === key.id ? "⏳ 処理中..." : "🔒 無効化"}
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

// ─── タブ: 埋め込みコード ──────────────────────────────────────────────────────

function EmbedCodeTab({ tenant, apiKeys }: { tenant: TenantDetail; apiKeys: ApiKey[] }) {
  const [copied, setCopied] = useState(false);

  const activeKey = apiKeys.find((k) => k.status === "active");
  const displayKey = activeKey ? activeKey.maskedKey : "YOUR_API_KEY";

  const embedCode = `<script src="https://cdn.rajiuce.com/widget.js"
  data-api-key="${displayKey}"
  data-tenant="${tenant.slug}"
  data-title="${tenant.widgetTitle}"
  data-color="${tenant.widgetColor}">
</script>`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  return (
    <div>
      <div style={CARD_STYLE}>
        <p style={{ fontSize: 14, color: "#9ca3af", marginBottom: 16, lineHeight: 1.6 }}>
          以下のコードをWebサイトのHTMLに埋め込むと、チャットウィジェットが表示されます。
        </p>
        <pre
          style={{
            fontFamily: "monospace",
            background: "rgba(0,0,0,0.5)",
            border: "1px solid #374151",
            borderRadius: 10,
            padding: "16px",
            fontSize: 13,
            color: "#86efac",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            marginBottom: 16,
          }}
        >
          {embedCode}
        </pre>
        <button
          onClick={handleCopy}
          style={{
            padding: "14px 24px",
            minHeight: 50,
            borderRadius: 12,
            border: "none",
            background: copied
              ? "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)"
              : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
            color: "#022c22",
            fontSize: 16,
            fontWeight: 700,
            cursor: "pointer",
            width: "100%",
          }}
        >
          {copied ? "✅ コピーしました！" : "📋 コードをコピー"}
        </button>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: "14px 16px",
          borderRadius: 12,
          background: "rgba(59,130,246,0.1)",
          border: "1px solid rgba(96,165,250,0.2)",
          color: "#93c5fd",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        💡 <strong>YOUR_API_KEY</strong> の部分は、「APIキー」タブで発行した実際のキーに置き換えてください。
        APIキーは発行時にのみ確認できます。
      </div>
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

type TabId = "settings" | "apikeys" | "embed";

const TABS: { id: TabId; label: string }[] = [
  { id: "settings", label: "⚙️ 設定" },
  { id: "apikeys", label: "🔑 APIキー" },
  { id: "embed", label: "📋 埋め込みコード" },
];

export default function TenantDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const tenantId = id ?? "1";

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("settings");
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [tenantData, keysData] = await Promise.all([
          fetchTenantDetail(tenantId),
          fetchApiKeys(tenantId),
        ]);
        setTenant(tenantData);
        setApiKeys(keysData);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [tenantId]);

  const handleSaveSettings = async (data: {
    name: string;
    plan: "starter" | "pro";
    status: "active" | "inactive";
  }) => {
    const updated = await updateTenant(tenantId, data);
    setTenant(updated);
    showToast("✅ 設定を保存しました");
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
      {/* トースト */}
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

      {/* ヘッダー */}
      <header style={{ marginBottom: 32 }}>
        <button
          onClick={() => navigate("/admin/tenants")}
          style={{
            padding: "8px 14px",
            minHeight: 44,
            borderRadius: 999,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 14,
            cursor: "pointer",
            fontWeight: 500,
            marginBottom: 16,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          ← テナント一覧に戻る
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 4px", color: "#f9fafb" }}>
          {loading ? "読み込み中..." : (tenant?.name ?? "テナント詳細")}
        </h1>
        {tenant && (
          <p style={{ fontSize: 14, color: "#9ca3af", margin: 0 }}>
            slug: <span style={{ fontFamily: "monospace" }}>{tenant.slug}</span>
          </p>
        )}
      </header>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 120,
            color: "#9ca3af",
            fontSize: 15,
          }}
        >
          <span style={{ marginRight: 8 }}>⏳</span>
          読み込んでいます...
        </div>
      ) : tenant ? (
        <>
          {/* タブナビゲーション */}
          <div
            style={{
              display: "flex",
              gap: 4,
              marginBottom: 24,
              background: "rgba(15,23,42,0.8)",
              border: "1px solid #1f2937",
              borderRadius: 12,
              padding: 4,
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "none",
                  background: activeTab === tab.id ? "rgba(34,197,94,0.15)" : "transparent",
                  color: activeTab === tab.id ? "#4ade80" : "#9ca3af",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* タブコンテンツ */}
          {activeTab === "settings" && (
            <SettingsTab tenant={tenant} onSave={handleSaveSettings} />
          )}
          {activeTab === "apikeys" && (
            <ApiKeysTab tenantId={tenantId} />
          )}
          {activeTab === "embed" && (
            <EmbedCodeTab tenant={tenant} apiKeys={apiKeys} />
          )}
        </>
      ) : (
        <div
          style={{
            padding: "32px 20px",
            borderRadius: 14,
            border: "1px solid #1f2937",
            background: "rgba(127,29,29,0.2)",
            color: "#fca5a5",
            textAlign: "center",
            fontSize: 15,
          }}
        >
          テナントが見つかりませんでした 🙏
        </div>
      )}
    </div>
  );
}
