// admin-ui/src/components/dashboard/CVUnfiredAlert.tsx
// Phase65-3: CV未発火アラートバナー

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../lib/api";
import { useAuth } from "../../auth/useAuth";

interface SummaryCV {
  cv_count_30d: number;
  cv_days_since_first_session: number | null;
}

interface CvStatusSummary {
  not_fired_tenants: number;
  total_tenants: number;
}

const GRACE_PERIOD_DAYS = 7;

export function CVUnfiredAlert() {
  const navigate = useNavigate();
  const { user, isSuperAdmin, previewMode, previewTenantId } = useAuth();
  const [clientData, setClientData] = useState<SummaryCV | null>(null);
  const [superData, setSuperData] = useState<CvStatusSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const tenantId = previewMode
    ? previewTenantId
    : isSuperAdmin
    ? undefined
    : (user?.tenantId ?? undefined);

  useEffect(() => {
    if (dismissed) return;
    if (isSuperAdmin && !previewMode) {
      authFetch(`${API_BASE}/v1/admin/analytics/cv-status`)
        .then((r) => (r.ok ? (r.json() as Promise<CvStatusSummary>) : null))
        .then((d) => { if (d) setSuperData(d); })
        .catch(() => {/* silent */});
    } else {
      const params = new URLSearchParams({ period: "30d" });
      if (tenantId) params.set("tenant", tenantId);
      authFetch(`${API_BASE}/v1/admin/analytics/summary?${params}`)
        .then((r) => (r.ok ? (r.json() as Promise<SummaryCV>) : null))
        .then((d) => { if (d) setClientData(d); })
        .catch(() => {/* silent */});
    }
  }, [isSuperAdmin, previewMode, tenantId, dismissed]);

  if (dismissed) return null;

  // Super Admin: show count of unfired tenants
  if (isSuperAdmin && !previewMode) {
    if (!superData || superData.not_fired_tenants === 0) return null;
    return (
      <div
        style={{
          marginBottom: 20,
          padding: "14px 18px",
          borderRadius: 12,
          background: "rgba(234,88,12,0.15)",
          border: "1px solid rgba(234,88,12,0.35)",
          color: "#fdba74",
          fontSize: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <span>
          🟠 <strong>{superData.not_fired_tenants}</strong> 件のテナントで過去30日のCVが記録されていません
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => navigate("/admin/analytics/cv-status")}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid rgba(234,88,12,0.5)",
              background: "rgba(234,88,12,0.2)",
              color: "#fdba74",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            一覧を見る
          </button>
          <button
            onClick={() => setDismissed(true)}
            style={{
              padding: "6px 10px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid rgba(107,114,128,0.3)",
              background: "transparent",
              color: "#6b7280",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  // Client Admin: show when cv=0 and past grace period
  if (!clientData) return null;
  const { cv_count_30d, cv_days_since_first_session } = clientData;
  if (cv_count_30d > 0) return null;
  if (cv_days_since_first_session !== null && cv_days_since_first_session < GRACE_PERIOD_DAYS) return null;

  const currentTenantId = previewMode ? previewTenantId : user?.tenantId;

  return (
    <div
      style={{
        marginBottom: 20,
        padding: "14px 18px",
        borderRadius: 12,
        background: "rgba(202,138,4,0.12)",
        border: "1px solid rgba(202,138,4,0.35)",
        color: "#fde68a",
        fontSize: 14,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          ⚠️ コンバージョンが記録されていません
        </div>
        <div style={{ fontSize: 13, color: "#fcd34d" }}>
          過去30日間、サイトからCVイベントが届いていません。ウィジェットの搭載状況を確認してください。
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
        {currentTenantId && (
          <button
            onClick={() => navigate(`/admin/tenants/${currentTenantId}?tab=embed`)}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid rgba(202,138,4,0.5)",
              background: "rgba(202,138,4,0.2)",
              color: "#fde68a",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            搭載状況を確認
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          style={{
            padding: "6px 10px",
            minHeight: 36,
            borderRadius: 8,
            border: "1px solid rgba(107,114,128,0.3)",
            background: "transparent",
            color: "#6b7280",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
