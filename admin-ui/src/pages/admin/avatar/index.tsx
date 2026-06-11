// admin-ui/src/pages/admin/avatar/index.tsx
// Avatar Customization Studio — config list page

import { useState, useEffect, useCallback, useMemo } from "react";
import { useLang } from "../../../i18n/LangContext";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import type { AvatarConfig, SortKey, TypeFilter, StatusFilter, WarningTarget } from "./types";
import { BG } from "./types";
import { AvatarWarningModal } from "./AvatarWarningModal";
import { AvatarListHeader } from "./AvatarListHeader";
import { AvatarFilterPanel } from "./AvatarFilterPanel";
import { AvatarFeatureToggle } from "./AvatarFeatureToggle";
import { AvatarCard } from "./AvatarCard";

export default function AvatarListPage() {
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

    // テナントフィルタ（strict tenant_id 一致のみ）
    if (tenantFilter !== "all") {
      result = result.filter((c) => (c.tenant_id ?? "") === tenantFilter);
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

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "var(--foreground)", padding: "24px 20px", maxWidth: 1200, margin: "0 auto" }}>
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
      <AvatarListHeader
        loading={loading}
        isSuperAdmin={isSuperAdmin}
        displayedConfigs={displayedConfigs}
        total={total}
      />

      {/* ── ソート / フィルタパネル ─────────────────────────────── */}
      {!loading && (
        <AvatarFilterPanel
          isSuperAdmin={isSuperAdmin}
          sortKey={sortKey}
          setSortKey={setSortKey}
          tenantFilter={tenantFilter}
          setTenantFilter={setTenantFilter}
          tenantList={tenantList}
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
        />
      )}

      {/* ── アバター機能 ON/OFF トグル（Client Adminのみ）─────────────────────────────── */}
      {!isSuperAdmin && user?.tenantId && (
        <AvatarFeatureToggle
          avatarEnabled={avatarEnabled}
          toggleLoading={toggleLoading}
          tenantFeatures={tenantFeatures}
          handleAvatarToggle={handleAvatarToggle}
          toggleToast={toggleToast}
        />
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
        <div style={{ textAlign: "center", color: "var(--muted-foreground)", paddingTop: 60, fontSize: 15 }}>
          {lang === "ja" ? "読み込み中..." : "Loading..."}
        </div>
      ) : displayedConfigs.length === 0 ? (
        <div style={{
          textAlign: "center",
          padding: "60px 20px",
          borderRadius: 14,
          border: "1px dashed #374151",
          color: "var(--muted-foreground)",
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
            <AvatarCard
              key={cfg.id}
              cfg={cfg}
              isSuperAdmin={isSuperAdmin}
              avatarEnabled={avatarEnabled}
              activating={activating}
              deleting={deleting}
              handleActivate={handleActivate}
              handleDelete={handleDelete}
              setWarningTarget={setWarningTarget}
              formatDate={formatDate}
            />
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
