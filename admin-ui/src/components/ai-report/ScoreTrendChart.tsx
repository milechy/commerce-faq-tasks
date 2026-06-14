import type { ScoreTrend } from "./types";

export function ScoreTrendChart({ data }: { data: ScoreTrend[] }) {
  if (data.length === 0) return null;
  const chartW = 560;
  const chartH = 100;
  const vals = data.map((d) => d.avg_score);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;

  const pts = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * chartW;
    const y = chartH - ((d.avg_score - min) / range) * chartH;
    return `${x},${y}`;
  });

  const labelStep = Math.max(1, Math.floor(data.length / 6));

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${chartW} ${chartH + 28}`}
        style={{ width: "100%", minWidth: 280, display: "block" }}
        aria-label="日別平均スコア推移"
      >
        {/* グリッドライン */}
        {[0, 50, 100].map((v) => {
          const y = chartH - ((v - min) / range) * chartH;
          return (
            <g key={v}>
              <line x1={0} y1={y} x2={chartW} y2={y} stroke="#1f2937" strokeWidth={1} />
              <text x={chartW + 2} y={y + 4} fontSize={9} fill="#4b5563">{v}</text>
            </g>
          );
        })}
        {/* 折れ線 */}
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="#4ade80"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {/* 点 */}
        {data.map((d, i) => {
          const x = (i / Math.max(data.length - 1, 1)) * chartW;
          const y = chartH - ((d.avg_score - min) / range) * chartH;
          return <circle key={d.date} cx={x} cy={y} r={3} fill="#4ade80" />;
        })}
        {/* X軸ラベル */}
        {data.map((d, i) =>
          i % labelStep === 0 ? (
            <text key={d.date} x={(i / Math.max(data.length - 1, 1)) * chartW} y={chartH + 18} textAnchor="middle" fontSize={9} fill="#6b7280">
              {d.date.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}
