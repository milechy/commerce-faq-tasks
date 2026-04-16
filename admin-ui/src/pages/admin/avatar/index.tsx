// admin-ui/src/pages/admin/avatar/index.tsx
// Avatar Customization Studio — config list page

import React, { useState, useEffect, useCallback, useMemo } from "react";
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

type SortKey = "name_asc" | "created_desc" | "created_asc" | "active_first" | "inactive_first" | "default_first";
type TypeFilter = "all" | "default" | "custom";
type StatusFilter = "all" | "active" | "inactive";

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

// ── AvatarWarningModal ─────────────────────────────────────────────────────
interface WarningTarget { id: string; tenantId: string; name: string }

const WARNING_REASONS = ["利用規約違反の疑い", "不適切なコンテンツ", "システムリソース過剰使用", "その他"];
const WARNING_DEADLINES = [{ label: "3日以内", days: 3 }, { label: "7日以内", days: 7 }, { label: "14日以内", days: 14 }];

function AvatarWarningModal({ target, onClose }: { target: WarningTarget; onClose: () => void }) {
  const [reason, setReason] = useState(WARNING_REASONS[0]);
  const [deadlineDays, setDeadlineDays] = useState(3);
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const deadlineDate = new Date(Date.now() + deadlineDays * 86400000)
    .toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
  const previewTitle = `⚠️ アバター警告: ${target.name}`;
  const previewMessage = `理由: ${reason}\n対応期限: ${deadlineDate}${memo ? `\nメモ: ${memo}` : ""}`;

  const handleSend = async () => {
    setSending(true);
    setSendError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient_tenant_id: target.tenantId,
          type: "avatar_warning",
          title: previewTitle,
          message: previewMessage,
          link: "/admin/avatar",
          metadata: { avatar_config_id: target.id, reason, deadline_days: deadlineDays },
        }),
      });
      if (!res.ok) { setSendError("送信に失敗しました。もう一度お試しください。"); return; }
      setSent(true);
      setTimeout(onClose, 2000);
    } catch { setSendError("ネットワークエラーが発生しました。"); }
    finally { setSending(false); }
  };

  const INPUT_STYLE: React.CSSProperties = { padding: "8px 10px", minHeight: 44, borderRadius: 8, border: "1px solid #374151", background: "#020617", color: "#e5e7eb", fontSize: 13 };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(480px, 100%)", borderRadius: 16, background: "#0f172a", border: "1px solid rgba(239,68,68,0.3)", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: 0 }}>⚠️ 警告メッセージを送信</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 20, cursor: "pointer", padding: 4, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>テナントに警告通知を送信します。対象: <strong style={{ color: "#e5e7eb" }}>{target.name}</strong></p>

        {sent ? (
          <div style={{ textAlign: "center", padding: "20px 0", color: "#4ade80", fontSize: 16, fontWeight: 700 }}>✅ 送信しました</div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#d1d5db" }}>警告理由</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} style={INPUT_STYLE}>
                {WARNING_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#d1d5db" }}>対応期限</span>
              <select value={deadlineDays} onChange={(e) => setDeadlineDays(Number(e.target.value))} style={INPUT_STYLE}>
                {WARNING_DEADLINES.map((d) => (
                  <option key={d.days} value={d.days}>
                    {d.label}（{new Date(Date.now() + d.days * 86400000).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}）
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#d1d5db" }}>メモ（任意）</span>
              <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} placeholder="詳細な説明やリンクなど..." style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #374151", background: "#020617", color: "#e5e7eb", fontSize: 13, resize: "vertical", fontFamily: "inherit" }} />
            </label>

            <div style={{ padding: 12, borderRadius: 10, background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <p style={{ margin: "0 0 4px", fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>プレビュー</p>
              <p style={{ margin: 0, fontSize: 13, color: "#fca5a5", fontWeight: 700 }}>{previewTitle}</p>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "#d1d5db", whiteSpace: "pre-line", lineHeight: 1.7 }}>{previewMessage}</p>
            </div>

            {sendError && <div style={{ color: "#fca5a5", fontSize: 13 }}>{sendError}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ padding: "10px 18px", minHeight: 44, borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>キャンセル</button>
              <button onClick={() => void handleSend()} disabled={sending} style={{ padding: "10px 18px", minHeight: 44, borderRadius: 8, border: "none", background: sending ? "#4b5563" : "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sending ? "not-allowed" : "pointer" }}>
                {sending ? "送信中..." : "⚠️ 警告を送信"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

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
  const [warningTarget, setWarningTarget] = useState<WarningTarget | null>(null);

  // ── Sort & Filter state ─────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
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
      const tid = c.tenant_id;
      if (!tid) continue; // null/emptyのテナントIDはスキップ
      if (!seen.has(tid)) {
        seen.add(tid);
        list.push({ id: tid, name: c.tenant_name ?? tid });
      }
    }
    return list.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [configs]);

  // ── フィルタ + ソート済みリスト ──────────────────────────────────────
  const displayedConfigs = useMemo(() => {
    let result = [...configs];

    // テナントフィルタ: 特定テナント選択時はis_default=trueを除外（タイプ「デフォルト」選択時は除外しない）
    if (tenantFilter !== "all") {
      result = result.filter((c) => {
        if (c.is_default && typeFilter !== "default") return false;
        return (c.tenant_id ?? "") === tenantFilter;
      });
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
        case "name_asc":
          return (a.name ?? "").localeCompare(b.name ?? "") || (a.tenant_name ?? a.tenant_id ?? "").localeCompare(b.tenant_name ?? b.tenant_id ?? "");
        case "created_desc":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "created_asc":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "active_first":
          return (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0) || (a.name ?? "").localeCompare(b.name ?? "");
        case "inactive_first":
          return (a.is_active ? 1 : 0) - (b.is_active ? 1 : 0) || (a.name ?? "").localeCompare(b.name ?? "");
        case "default_first":
          return (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || (a.name ?? "").localeCompare(b.name ?? "");
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
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 1200, margin: "0 auto" }}>
      <style>{`
        .av-grid {
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(2, 1fr);
        }
        @media (min-width: 768px) {
          .av-grid { grid-template-columns: repeat(3, 1fr); }
        }
        @media (min-width: 1024px) {
          .av-grid { grid-template-columns: repeat(4, 1fr); }
        }
        .av-card {
          transition: box-shadow 0.18s, transform 0.18s;
        }
        .av-card:hover {
          box-shadow: 0 8px 32px rgba(59,130,246,0.18), 0 2px 8px rgba(0,0,0,0.4);
          transform: translateY(-2px);
        }
        .av-filter-panel {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        @media (min-width: 768px) {
          .av-filter-panel {
            flex-direction: row;
            flex-wrap: wrap;
            align-items: flex-start;
          }
          .av-filter-panel > * {
            flex: 0 0 auto;
          }
        }
        .av-btn-sm {
          padding: 6px 10px;
          font-size: 11px;
        }
        @media (min-width: 768px) {
          .av-btn-sm {
            padding: 8px 14px;
            font-size: 12px;
          }
        }
        .av-img-wrap {
          width: 100%;
          aspect-ratio: 1 / 1;
          overflow: hidden;
          background: #111827;
          position: relative;
          border-radius: 0;
        }
        .av-img-wrap img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center top;
          display: block;
          transition: transform 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);
          transform-origin: center top;
          user-select: none;
          -webkit-user-drag: none;
          pointer-events: none;
        }
        .av-img-wrap .av-img-overlay {
          position: absolute;
          inset: 0;
          z-index: 1;
        }
        .av-card:hover .av-img-wrap img {
          animation: avatar-breathe 2s ease-in-out infinite;
        }
        @keyframes avatar-breathe {
          0%, 100% {
            transform: scale(1.05) translateY(0px) rotate(0deg);
          }
          30% {
            transform: scale(1.08) translateY(-2px) rotate(0.5deg);
          }
          60% {
            transform: scale(1.06) translateY(1px) rotate(-0.3deg);
          }
        }
        .av-img-placeholder {
          width: 100%;
          aspect-ratio: 1 / 1;
          background: rgba(30,41,59,0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #374151;
          font-size: clamp(28px, 6vw, 48px);
        }
        .av-name {
          font-size: clamp(12px, 3vw, 16px);
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `}</style>
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
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => navigate("/admin/avatar/wizard")}
                style={{
                  padding: "10px 20px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "1px solid rgba(245,158,11,0.4)",
                  background: "rgba(245,158,11,0.12)",
                  color: "#fcd34d",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                ✨ {lang === "ja" ? "AI生成" : "AI Generate"}
              </button>
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
          )}
        </div>
      </header>

      {/* ── ソート / フィルタパネル ─────────────────────────────── */}
      {!loading && (
        <div className="av-filter-panel" style={{
          marginBottom: 24,
          padding: "16px 20px",
          borderRadius: 14,
          border: "1px solid rgba(99,102,241,0.3)",
          background: "rgba(15,23,42,0.8)",
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
              <option value="name_asc">{lang === "ja" ? "アバター名順 (A→Z)" : "Name (A→Z)"}</option>
              <option value="created_desc">{lang === "ja" ? "作成日 (新しい順)" : "Created (newest)"}</option>
              <option value="created_asc">{lang === "ja" ? "作成日 (古い順)" : "Created (oldest)"}</option>
              <option value="active_first">{lang === "ja" ? "アクティブ優先" : "Active first"}</option>
              <option value="inactive_first">{lang === "ja" ? "無効優先" : "Inactive first"}</option>
              <option value="default_first">{lang === "ja" ? "デフォルト優先" : "Default first"}</option>
            </select>
          </div>

          {/* フィルタ: テナント（Super Adminのみ） */}
          {isSuperAdmin && (
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
          )}

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
        <div className="av-grid">
          {displayedConfigs.map((cfg) => (
            <div
              key={cfg.id}
              className="av-card"
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
              {/* テナント名 / R2Cデフォルトバッジ（Super Adminのみ） */}
              {isSuperAdmin && (cfg.tenant_name || cfg.is_default) && (
                <div style={{
                  position: "absolute",
                  top: 8,
                  left: 8,
                  zIndex: 10,
                  padding: "3px 8px",
                  borderRadius: 6,
                  background: cfg.is_default
                    ? "rgba(99,102,241,0.85)"
                    : "rgba(0,0,0,0.75)",
                  border: cfg.is_default
                    ? "1px solid rgba(165,180,252,0.5)"
                    : "1px solid rgba(255,255,255,0.15)",
                  color: cfg.is_default ? "#e0e7ff" : "#d1d5db",
                  fontSize: 11,
                  fontWeight: 600,
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {cfg.is_default ? "R2C デフォルト" : cfg.tenant_name}
                </div>
              )}

              {/* サムネイル */}
              {cfg.image_url ? (
                <div className="av-img-wrap">
                  <img
                    src={cfg.image_url}
                    alt={cfg.name}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                  <div className="av-img-overlay" />
                </div>
              ) : (
                <div className="av-img-placeholder">👤</div>
              )}

              {/* コンテンツ */}
              <div style={{ padding: "14px 16px", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                {/* 名前 + バッジ */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="av-name" style={{ color: cfg.name ? "#f9fafb" : "#6b7280", fontStyle: cfg.name ? "normal" : "italic", flex: 1, minWidth: 0 }}>
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
                      className="av-btn-sm"
                      onClick={() => void handleActivate(cfg.id)}
                      disabled={activating === cfg.id}
                      style={{
                        minHeight: 44,
                        borderRadius: 8,
                        border: "1px solid rgba(34,197,94,0.4)",
                        background: activating === cfg.id ? "rgba(34,197,94,0.05)" : "rgba(34,197,94,0.1)",
                        color: "#4ade80",
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
                      className="av-btn-sm"
                      onClick={() => navigate(`/admin/avatar/studio/${cfg.id}`)}
                      style={{
                        minHeight: 44,
                        borderRadius: 8,
                        border: "1px solid #374151",
                        background: "transparent",
                        color: "#9ca3af",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {lang === "ja" ? "編集" : "Edit"}
                    </button>
                  )}
                  {!isSuperAdmin && !cfg.is_active && (
                    <button
                      className="av-btn-sm"
                      onClick={() => void handleDelete(cfg.id)}
                      disabled={deleting === cfg.id}
                      style={{
                        minHeight: 44,
                        borderRadius: 8,
                        border: "1px solid rgba(239,68,68,0.3)",
                        background: deleting === cfg.id ? "rgba(239,68,68,0.05)" : "transparent",
                        color: "#f87171",
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
                  {/* Super Admin アクション */}
                  {isSuperAdmin && (
                    <>
                      <button
                        className="av-btn-sm"
                        onClick={() => navigate(`/admin/avatar/studio/${cfg.id}`)}
                        style={{ minHeight: 44, borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontWeight: 600, cursor: "pointer" }}
                      >
                        編集
                      </button>
                      <button
                        className="av-btn-sm"
                        onClick={() => void handleDelete(cfg.id)}
                        disabled={deleting === cfg.id}
                        style={{ minHeight: 44, borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", background: deleting === cfg.id ? "rgba(239,68,68,0.05)" : "transparent", color: "#f87171", fontWeight: 600, cursor: deleting === cfg.id ? "not-allowed" : "pointer", opacity: deleting === cfg.id ? 0.6 : 1 }}
                      >
                        {deleting === cfg.id ? "削除中..." : "削除"}
                      </button>
                      {!cfg.is_default && (
                        <button
                          className="av-btn-sm"
                          onClick={() => setWarningTarget({ id: cfg.id, tenantId: cfg.tenant_id, name: cfg.name })}
                          style={{ minHeight: 44, borderRadius: 8, border: "1px solid rgba(251,191,36,0.4)", background: "rgba(251,191,36,0.08)", color: "#fbbf24", fontWeight: 600, cursor: "pointer", marginLeft: "auto" }}
                        >
                          ⚠️ 警告
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {warningTarget && (
        <AvatarWarningModal
          target={warningTarget}
          onClose={() => setWarningTarget(null)}
        />
      )}
    </div>
  );
}
