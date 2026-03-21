// admin-ui/src/pages/admin/avatar/index.tsx
// Avatar Customization Studio — config list page

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { authFetch, API_BASE } from "../../../lib/api";

interface AvatarConfig {
  id: string;
  tenant_id: string;
  name: string;
  image_url: string | null;
  image_prompt: string | null;
  voice_id: string | null;
  voice_description: string | null;
  personality_prompt: string | null;
  behavior_description: string | null;
  emotion_tags: string[];
  lemonslice_agent_id: string | null;
  is_active: boolean;
  created_at: string;
  avatar_provider: string | null;
}

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

export default function AvatarListPage() {
  const navigate = useNavigate();
  const { lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";

  const [configs, setConfigs] = useState<AvatarConfig[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs`);
      if (!res.ok) {
        setError(lang === "ja" ? "設定の読み込みに失敗しました" : "Failed to load configs");
        return;
      }
      const data = await res.json() as { configs: AvatarConfig[]; total: number };
      setConfigs(data.configs ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setError(lang === "ja" ? "ネットワークエラーが発生しました" : "A network error occurred");
    } finally {
      setLoading(false);
    }
  }, [lang]);

  useEffect(() => { void fetchConfigs(); }, [fetchConfigs]);

  const handleActivate = async (id: string) => {
    if (activating) return;
    setActivating(id);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${id}/activate`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(lang === "ja" ? "アクティベートに失敗しました" : "Failed to activate config");
        return;
      }
      setConfigs((prev) =>
        prev.map((c) => ({ ...c, is_active: c.id === id }))
      );
    } catch {
      setError(lang === "ja" ? "ネットワークエラーが発生しました" : "A network error occurred");
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (deleting) return;
    const confirmed = window.confirm(
      lang === "ja"
        ? "このアバター設定を削除しますか？この操作は元に戻せません。"
        : "Delete this avatar config? This cannot be undone."
    );
    if (!confirmed) return;
    setDeleting(id);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(lang === "ja" ? "削除に失敗しました" : "Failed to delete config");
        return;
      }
      setConfigs((prev) => prev.filter((c) => c.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch {
      setError(lang === "ja" ? "ネットワークエラーが発生しました" : "A network error occurred");
    } finally {
      setDeleting(null);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 960, margin: "0 auto" }}>
      {/* ヘッダー */}
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin")}
          style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, display: "block" }}
        >
          {lang === "ja" ? "← 管理画面に戻る" : "← Back to Admin"}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
              {lang === "ja" ? "アバター設定" : "Avatar Configs"}
            </h1>
            {!loading && (
              <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
                {lang === "ja" ? `${total}件の設定` : `${total} config${total !== 1 ? "s" : ""}`}
              </p>
            )}
          </div>
          <button
            onClick={() => navigate("/admin/avatar/studio")}
            style={{
              padding: "10px 20px",
              minHeight: 44,
              borderRadius: 10,
              border: "none",
              background: "linear-gradient(135deg, #3b82f6, #6366f1)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {lang === "ja" ? "+ 新規作成" : "+ New Config"}
          </button>
        </div>
      </header>

      {/* エラーメッセージ */}
      {error && (
        <div style={{
          marginBottom: 20,
          padding: "12px 16px",
          borderRadius: 10,
          background: "rgba(239,68,68,0.12)",
          border: "1px solid rgba(239,68,68,0.4)",
          color: "#fca5a5",
          fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {/* ローディング */}
      {loading ? (
        <div style={{ textAlign: "center", color: "#6b7280", paddingTop: 60, fontSize: 15 }}>
          {lang === "ja" ? "読み込み中..." : "Loading..."}
        </div>
      ) : configs.length === 0 ? (
        <div style={{
          textAlign: "center",
          padding: "60px 20px",
          borderRadius: 14,
          border: "1px dashed #374151",
          color: "#6b7280",
          fontSize: 15,
        }}>
          {lang === "ja"
            ? "アバター設定がまだありません。「新規作成」から始めましょう。"
            : "No avatar configs yet. Click \"New Config\" to get started."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {configs.map((cfg) => (
            <div
              key={cfg.id}
              style={{
                borderRadius: 14,
                border: cfg.is_active ? "1px solid rgba(34,197,94,0.5)" : "1px solid #1f2937",
                background: "rgba(15,23,42,0.95)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* サムネイル */}
              {cfg.image_url ? (
                <div style={{ width: "100%", height: 160, overflow: "hidden", background: "#111827" }}>
                  <img
                    src={cfg.image_url}
                    alt={cfg.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              ) : (
                <div style={{
                  width: "100%",
                  height: 120,
                  background: "rgba(30,41,59,0.8)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#374151",
                  fontSize: 40,
                }}>
                  👤
                </div>
              )}

              {/* コンテンツ */}
              <div style={{ padding: "14px 16px", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                {/* 名前 + バッジ */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cfg.name}
                  </span>
                  {cfg.is_active && (
                    <span style={{
                      padding: "2px 9px",
                      borderRadius: 999,
                      background: "rgba(34,197,94,0.15)",
                      border: "1px solid rgba(34,197,94,0.5)",
                      color: "#4ade80",
                      fontSize: 11,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}>
                      {lang === "ja" ? "アクティブ" : "Active"}
                    </span>
                  )}
                  {/* Providerバッジ */}
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: cfg.avatar_provider === 'anam'
                      ? 'rgba(59,130,246,0.15)'
                      : 'rgba(107,114,128,0.15)',
                    border: cfg.avatar_provider === 'anam'
                      ? '1px solid rgba(59,130,246,0.4)'
                      : '1px solid rgba(107,114,128,0.3)',
                    color: cfg.avatar_provider === 'anam' ? '#93c5fd' : '#9ca3af',
                    fontSize: 10,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}>
                    {cfg.avatar_provider === 'anam' ? 'Anam' : 'Lemonslice'}
                  </span>
                </div>

                {/* 作成日 */}
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {lang === "ja" ? "作成日: " : "Created: "}{formatDate(cfg.created_at)}
                </span>

                {/* アクションボタン */}
                <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap" }}>
                  {!cfg.is_active && (
                    <button
                      onClick={() => void handleActivate(cfg.id)}
                      disabled={activating === cfg.id}
                      style={{
                        padding: "8px 14px",
                        minHeight: 36,
                        borderRadius: 8,
                        border: "1px solid rgba(34,197,94,0.4)",
                        background: activating === cfg.id ? "rgba(34,197,94,0.05)" : "rgba(34,197,94,0.1)",
                        color: "#4ade80",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: activating === cfg.id ? "not-allowed" : "pointer",
                        opacity: activating === cfg.id ? 0.6 : 1,
                      }}
                    >
                      {activating === cfg.id
                        ? (lang === "ja" ? "処理中..." : "Activating...")
                        : (lang === "ja" ? "有効化" : "Activate")}
                    </button>
                  )}
                  <button
                    onClick={() => navigate(`/admin/avatar/studio/${cfg.id}`)}
                    style={{
                      padding: "8px 14px",
                      minHeight: 36,
                      borderRadius: 8,
                      border: "1px solid #374151",
                      background: "transparent",
                      color: "#9ca3af",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {lang === "ja" ? "編集" : "Edit"}
                  </button>
                  {!cfg.is_active && (
                    <button
                      onClick={() => void handleDelete(cfg.id)}
                      disabled={deleting === cfg.id}
                      style={{
                        padding: "8px 14px",
                        minHeight: 36,
                        borderRadius: 8,
                        border: "1px solid rgba(239,68,68,0.3)",
                        background: deleting === cfg.id ? "rgba(239,68,68,0.05)" : "transparent",
                        color: "#f87171",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: deleting === cfg.id ? "not-allowed" : "pointer",
                        opacity: deleting === cfg.id ? 0.6 : 1,
                        marginLeft: "auto",
                      }}
                    >
                      {deleting === cfg.id
                        ? (lang === "ja" ? "削除中..." : "Deleting...")
                        : (lang === "ja" ? "削除" : "Delete")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
