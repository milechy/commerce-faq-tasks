// admin-ui/src/pages/admin/analytics/cv-status.tsx
// Phase65-3: CV発火状況一覧 (Super Admin 専用)

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";

interface CvTenantRow {
  tenant_id: string;
  tenant_name: string;
  cv_count_30d: number;
  cv_fired_status: "fired" | "not_fired";
  days_since_effective_start: number;
  last_cv_at: string | null;
}

interface CvStatusResponse {
  total_tenants: number;
  fired_tenants: number;
  not_fired_tenants: number;
  tenants: CvTenantRow[];
}

export default function CvStatusPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<CvStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`${API_BASE}/v1/admin/analytics/cv-status`)
      .then((r) => {
        if (!r.ok) throw new Error("取得失敗");
        return r.json() as Promise<CvStatusResponse>;
      })
      .then(setData)
      .catch(() => setError("CV発火状況の取得に失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  const cardStyle: React.CSSProperties = {
    flex: "1 1 140px",
    borderRadius: 14,
    border: "1px solid var(--border)",
    background: "linear-gradient(145deg, var(--card), var(--card))",
    padding: "20px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "24px 20px",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin/analytics")}
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
          ← 分析ダッシュボードへ戻る
        </button>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
          📉 CV発火状況一覧
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
          過去30日間のCV記録状況をテナント別に確認できます（Super Admin専用）
        </p>
      </header>

      {error && (
        <div
          style={{
            marginBottom: 20,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 60, textAlign: "center", color: "var(--muted-foreground)" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込み中...
        </div>
      ) : data ? (
        <>
          {/* KPI カード */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 28 }}>
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>🏢</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", lineHeight: 1 }}>
                {data.total_tenants}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>総テナント数</span>
            </div>
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>✅</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: "#34d399", lineHeight: 1 }}>
                {data.fired_tenants}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>CV発火済み</span>
            </div>
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>📉</span>
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  lineHeight: 1,
                  color: data.not_fired_tenants > 0 ? "#f87171" : "#34d399",
                }}
              >
                {data.not_fired_tenants}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>未発火</span>
            </div>
          </div>

          {/* テナント一覧テーブル */}
          <div
            style={{
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "linear-gradient(145deg, var(--card), var(--card))",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)" }}>
                テナント別CV状況
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["テナント名", "経過日数", "CV件数(30日)", "最終CV日時", "ステータス", ""].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 14px",
                          textAlign: "left",
                          color: "var(--muted-foreground)",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.tenants.map((t) => (
                    <tr
                      key={t.tenant_id}
                      style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}
                    >
                      <td style={{ padding: "12px 14px", fontWeight: 600, color: "var(--foreground)" }}>
                        {t.tenant_name}
                      </td>
                      <td style={{ padding: "12px 14px", color: "var(--muted-foreground)", textAlign: "center" }}>
                        {t.days_since_effective_start}日
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "center",
                          fontWeight: 700,
                          color: t.cv_count_30d > 0 ? "#34d399" : "#f87171",
                        }}
                      >
                        {t.cv_count_30d}
                      </td>
                      <td style={{ padding: "12px 14px", color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>
                        {t.last_cv_at
                          ? new Date(t.last_cv_at).toLocaleDateString("ja-JP", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        <span
                          style={{
                            padding: "3px 10px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            background:
                              t.cv_fired_status === "fired"
                                ? "rgba(52,211,153,0.15)"
                                : "rgba(248,113,113,0.15)",
                            border: `1px solid ${
                              t.cv_fired_status === "fired"
                                ? "rgba(52,211,153,0.4)"
                                : "rgba(248,113,113,0.4)"
                            }`,
                            color: t.cv_fired_status === "fired" ? "#34d399" : "#f87171",
                          }}
                        >
                          {t.cv_fired_status === "fired" ? "✅ 発火" : "⚠️ 未発火"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        <button
                          onClick={() => navigate(`/admin/tenants/${t.tenant_id}`)}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "transparent",
                            color: "#60a5fa",
                            fontSize: 12,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          詳細 →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
