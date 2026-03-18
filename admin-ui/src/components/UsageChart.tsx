interface DailyUsage {
  date: string;
  requests: number;
  cost_total_cents: number;
}

interface UsageChartProps {
  data: DailyUsage[];
  mode: "requests" | "cost";
}

export default function UsageChart({ data, mode }: UsageChartProps) {
  if (data.length === 0) {
    return (
      <div
        style={{
          padding: "32px",
          textAlign: "center",
          color: "#6b7280",
          fontSize: 14,
        }}
      >
        表示するデータがありません
      </div>
    );
  }

  const values = data.map((d) =>
    mode === "requests" ? d.requests : d.cost_total_cents
  );
  const maxVal = Math.max(...values, 1);

  const chartWidth = 600;
  const chartHeight = 120;
  const barGap = 4;
  const barWidth = Math.max(
    4,
    Math.floor((chartWidth - barGap * (data.length - 1)) / data.length)
  );

  const formatLabel = (val: number) =>
    mode === "requests"
      ? val.toLocaleString()
      : `¥${Math.round(val / 100).toLocaleString()}`;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight + 32}`}
        style={{ width: "100%", minWidth: 280, display: "block" }}
        aria-label={mode === "requests" ? "日次リクエスト数グラフ" : "日次コストグラフ"}
      >
        {values.map((val, i) => {
          const barH = Math.max(2, Math.round((val / maxVal) * chartHeight));
          const x = i * (barWidth + barGap);
          const y = chartHeight - barH;
          const isLast = i === data.length - 1;
          const labelColor = isLast ? "#4ade80" : "#22c55e";

          return (
            <g key={data[i].date}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={3}
                fill={isLast ? "#4ade80" : "#22c55e"}
                opacity={0.85}
              />
              {/* 値ラベル（最大値バーのみ表示） */}
              {val === maxVal && (
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill={labelColor}
                >
                  {formatLabel(val)}
                </text>
              )}
              {/* 日付ラベル（5本おきに表示） */}
              {i % Math.max(1, Math.floor(data.length / 6)) === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 20}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#6b7280"
                >
                  {data[i].date.slice(8, 10)}日
                </text>
              )}
            </g>
          );
        })}
        {/* ゼロライン */}
        <line
          x1={0}
          y1={chartHeight}
          x2={chartWidth}
          y2={chartHeight}
          stroke="#1f2937"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}
