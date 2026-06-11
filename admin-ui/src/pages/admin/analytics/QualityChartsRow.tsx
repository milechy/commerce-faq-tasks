import { Doughnut, Radar, Pie } from "react-chartjs-2";
import type { DoughnutChartData, RadarChartData, PieChartData } from "./types";
import { chartCardStyle } from "./utils";

interface QualityChartsRowProps {
  doughnutData: DoughnutChartData | null;
  radarData: RadarChartData | null;
  sentimentPieData: PieChartData | null;
}

export function QualityChartsRow({ doughnutData, radarData, sentimentPieData }: QualityChartsRowProps) {
  return (
    <>
      {/* Charts row: Doughnut + Radar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          marginBottom: 20,
        }}
      >
        {/* Doughnut: スコア分布 */}
        {doughnutData && (
          <div style={{ ...chartCardStyle, flex: "1 1 280px", marginBottom: 0 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
              AI応答品質スコアの分布
            </h3>
            <div style={{ height: 200, display: "flex", justifyContent: "center" }}>
              <Doughnut
                data={doughnutData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: "bottom",
                      labels: { color: "var(--muted-foreground)", font: { size: 11 }, padding: 10 },
                    },
                  },
                }}
              />
            </div>
          </div>
        )}

        {/* Radar: 4軸平均 */}
        {radarData && (
          <div style={{ ...chartCardStyle, flex: "1 1 280px", marginBottom: 0 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
              AI対応の4項目評価
            </h3>
            <div style={{ height: 200 }}>
              <Radar
                data={radarData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  scales: {
                    r: {
                      min: 0,
                      max: 100,
                      ticks: { color: "var(--muted-foreground)", font: { size: 10 }, stepSize: 25 },
                      grid: { color: "rgba(255,255,255,0.08)" },
                      angleLines: { color: "rgba(255,255,255,0.08)" },
                      pointLabels: { color: "var(--muted-foreground)", font: { size: 11 } },
                    },
                  },
                  plugins: {
                    legend: { display: false },
                  },
                }}
              />
            </div>
          </div>
        )}

        {/* Pie: センチメント分布 */}
        {sentimentPieData && (
          <div style={{ ...chartCardStyle, flex: "1 1 280px", marginBottom: 0 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
              お客様の反応の分布
            </h3>
            <div style={{ height: 200, display: "flex", justifyContent: "center" }}>
              <Pie
                data={sentimentPieData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: "bottom",
                      labels: { color: "var(--muted-foreground)", font: { size: 11 }, padding: 10 },
                    },
                  },
                }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
