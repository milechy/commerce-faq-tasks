// admin-ui/src/pages/admin/analytics/AvatarSettingsSection.tsx
// Phase72-B: アバター設定利用率 可視化セクション (super_admin only)

import { useState, useEffect } from "react";
import { Bar, Doughnut } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";
import { cardStyle, chartCardStyle } from "./utils";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

interface AvatarSettingsSummary {
  total_tenants: number;
  tenants_with_avatar: number;
  idle_prompt_configured_rate: number | null;
  custom_prompt_rate: number | null;
  custom_voice_rate: number | null;
  avatar_provider_distribution: { provider: string; count: number }[];
  template_id_top10: { id: string; name: string | null; count: number }[];
}

// ---------------------------------------------------------------------------
// KPI カード
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div style={cardStyle}>
      <div
        style={{
          fontSize: 12,
          color: "var(--muted-foreground)",
          fontWeight: 500,
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: "var(--foreground)",
          lineHeight: 1.2,
        }}
      >
        {value}
        {unit && (
          <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4, color: "var(--muted-foreground)" }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function AvatarSettingsSection() {
  const [data, setData] = useState<AvatarSettingsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    authFetch(`${API_BASE}/v1/admin/analytics/avatar-settings-summary`)
      .then((r) => {
        if (!r.ok) throw new Error("fetch_failed");
        return r.json() as Promise<AvatarSettingsSummary>;
      })
      .then((d) => setData(d))
      .catch(() => setError("アバター設定データの読み込みに失敗しました。しばらく経ってから再度お試しください。"))
      .finally(() => setLoading(false));
  }, []);

  const formatRate = (v: number | null) =>
    v != null ? `${v}` : "ー";

  // Bar chart: template_id_top10
  const top10BarData = data
    ? {
        labels: data.template_id_top10.map((t) => t.name ?? t.id),
        datasets: [
          {
            label: "テナント数",
            data: data.template_id_top10.map((t) => t.count),
            backgroundColor: "rgba(99, 102, 241, 0.7)",
            borderRadius: 6,
          },
        ],
      }
    : null;

  // Doughnut chart: avatar_provider_distribution
  const providerColors = [
    "rgba(99, 102, 241, 0.8)",
    "rgba(34, 197, 94, 0.8)",
    "rgba(251, 191, 36, 0.8)",
    "rgba(239, 68, 68, 0.8)",
    "rgba(6, 182, 212, 0.8)",
  ];
  const providerDoughnutData = data
    ? {
        labels: data.avatar_provider_distribution.map((p) => p.provider),
        datasets: [
          {
            data: data.avatar_provider_distribution.map((p) => p.count),
            backgroundColor: providerColors,
            borderWidth: 1,
          },
        ],
      }
    : null;

  const barOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      title: { display: false },
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { color: "var(--muted-foreground)", stepSize: 1 },
        grid: { color: "rgba(255,255,255,0.05)" },
      },
      x: {
        ticks: {
          color: "var(--muted-foreground)",
          maxRotation: 30,
          font: { size: 11 },
        },
        grid: { display: false },
      },
    },
  };

  const doughnutOptions = {
    responsive: true,
    plugins: {
      legend: {
        position: "right" as const,
        labels: { color: "var(--foreground)", font: { size: 12 } },
      },
    },
  };

  return (
    <section style={{ marginTop: 32 }}>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--foreground)",
          marginBottom: 16,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 10,
        }}
      >
        アバター設定 利用率
      </h2>

      {error && (
        <div
          style={{
            marginBottom: 20,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>
          読み込み中...
        </div>
      ) : data ? (
        <>
          {/* KPI カード 4枚 */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginBottom: 24,
            }}
          >
            <KpiCard
              label="アイドルプロンプト設定率"
              value={formatRate(data.idle_prompt_configured_rate)}
              unit="%"
            />
            <KpiCard
              label="アバター有効テナント数"
              value={String(data.tenants_with_avatar)}
              unit={`/ ${data.total_tenants}`}
            />
            <KpiCard
              label="カスタムプロンプト設定率"
              value={formatRate(data.custom_prompt_rate)}
              unit="%"
            />
            <KpiCard
              label="カスタムボイス設定率"
              value={formatRate(data.custom_voice_rate)}
              unit="%"
            />
          </div>

          {/* テンプレート利用 Top 10 (Bar) */}
          {top10BarData && data.template_id_top10.length > 0 && (
            <div style={chartCardStyle}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--foreground)",
                  marginBottom: 14,
                }}
              >
                テンプレート利用 Top 10
              </div>
              <Bar data={top10BarData} options={barOptions} />
            </div>
          )}

          {/* プロバイダ分布 (Doughnut) */}
          {providerDoughnutData && data.avatar_provider_distribution.length > 0 && (
            <div style={{ ...chartCardStyle, display: "flex", justifyContent: "center" }}>
              <div style={{ width: "100%", maxWidth: 480 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--foreground)",
                    marginBottom: 14,
                  }}
                >
                  アバタープロバイダ分布
                </div>
                <Doughnut data={providerDoughnutData} options={doughnutOptions} />
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
