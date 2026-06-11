import type { Dispatch, SetStateAction } from "react";
import { Line, Bar, Doughnut } from "react-chartjs-2";
import type { ConversionResponse, LineChartData, BarChartData, DoughnutChartData } from "./types";
import { cardStyle, chartCardStyle } from "./utils";

interface ConversionSectionProps {
  conversion: ConversionResponse;
  convTrendLineData: LineChartData | null;
  outcomePieData: DoughnutChartData | null;
  stageDropoutBarData: BarChartData | null;
  sortedTechniques: ConversionResponse["technique_effectiveness"];
  techSortAsc: boolean;
  setTechSortAsc: Dispatch<SetStateAction<boolean>>;
}

export function ConversionSection({
  conversion,
  convTrendLineData,
  outcomePieData,
  stageDropoutBarData,
  sortedTechniques,
  techSortAsc,
  setTechSortAsc,
}: ConversionSectionProps) {
  return (
    <>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--foreground)",
          marginTop: 40,
          marginBottom: 16,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 10,
        }}
      >
        🎯 成果・コンバージョン分析
      </h2>

      {/* KPI Cards */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>📊</span>
          <span style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", lineHeight: 1 }}>
            {conversion.summary.total_sessions}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>総セッション数</span>
        </div>
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>✅</span>
          <span style={{ fontSize: 28, fontWeight: 700, color: "#34d399", lineHeight: 1 }}>
            {conversion.summary.recorded_outcomes}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>成果記録数</span>
        </div>
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>📝</span>
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              lineHeight: 1,
              color:
                conversion.summary.recording_rate >= 70
                  ? "#4ade80"
                  : conversion.summary.recording_rate >= 40
                  ? "#fbbf24"
                  : "#f87171",
            }}
          >
            {conversion.summary.recording_rate.toFixed(1)}%
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>成果記録率</span>
        </div>
        {/* コンバージョン率: 離脱・不明を除いた割合 */}
        {(() => {
          const positiveCount = Object.entries(conversion.summary.outcomes)
            .filter(([k]) => k !== "離脱" && k !== "不明")
            .reduce((sum, [, v]) => sum + v, 0);
          const convRate =
            conversion.summary.total_sessions > 0
              ? (positiveCount / conversion.summary.total_sessions) * 100
              : 0;
          return (
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>🏆</span>
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  lineHeight: 1,
                  color:
                    convRate >= 30 ? "#4ade80" : convRate >= 15 ? "#fbbf24" : "#f87171",
                }}
              >
                {convRate.toFixed(1)}%
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>成約率</span>
              <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>離脱・不明を除く</span>
            </div>
          );
        })()}
      </div>

      {/* Trend + Outcome row */}
      <div style={{ display: "flex", gap: 20, marginBottom: 20, flexWrap: "wrap" }}>
        {/* Conversion rate trend */}
        {convTrendLineData && (
          <div style={{ ...chartCardStyle, flex: "2 1 320px", marginBottom: 0 }}>
            <div style={{ fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 12, fontSize: 14 }}>
              成約率の変化
            </div>
            <div style={{ height: 200 }}>
              <Line
                data={convTrendLineData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: {
                    x: {
                      ticks: { color: "var(--muted-foreground)", maxTicksLimit: 7 },
                      grid: { color: "rgba(75,85,99,0.2)" },
                    },
                    y: {
                      ticks: { color: "var(--muted-foreground)", callback: (v) => `${v}%` },
                      grid: { color: "rgba(75,85,99,0.2)" },
                      min: 0,
                    },
                  },
                }}
              />
            </div>
          </div>
        )}

        {/* Outcome pie */}
        {outcomePieData && (
          <div style={{ ...chartCardStyle, flex: "1 1 220px", marginBottom: 0 }}>
            <div style={{ fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 12, fontSize: 14 }}>
              成果内訳
            </div>
            <div style={{ height: 200 }}>
              <Doughnut
                data={outcomePieData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: "bottom",
                      labels: { color: "var(--muted-foreground)", font: { size: 11 }, boxWidth: 12 },
                    },
                  },
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Technique effectiveness table */}
      {sortedTechniques.length > 0 && (
        <div style={{ ...chartCardStyle }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--muted-foreground)", fontSize: 14 }}>
              AIテクニック別 成約率
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["テクニック", "使用会話数", "成約数"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 12px",
                        textAlign: "left",
                        color: "var(--muted-foreground)",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                  <th
                    style={{
                      padding: "8px 12px",
                      textAlign: "left",
                      color: "var(--muted-foreground)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                    onClick={() => setTechSortAsc((p) => !p)}
                  >
                    CVR {techSortAsc ? "▲" : "▼"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedTechniques.map((t) => (
                  <tr key={t.technique} style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600, color: "var(--foreground)" }}>
                      {t.technique}
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--muted-foreground)", textAlign: "center" }}>
                      {t.sessions_used}
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--muted-foreground)", textAlign: "center" }}>
                      {t.converted}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            t.conversion_rate >= 60
                              ? "#4ade80"
                              : t.conversion_rate >= 30
                              ? "#fbbf24"
                              : "#f87171",
                        }}
                      >
                        {t.conversion_rate.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stage dropout bar chart */}
      {stageDropoutBarData && (
        <div style={chartCardStyle}>
          <div style={{ fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 12, fontSize: 14 }}>
            会話ステージ別の離脱分析
          </div>
          <div style={{ height: 180 }}>
            <Bar
              data={stageDropoutBarData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                  x: {
                    ticks: { color: "var(--muted-foreground)" },
                    grid: { display: false },
                  },
                  y: {
                    ticks: { color: "var(--muted-foreground)" },
                    grid: { color: "rgba(75,85,99,0.2)" },
                  },
                },
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
