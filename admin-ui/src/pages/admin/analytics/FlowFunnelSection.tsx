// admin-ui/src/pages/admin/analytics/FlowFunnelSection.tsx
// Phase72-C: State Machine 遷移ファネル可視化セクション

import { useState, useEffect } from "react";
import { Bar } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";
import { chartCardStyle } from "./utils";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

interface FlowTransitionsResponse {
  period: string;
  total_sessions: number;
  transitions: Array<{
    from_state: string;
    to_state: string;
    count: number;
  }>;
  funnel: {
    clarify_rate: number;
    answer_rate: number;
    confirm_rate: number;
    terminal_rate: number;
    loop_abort_rate: number;
  };
}

interface FlowFunnelSectionProps {
  period: string;
  tenantId: string | undefined;
  isSuperAdmin: boolean;
}

// ---------------------------------------------------------------------------
// ラベルマッピング
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<string, string> = {
  clarify: "質問確認",
  answer: "回答",
  confirm: "クロージング",
  terminal: "完了",
};

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function FlowFunnelSection({ period, tenantId, isSuperAdmin }: FlowFunnelSectionProps) {
  const [data, setData] = useState<FlowTransitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);

    const params = new URLSearchParams({ period });
    if (tenantId) {
      params.set("tenant_id", tenantId);
    } else if (isSuperAdmin) {
      // super_admin は全テナント集計（tenant_id 省略）
    }

    authFetch(`${API_BASE}/v1/admin/analytics/flow-transitions?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error("fetch_failed");
        return r.json() as Promise<FlowTransitionsResponse>;
      })
      .then((d) => setData(d))
      .catch(() =>
        setError("フロー遷移データの読み込みに失敗しました。しばらく経ってから再度お試しください。"),
      )
      .finally(() => setLoading(false));
  }, [period, tenantId, isSuperAdmin]);

  const funnelBarData = data
    ? {
        labels: ["質問確認", "回答", "クロージング", "完了", "ループ中断"],
        datasets: [
          {
            label: "到達率",
            data: [
              data.funnel.clarify_rate * 100,
              data.funnel.answer_rate * 100,
              data.funnel.confirm_rate * 100,
              data.funnel.terminal_rate * 100,
              data.funnel.loop_abort_rate * 100,
            ],
            backgroundColor: [
              "rgba(96, 165, 250, 0.75)",
              "rgba(52, 211, 153, 0.75)",
              "rgba(251, 191, 36, 0.75)",
              "rgba(99, 102, 241, 0.75)",
              "rgba(248, 113, 113, 0.75)",
            ],
            borderRadius: 6,
          },
        ],
      }
    : null;

  const barOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      title: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { y: number } }) => `${ctx.parsed.y.toFixed(1)}%`,
        },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        max: 100,
        ticks: {
          color: "var(--muted-foreground)",
          callback: (v: number | string) => `${v}%`,
        },
        grid: { color: "rgba(255,255,255,0.05)" },
      },
      x: {
        ticks: { color: "var(--muted-foreground)", font: { size: 12 } },
        grid: { display: false },
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
        会話フロー 遷移ファネル
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
          {/* セッション総数 */}
          <div
            style={{
              marginBottom: 20,
              padding: "14px 18px",
              borderRadius: 12,
              background: "var(--card)",
              border: "1px solid var(--border)",
              fontSize: 14,
              color: "var(--muted-foreground)",
            }}
          >
            集計セッション数:{" "}
            <span style={{ fontWeight: 700, color: "var(--foreground)", fontSize: 18 }}>
              {data.total_sessions.toLocaleString()}
            </span>{" "}
            件
          </div>

          {/* ファネル棒グラフ */}
          {funnelBarData && (
            <div style={chartCardStyle}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--foreground)",
                  marginBottom: 14,
                }}
              >
                ステージ別到達率（セッション比）
              </div>
              <Bar data={funnelBarData} options={barOptions as any} />
            </div>
          )}

          {/* 遷移テーブル */}
          {data.transitions.length > 0 && (
            <div style={chartCardStyle}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--foreground)",
                  marginBottom: 14,
                }}
              >
                ステート遷移一覧
              </div>
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ color: "var(--muted-foreground)" }}>
                      <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                        遷移元
                      </th>
                      <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                        遷移先
                      </th>
                      <th style={{ textAlign: "right", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                        件数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transitions.map((t, i) => (
                      <tr
                        key={`${t.from_state}-${t.to_state}-${i}`}
                        style={{
                          borderBottom: "1px solid rgba(255,255,255,0.05)",
                          color: "var(--foreground)",
                        }}
                      >
                        <td style={{ padding: "8px 12px" }}>{stateLabel(t.from_state)}</td>
                        <td style={{ padding: "8px 12px" }}>{stateLabel(t.to_state)}</td>
                        <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>
                          {t.count.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ファネル数値サマリー */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 4,
            }}
          >
            {[
              { label: "質問確認 到達率", value: formatPct(data.funnel.clarify_rate) },
              { label: "回答 到達率", value: formatPct(data.funnel.answer_rate) },
              { label: "クロージング 到達率", value: formatPct(data.funnel.confirm_rate) },
              { label: "完了 到達率", value: formatPct(data.funnel.terminal_rate) },
              { label: "ループ中断率", value: formatPct(data.funnel.loop_abort_rate) },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  flex: "1 1 140px",
                  borderRadius: 14,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  padding: "16px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                    fontWeight: 500,
                    letterSpacing: "0.04em",
                  }}
                >
                  {item.label}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    color: "var(--foreground)",
                    lineHeight: 1.2,
                  }}
                >
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
