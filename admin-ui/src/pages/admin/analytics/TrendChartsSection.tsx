import { Line, Bar } from "react-chartjs-2";
import type { LineChartData, BarChartData } from "./types";
import { chartCardStyle } from "./utils";

interface TrendChartsSectionProps {
  lineData: LineChartData | null;
  stackedBarData: BarChartData | null;
}

export function TrendChartsSection({ lineData, stackedBarData }: TrendChartsSectionProps) {
  return (
    <>
      {/* Line Chart: 会話数トレンド */}
      {lineData && (
        <div style={chartCardStyle}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
            会話数の変化
          </h3>
          <div style={{ height: 220 }}>
            <Line
              data={lineData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                  x: {
                    ticks: { color: "var(--muted-foreground)", maxTicksLimit: 8, font: { size: 11 } },
                    grid: { color: "rgba(255,255,255,0.05)" },
                  },
                  y: {
                    ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
                    grid: { color: "rgba(255,255,255,0.05)" },
                    beginAtZero: true,
                  },
                },
              }}
            />
          </div>
        </div>
      )}

      {/* Sentiment Stacked Bar Chart */}
      {stackedBarData && (
        <div style={chartCardStyle}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
            お客様の反応の変化
          </h3>
          <div style={{ height: 220 }}>
            <Bar
              data={stackedBarData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    position: "bottom",
                    labels: { color: "var(--muted-foreground)", font: { size: 11 }, padding: 10 },
                  },
                },
                scales: {
                  x: {
                    stacked: true,
                    ticks: { color: "var(--muted-foreground)", maxTicksLimit: 8, font: { size: 11 } },
                    grid: { color: "rgba(255,255,255,0.05)" },
                  },
                  y: {
                    stacked: true,
                    ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
                    grid: { color: "rgba(255,255,255,0.05)" },
                    beginAtZero: true,
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
