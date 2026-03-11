import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
  apiKeyCount: number;
  createdAt: string;
}

// ─── モックデータ ─────────────────────────────────────────────────────────────

const MOCK_TENANTS: Tenant[] = [
  { id: "1", name: "カーネーション自動車", slug: "carnation", plan: "pro", status: "active", apiKeyCount: 2, createdAt: "2024-01-15T00:00:00Z" },
  { id: "2", name: "サクラ不動産", slug: "sakura-realty", plan: "starter", status: "active", apiKeyCount: 1, createdAt: "2024-02-20T00:00:00Z" },
  { id: "3", name: "テスト株式会社", slug: "test-corp", plan: "starter", status: "inactive", apiKeyCount: 0, createdAt: "2024-03-01T00:00:00Z" },
];

// ─── API関数 ─────────────────────────────────────────────────────────────────

async function fetchTenants(): Promise<Tenant[]> {
  // TODO: APIが完成したら fetchWithAuth(`${API_BASE}/v1/admin/tenants`) に差し替え
  return MOCK_TENANTS;
}

async function createTenant(data: { name: string; slug: string; plan: string }): Promise<Tenant> {
  // TODO: APIが完成したら fetchWithAuth(`${API_BASE}/v1/admin/tenants`, { method: "POST", ... }) に差し替え
  const newTenant: Tenant = {
    id: String(Date.now()),
    name: data.name,
    slug: data.slug,
    plan: data.plan as "starter" | "pro",
    status: "active",
    apiKeyCount: 0,
    createdAt: new Date().toISOString(),
  };
  return newTenant;
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

// ─── テナント作成モーダル ──────────────────────────────────────────────────────

interface CreateModalProps {
  onClose: () => void;
  onSuccess: (tenant: Tenant) => void;
}

function CreateTenantModal({ onClose, onSuccess }: CreateModalProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState<"starter" | "pro">("starter");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugValid = /^[a-z0-9-]+$/.test(slug);
  const canSubmit = name.trim().length > 0 && slug.length > 0 && slugValid && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const tenant = await createTenant({ name: name.trim(), slug, plan });
      onSuccess(tenant);
    } catch {
      setError("テナントの作成に失敗しました。もう一度お試しください 🙏");
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const inputStyle: React.CSSProperties = {
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

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "#9ca3af",
    marginBottom: 6,
  };

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1f2937",
          borderRadius: 16,
          padding: "28px 24px",
          maxWidth: 480,
          width: "100%",
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", margin: "0 0 24px" }}>
          🏢 新しいテナントを追加
        </h2>

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

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>テナント名 *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: カーネーション自動車"
              style={inputStyle}
              required
            />
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>スラッグ * (英数字・ハイフンのみ)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="例: carnation-auto"
              style={{
                ...inputStyle,
                borderColor: slug && !slugValid ? "#ef4444" : "#374151",
              }}
              required
            />
            {slug && !slugValid && (
              <p style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>
                英小文字・数字・ハイフンのみ使用できます
              </p>
            )}
          </div>

          <div style={{ marginBottom: 28 }}>
            <label style={labelStyle}>プラン</label>
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

          <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: "16px 24px",
                minHeight: 56,
                borderRadius: 12,
                border: "none",
                background: canSubmit
                  ? "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)"
                  : "rgba(34,197,94,0.3)",
                color: "#022c22",
                fontSize: 17,
                fontWeight: 700,
                cursor: canSubmit ? "pointer" : "not-allowed",
                width: "100%",
              }}
            >
              {loading ? "⏳ 作成中..." : "✅ テナントを作成する"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              style={{
                padding: "14px 24px",
                minHeight: 48,
                borderRadius: 12,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                width: "100%",
              }}
            >
              キャンセル
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function TenantsPage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchTenants();
        setTenants(data);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleCreateSuccess = (newTenant: Tenant) => {
    setTenants((prev) => [...prev, newTenant]);
    setShowModal(false);
    showToast("✅ テナントを作成しました！");
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
          onClick={() => navigate("/admin")}
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
          ← ダッシュボードに戻る
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 4px", color: "#f9fafb" }}>
          テナント管理
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", margin: 0 }}>
          接続テナントの管理・設定・APIキー発行
        </p>
      </header>

      {/* 追加ボタン */}
      <button
        onClick={() => setShowModal(true)}
        style={{
          width: "100%",
          padding: "18px 24px",
          minHeight: 60,
          borderRadius: 14,
          border: "none",
          background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 17,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: "0 8px 25px rgba(34,197,94,0.25)",
          marginBottom: 24,
        }}
      >
        <span style={{ fontSize: 22 }}>＋</span>
        新しいテナントを追加
      </button>

      {/* テナント一覧 */}
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
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tenants.length === 0 ? (
            <div
              style={{
                ...CARD_STYLE,
                textAlign: "center",
                color: "#6b7280",
                fontSize: 15,
                padding: "40px 20px",
              }}
            >
              テナントがまだ登録されていません
            </div>
          ) : (
            tenants.map((tenant) => (
              <div
                key={tenant.id}
                style={{
                  ...CARD_STYLE,
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                {/* テナント情報 */}
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb" }}>
                      {tenant.name}
                    </span>
                    {/* 状態バッジ */}
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background: tenant.status === "active" ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.2)",
                        color: tenant.status === "active" ? "#4ade80" : "#9ca3af",
                        border: `1px solid ${tenant.status === "active" ? "rgba(74,222,128,0.3)" : "rgba(107,114,128,0.3)"}`,
                      }}
                    >
                      {tenant.status === "active" ? "有効" : "無効"}
                    </span>
                    {/* プランバッジ */}
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background: tenant.plan === "pro" ? "rgba(59,130,246,0.15)" : "rgba(107,114,128,0.2)",
                        color: tenant.plan === "pro" ? "#60a5fa" : "#9ca3af",
                        border: `1px solid ${tenant.plan === "pro" ? "rgba(96,165,250,0.3)" : "rgba(107,114,128,0.3)"}`,
                      }}
                    >
                      {tenant.plan === "pro" ? "Pro" : "Starter"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>
                    slug: <span style={{ fontFamily: "monospace", color: "#9ca3af" }}>{tenant.slug}</span>
                  </div>
                </div>

                {/* メタ情報 */}
                <div
                  style={{
                    display: "flex",
                    gap: 20,
                    flexWrap: "wrap",
                    fontSize: 13,
                    color: "#9ca3af",
                  }}
                >
                  <div>
                    <span style={{ color: "#6b7280" }}>APIキー: </span>
                    <span style={{ color: "#d1d5db", fontWeight: 600 }}>{tenant.apiKeyCount}件</span>
                  </div>
                  <div>
                    <span style={{ color: "#6b7280" }}>作成日: </span>
                    <span style={{ color: "#d1d5db" }}>{formatDate(tenant.createdAt)}</span>
                  </div>
                </div>

                {/* 設定ボタン */}
                <button
                  onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
                  style={{
                    padding: "10px 18px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #374151",
                    background: "rgba(0,0,0,0.3)",
                    color: "#d1d5db",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  設定 →
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* 作成モーダル */}
      {showModal && (
        <CreateTenantModal
          onClose={() => setShowModal(false)}
          onSuccess={handleCreateSuccess}
        />
      )}
    </div>
  );
}
