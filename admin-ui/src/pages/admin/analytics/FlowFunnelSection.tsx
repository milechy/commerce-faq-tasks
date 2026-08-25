// admin-ui/src/pages/admin/analytics/FlowFunnelSection.tsx
// Phase72-C: State Machine 遷移ファネル可視化セクション

import { useState, useEffect } from "react";
import { Bar } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";
import { chartCardStyle } from "./utils";
import { parseFlowTransitionsResponse, type FlowTransitionsResponse } from "./flowTransitions.schema";

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

function stateLabel(state: string | null): string {
  if (state === null) return "(開始)";
  return STATE_LABELS[state] ?? state;
}

// サーバーは confirm_rate_pct / completion_rate_pct を「既に100倍した実数」で
// 返す(safeRate() が n/d*100 を計算済み)。ここで再度 *100 すると二重に
// 100倍してしまうため、そのまま小数第1位で表示する。
function formatPct(ratePct: number): string {
  return `${ratePct.toFixed(1)}%`;
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
        return r.json();
      })
      // サーバーの実レスポンスを実行時に検証する。ここを通さず `as` で
      // キャストしていたために、フィールド名が食い違っても tsc が
      // 気付けなかった(P0-1の直接の原因)。
      .then((raw) => setData(parseFlowTransitionsResponse(raw)))
      .catch(() =>
        setError("フロー遷移データの読み込みに失敗しました。しばらく経ってから再度お試しください。"),
      )
      .finally(() => setLoading(false));
  }, [period, tenantId, isSuperAdmin]);

  // サーバーは clarify(質問確認)/loop_abort(ループ中断)に相当する値を
  // 返さない(funnelにそのフィールドが無い)。存在しない指標を0で埋めて
  // 出すと「計測しているが常に0」に見え、本当に0件なのか未計測なのか
  // 区別できなくなるため、サーバーが実際に返す4指標だけを表示する。
  const funnelBarData = data
    ? {
        labels: ["回答到達", "クロージング到達", "完了", "完了(正常終了)"],
        datasets: [
          {
            label: "件数",
            data: [
              data.funnel.to_answer_count,
              data.funnel.to_confirm_count,
              data.funnel.to_terminal_count,
              data.funnel.completed_count,
            ],
            backgroundColor: [
              "rgba(96, 165, 250, 0.75)",
              "rgba(251, 191, 36, 0.75)",
              "rgba(99, 102, 241, 0.75)",
              "rgba(52, 211, 153, 0.75)",
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
          label: (ctx: { parsed: { y: number } }) => `${ctx.parsed.y.toLocaleString()}件`,
        },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          color: "var(--muted-foreground)",
          precision: 0,
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
            総遷移数:{" "}
            <span style={{ fontWeight: 700, color: "var(--foreground)", fontSize: 18 }}>
              {data.total_transitions.toLocaleString()}
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
ステージ別到達件数
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
                          {t.transition_count.toLocaleString()}
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
              { label: "クロージング到達率", value: formatPct(data.funnel.confirm_rate_pct) },
              { label: "完了率(クロージング中)", value: formatPct(data.funnel.completion_rate_pct) },
              { label: "回答到達", value: `${data.funnel.to_answer_count.toLocaleString()}件` },
              { label: "クロージング到達", value: `${data.funnel.to_confirm_count.toLocaleString()}件` },
              { label: "完了(正常終了)", value: `${data.funnel.completed_count.toLocaleString()}件` },
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
