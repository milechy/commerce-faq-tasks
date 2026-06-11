// admin-ui/src/pages/admin/avatar/AvatarFilterPanel.tsx
// index.tsx から抽出 — ソート / フィルタパネル（機能変更なし）

import { useLang } from "../../../i18n/LangContext";
import type { SortKey, TypeFilter, StatusFilter } from "./types";
import { toggleBtnStyle } from "./utils";

export function AvatarFilterPanel({
  isSuperAdmin,
  sortKey,
  setSortKey,
  tenantFilter,
  setTenantFilter,
  tenantList,
  typeFilter,
  setTypeFilter,
  statusFilter,
  setStatusFilter,
}: {
  isSuperAdmin: boolean;
  sortKey: SortKey;
  setSortKey: (v: SortKey) => void;
  tenantFilter: string;
  setTenantFilter: (v: string) => void;
  tenantList: { id: string; name: string }[];
  typeFilter: TypeFilter;
  setTypeFilter: (v: TypeFilter) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
}) {
  const { lang } = useLang();

  return (
    <div className="av-filter-panel" style={{
      marginBottom: 24,
      padding: "16px 20px",
      borderRadius: 14,
      border: "1px solid rgba(99,102,241,0.3)",
      background: "var(--card)",
    }}>
      {/* ソート */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--muted-foreground)", minWidth: 48 }}>
          {lang === "ja" ? "ソート:" : "Sort:"}
        </span>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          style={{
            padding: "8px 12px",
            minHeight: 44,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--input)",
            color: "var(--foreground)",
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
          <span style={{ fontSize: 13, color: "var(--muted-foreground)", minWidth: 48 }}>
            {lang === "ja" ? "テナント:" : "Tenant:"}
          </span>
          <select
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            style={{
              padding: "8px 12px",
              minHeight: 44,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--input)",
              color: "var(--foreground)",
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
        <span style={{ fontSize: 13, color: "var(--muted-foreground)", minWidth: 48 }}>
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
        <span style={{ fontSize: 13, color: "var(--muted-foreground)", minWidth: 48 }}>
          {lang === "ja" ? "状態:" : "Status:"}
        </span>
        {(["all", "active", "inactive"] as StatusFilter[]).map((v) => (
          <button key={v} onClick={() => setStatusFilter(v)} style={toggleBtnStyle(statusFilter === v)}>
            {v === "all" ? (lang === "ja" ? "全て" : "All") : v === "active" ? (lang === "ja" ? "アクティブ" : "Active") : (lang === "ja" ? "無効" : "Inactive")}
          </button>
        ))}
      </div>
    </div>
  );
}
