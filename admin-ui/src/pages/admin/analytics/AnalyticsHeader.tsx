import type { Dispatch, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { Tenant } from "./types";
import { PERIOD_LABELS } from "./utils";

interface AnalyticsHeaderProps {
  navigate: NavigateFunction;
  isSuperAdmin: boolean;
  selectedTenantName: string;
  tenantFilter: string;
  setTenantFilter: Dispatch<SetStateAction<string>>;
  tenants: Tenant[];
  period: string;
  setPeriod: Dispatch<SetStateAction<string>>;
}

export function AnalyticsHeader({
  navigate,
  isSuperAdmin,
  selectedTenantName,
  tenantFilter,
  setTenantFilter,
  tenants,
  period,
  setPeriod,
}: AnalyticsHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: 28,
        flexWrap: "wrap",
        gap: 12,
      }}
    >
      <div>
        <button
          onClick={() => navigate("/admin")}
          style={{
            background: "none",
            border: "none",
            color: "var(--muted-foreground)",
            fontSize: 14,
            cursor: "pointer",
            padding: 0,
            marginBottom: 8,
            display: "block",
          }}
        >
          ← 管理画面へ戻る
        </button>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "var(--foreground)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          📈 チャット成績レポート
          {isSuperAdmin && (
            <span style={{ fontSize: 16, fontWeight: 400, color: "var(--muted-foreground)", marginLeft: 10 }}>
              — {selectedTenantName}
            </span>
          )}
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
          会話の件数・品質・お客様の反応を確認できます
        </p>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {isSuperAdmin && (
          <select
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--card)",
              color: "var(--foreground)",
              fontSize: 14,
              minWidth: 160,
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            <option value="">全テナント</option>
            {tenants
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name, "ja"))
              .map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
          </select>
        )}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--card)",
            color: "var(--foreground)",
            fontSize: 14,
            minHeight: 44,
            cursor: "pointer",
          }}
        >
          {Object.entries(PERIOD_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>
    </header>
  );
}
