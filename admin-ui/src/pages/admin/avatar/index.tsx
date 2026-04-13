// admin-ui/src/pages/admin/avatar/index.tsx
// Avatar Customization Studio — config list page

import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface AvatarConfig {
  id: string;
  tenant_id: string;
  tenant_name?: string;
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
  is_default: boolean;
  created_at: string;
  avatar_provider: string | null;
}

type SortKey = "tenant_asc" | "created_desc" | "created_asc" | "active_first" | "inactive_first" | "default_first";
type TypeFilter = "all" | "default" | "custom";
type StatusFilter = "all" | "active" | "inactive";

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

export default function AvatarListPage() {
  const navigate = useNavigate();
  const { lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const { user, isSuperAdmin } = useAuth();

  const [configs, setConfigs] = useState<AvatarConfig[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Sort & Filter state ─────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("tenant_asc");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // ── アバター機能 ON/OFF トグル（Client Adminのみ）─────────────────────────
  const [avatarEnabled, setAvatarEnabled] = useState<boolean>(false);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [toggleToast, setToggleToast] = useState<string | null>(null);
  const [tenantFeatures, setTenantFeatures] = useState<{ avatar: boolean; voice: boolean; rag: boolean } | null>(null);

  const showToggleToast = (msg: string) => {
    setToggleToast(msg);
    setTimeout(() => setToggleToast(null), 3000);
  };

  useEffect(() => {
    if (!user?.tenantId || isSuperAdmin) return;
    authFetch(`${API_BASE}/v1/admin/my-tenant`)
      .then((r) => r.json())
      .then((data: { features?: { avatar?: boolean; voice?: boolean; rag?: boolean } }) => {
        const f = { avatar: data.features?.avatar ?? false, voice: data.features?.voice ?? false, rag: data.features?.rag ?? true };
        setTenantFeatures(f);
        setAvatarEnabled(f.avatar);
      })
      .catch(() => {});
  }, [user?.tenantId, isSuperAdmin]);

  const handleAvatarToggle = async () => {
    if (!user?.tenantId || !tenantFeatures || toggleLoading) return;
    const next = !avatarEnabled;
    setToggleLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: { ...tenantFeatures, avatar: next } }),
      });
      if (!res.ok) {
        showToggleToast("❌ 保存に失敗しました。もう一度お試しください。");
        return;
      }
      const updated = await res.json() as { features?: { avatar?: boolean; voice?: boolean; rag?: boolean } };
      const f = { avatar: updated.features?.avatar ?? next, voice: updated.features?.voice ?? tenantFeatures.voice, rag: updated.features?.rag ?? tenantFeatures.rag };
      setTenantFeatures(f);
      setAvatarEnabled(f.avatar);
      showToggleToast(f.avatar ? "✅ アバター機能をONにしました" : "✅ アバター機能をOFFにしました");
    } catch {
      showToggleToast("❌ 保存に失敗しました。もう一度お試しください。");
    } finally {
      setToggleLoading(false);
    }
  };

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = isSuperAdmin
        ? `${API_BASE}/v1/admin/avatar/configs/all`
        : `${API_BASE}/v1/admin/avatar/configs`;
      const res = await authFetch(url);
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
  }, [lang, isSuperAdmin]);

  useEffect(() => { void fetchConfigs(); }, [fetchConfigs]);

  // ── テナント一覧（フィルタ用）──────────────────────────────────────────
  const tenantList = useMemo(() => {
    const seen = new Set<string>();
    const list: { id: string; name: string }[] = [];
    for (const c of configs) {
      if (!seen.has(c.tenant_id)) {
        seen.add(c.tenant_id);
        list.push({ id: c.tenant_id, name: c.tenant_name ?? c.tenant_id });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [configs]);

  // ── フィルタ + ソート済みリスト ──────────────────────────────────────
  const displayedConfigs = useMemo(() => {
    let result = [...configs];

    // テナントフィルタ
    if (tenantFilter !== "all") {
      result = result.filter((c) => c.tenant_id === tenantFilter);
    }
    // タイプフィルタ
    if (typeFilter === "default") result = result.filter((c) => c.is_default);
    if (typeFilter === "custom") result = result.filter((c) => !c.is_default);
    // ステータスフィルタ
    if (statusFilter === "active") result = result.filter((c) => c.is_active);
    if (statusFilter === "inactive") result = result.filter((c) => !c.is_active);

    // ソート
    result.sort((a, b) => {
      switch (sortKey) {
        case "tenant_asc":
          return (a.tenant_name ?? a.tenant_id).localeCompare(b.tenant_name ?? b.tenant_id) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "created_desc":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "created_asc":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "active_first":
          return (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0);
        case "inactive_first":
          return (a.is_active ? 1 : 0) - (b.is_active ? 1 : 0);
        case "default_first":
          return (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0);
        default:
          return 0;
      }
    });

    return result;
  }, [configs, tenantFilter, typeFilter, statusFilter, sortKey]);

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

  const toggleBtnStyle = (active: boolean) => ({
    padding: "8px 14px",
    minHeight: 44,
    borderRadius: 8,
    border: active ? "1px solid rgba(99,102,241,0.6)" : "1px solid #374151",
    background: active ? "rgba(99,102,241,0.2)" : "transparent",
    color: active ? "#a5b4fc" : "#9ca3af",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  });

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
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb", display: "flex", alignItems: "center", gap: 8 }}>
              🎭 {lang === "ja" ? "アバター設定" : "Avatar Configs"}
            </h1>
            {!loading && (
              <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
                {isSuperAdmin
                  ? (lang === "ja" ? `全テナント: ${displayedConfigs.length}/${total}件` : `All tenants: ${displayedConfigs.length}/${total}`)
                  : (lang === "ja" ? `${total}件の設定` : `${total} config${total !== 1 ? "s" : ""}`)
                }
              </p>
            )}
          </div>
          {!isSuperAdmin && (
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
          )}
        </div>
      </header>

      {/* ── Super Admin: ソート / フィルタパネル ─────────────────────────────── */}
      {isSuperAdmin && !loading && (
        <div style={{
          marginBottom: 24,
          padding: "16px 20px",
          borderRadius: 14,
          border: "1px solid rgba(99,102,241,0.3)",
          background: "rgba(15,23,42,0.8)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}>
          {/* ソート */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#9ca3af", minWidth: 48 }}>
              {lang === "ja" ? "ソート:" : "Sort:"}
            </span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              style={{
                padding: "8px 12px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "#111827",
                color: "#e5e7eb",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <option value="tenant_asc">{lang === "ja" ? "テナント名順 (A→Z)" : "Tenant (A→Z)"}</option>
              <option value="created_desc">{lang === "ja" ? "作成日 (新しい順)" : "Created (newest)"}</option>
              <option value="created_asc">{lang === "ja" ? "作成日 (古い順)" : "Created (oldest)"}</option>
              <option value="active_first">{lang === "ja" ? "アクティブ優先" : "Active first"}</option>
              <option value="inactive_first">{lang === "ja" ? "無効優先" : "Inactive first"}</option>
              <option value="default_first">{lang === "ja" ? "デフォルト優先" : "Default first"}</option>
            </select>
          </div>

          {/* フィルタ: テナント */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#9ca3af", minWidth: 48 }}>
              {lang === "ja" ? "テナント:" : "Tenant:"}
            </span>
            <select
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              style={{
                padding: "8px 12px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "#111827",
                color: "#e5e7eb",
                fontSize: 13,
                cursor: "pointer",
                maxWidth: 220,
              }}
            >
              <option value="all">{lang === "ja" ? "全テナント" : "All tenants"}</option>
              {tenantList.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          {/* フィルタ: タイプ */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#9ca3af", minWidth: 48 }}>
              {lang === "ja" ? "タイプ:" : "Type:"}
            </span>
            {(["all", "default", "custom"] as TypeFilter[]).map((v) => (
              <button key={v} onClick={() => setTypeFilter(v)} style={toggleBtnStyle(typeFilter === v)}>
                {v === "all" ? (lang === "ja" ? "全て" : "All") : v === "default" ? (lang === "ja" ? "デフォルト" : "Default") : (lang === "ja" ? "カスタム" : "Custom")}
              </button>
            ))}
          </div>

          {/* フィルタ: ステータス */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#9ca3af", minWidth: 48 }}>
              {lang === "ja" ? "状態:" : "Status:"}
            </span>
            {(["all", "active", "inactive"] as StatusFilter[]).map((v) => (
              <button key={v} onClick={() => setStatusFilter(v)} style={toggleBtnStyle(statusFilter === v)}>
                {v === "all" ? (lang === "ja" ? "全て" : "All") : v === "active" ? (lang === "ja" ? "アクティブ" : "Active") : (lang === "ja" ? "無効" : "Inactive")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── アバター機能 ON/OFF トグル（Client Adminのみ）─────────────────────────────── */}
      {!isSuperAdmin && user?.tenantId && (
        <div style={{
          marginBottom: 24,
          padding: "20px 24px",
          borderRadius: 14,
          border: avatarEnabled
            ? "1px solid rgba(74,222,128,0.35)"
            : "1px solid rgba(107,114,128,0.3)",
          background: avatarEnabled
            ? "rgba(34,197,94,0.07)"
            : "rgba(255,255,255,0.03)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "#f9fafb" }}>🤖 AIアバター機能</h2>
              <p style={{ fontSize: 14, color: "#9ca3af", margin: "6px 0 0" }}>
                ONにすると、チャットウィジェットにAIアバターが表示されます
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void handleAvatarToggle(); }}
              disabled={toggleLoading || tenantFeatures === null}
              style={{
                padding: "12px 28px",
                minHeight: 48,
                minWidth: 120,
                borderRadius: 10,
                border: avatarEnabled
                  ? "1px solid rgba(74,222,128,0.5)"
                  : "1px solid rgba(107,114,128,0.4)",
                background: avatarEnabled
                  ? "rgba(34,197,94,0.22)"
                  : "rgba(107,114,128,0.18)",
                color: avatarEnabled ? "#4ade80" : "#9ca3af",
                fontSize: 16,
                fontWeight: 700,
                cursor: toggleLoading || tenantFeatures === null ? "not-allowed" : "pointer",
                opacity: toggleLoading || tenantFeatures === null ? 0.6 : 1,
                transition: "all 0.15s",
              }}
            >
              {toggleLoading ? "保存中..." : avatarEnabled ? "✅ ON" : "⏸️ OFF"}
            </button>
          </div>
          {toggleToast && (
            <div style={{
              marginTop: 12,
              padding: "10px 14px",
              borderRadius: 8,
              background: toggleToast.startsWith("❌")
                ? "rgba(239,68,68,0.12)"
                : "rgba(34,197,94,0.12)",
              color: toggleToast.startsWith("❌") ? "#fca5a5" : "#86efac",
              fontSize: 14,
            }}>
              {toggleToast}
            </div>
          )}
        </div>
      )}

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
      ) : displayedConfigs.length === 0 ? (
        <div style={{
          textAlign: "center",
          padding: "60px 20px",
          borderRadius: 14,
          border: "1px dashed #374151",
          color: "#6b7280",
          fontSize: 15,
        }}>
          {configs.length === 0
            ? (lang === "ja"
              ? "アバター設定がまだありません。「新規作成」から始めましょう。"
              : "No avatar configs yet. Click \"New Config\" to get started.")
            : (lang === "ja" ? "フィルタ条件に一致する設定がありません" : "No configs match the current filters")
          }
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {displayedConfigs.map((cfg) => (
            <div
              key={cfg.id}
              style={{
                borderRadius: 14,
                border: cfg.is_active ? "1px solid rgba(34,197,94,0.5)" : "1px solid #1f2937",
                background: "rgba(15,23,42,0.95)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                position: "relative",
              }}
            >
              {/* テナント名バッジ（Super Adminのみ） */}
              {isSuperAdmin && cfg.tenant_name && (
                <div style={{
                  position: "absolute",
                  top: 8,
                  left: 8,
                  zIndex: 10,
                  padding: "3px 8px",
                  borderRadius: 6,
                  background: "rgba(0,0,0,0.75)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  color: "#d1d5db",
                  fontSize: 11,
                  fontWeight: 600,
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {cfg.tenant_name}
                </div>
              )}

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
                  <span style={{ fontSize: 16, fontWeight: 700, color: cfg.name ? "#f9fafb" : "#6b7280", fontStyle: cfg.name ? "normal" : "italic", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cfg.name || (lang === "ja" ? "名前なし" : "Unnamed")}
                  </span>
                  {cfg.is_active && (isSuperAdmin || avatarEnabled) ? (
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
                  ) : cfg.is_active && !avatarEnabled && !isSuperAdmin ? (
                    <span style={{
                      padding: "2px 9px",
                      borderRadius: 999,
                      background: "rgba(107,114,128,0.15)",
                      border: "1px solid rgba(107,114,128,0.4)",
                      color: "#9ca3af",
                      fontSize: 11,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}>
                      {lang === "ja" ? "無効" : "Inactive"}
                    </span>
                  ) : null}
                  {cfg.is_default && (
                    <span style={{
                      background: '#dbeafe',
                      color: '#1d4ed8',
                      padding: '2px 8px',
                      borderRadius: '9999px',
                      fontSize: '12px',
                      fontWeight: 500,
                      marginLeft: '8px',
                      flexShrink: 0,
                    }}>
                      {lang === "ja" ? "デフォルト" : "Default"}
                    </span>
                  )}
                </div>

                {/* 作成日 */}
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {lang === "ja" ? "作成日: " : "Created: "}{formatDate(cfg.created_at)}
                </span>

                {/* アクションボタン */}
                <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap" }}>
                  {!isSuperAdmin && !cfg.is_active && (
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
                  {!isSuperAdmin && (
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
                  )}
                  {!isSuperAdmin && !cfg.is_active && (
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
