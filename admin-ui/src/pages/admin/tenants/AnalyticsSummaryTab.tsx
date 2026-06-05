import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import { CARD_STYLE } from "./types";

interface AnalyticsSummary {
  period: string;
  conversations: { total: number; avg_per_day: number };
  cv: {
    macro: { r2c_db: number; ga4: number; posthog: number; ranked_a: number; ranked_d: number };
    micro: { r2c_db: number; ga4: number; posthog: number };
  };
  llm_usage: { tokens: number; cost_jpy: number; generations: number } | null;
  alerts: { source_mismatch_count: number; ranked_d_count: number };
}

export default function AnalyticsSummaryTab({ tenantId }: { tenantId: string }) {
  const [period, setPeriod] = useState<"last_7d" | "last_30d" | "last_90d">("last_30d");
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/analytics-summary?period=${period}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json() as AnalyticsSummary);
      } catch {
        setError("データ取得に失敗しました");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [tenantId, period]);

  const periodLabel: Record<string, string> = { last_7d: "7日間", last_30d: "30日間", last_90d: "90日間" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Period selector */}
      <div style={{ ...CARD_STYLE, display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 14, color: "#9ca3af", fontWeight: 600 }}>期間:</span>
        {(["last_7d", "last_30d", "last_90d"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            style={{
              padding: "8px 16px",
              minHeight: 36,
              borderRadius: 8,
              border: period === p ? "1px solid #4ade80" : "1px solid #374151",
              background: period === p ? "rgba(34,197,94,0.15)" : "rgba(0,0,0,0.3)",
              color: period === p ? "#4ade80" : "#9ca3af",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {periodLabel[p]}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: "#6b7280", textAlign: "center", padding: 32 }}>読み込み中...</div>}
      {error && <div style={{ color: "#f87171", padding: 16 }}>{error}</div>}

      {data && !loading && (
        <>
          {/* Conversations */}
          <div style={{ ...CARD_STYLE }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>💬 会話数</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "総会話数", value: data.conversations.total.toLocaleString() },
                { label: "1日平均", value: `${data.conversations.avg_per_day}件` },
              ].map(({ label, value }) => (
                <div key={label} style={{ padding: "16px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid #1f2937" }}>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#e5e7eb" }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* CV */}
          <div style={{ ...CARD_STYLE }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>🎯 コンバージョン</h3>
            <div style={{ display: "grid", gap: 10 }}>
              {[
                { label: "マクロCV (r2c_db)", value: data.cv.macro.r2c_db },
                { label: "マクロCV (GA4)", value: data.cv.macro.ga4 },
                { label: "マクロCV (PostHog)", value: data.cv.macro.posthog },
                { label: "マイクロCV (r2c_db)", value: data.cv.micro.r2c_db },
                { label: "マイクロCV (GA4)", value: data.cv.micro.ga4 },
                { label: "ランクA (3ソース確認済)", value: data.cv.macro.ranked_a },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937", fontSize: 14 }}>
                  <span style={{ color: "#9ca3af" }}>{label}</span>
                  <span style={{ color: "#e5e7eb", fontWeight: 600 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* LLM Usage */}
          {data.llm_usage && (
            <div style={{ ...CARD_STYLE }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>🤖 LLM使用量（今月）</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { label: "総トークン", value: data.llm_usage.tokens.toLocaleString() },
                  { label: "推定コスト", value: `¥${data.llm_usage.cost_jpy.toLocaleString()}` },
                  { label: "生成回数", value: data.llm_usage.generations.toLocaleString() },
                ].map(({ label, value }) => (
                  <div key={label} style={{ padding: "14px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid #1f2937" }}>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alerts */}
          {(data.alerts.source_mismatch_count > 0 || data.alerts.ranked_d_count > 0) && (
            <div style={{ ...CARD_STYLE, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(127,29,29,0.15)" }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#f87171", margin: "0 0 12px" }}>⚠️ アラート</h3>
              <div style={{ display: "grid", gap: 8 }}>
                {data.alerts.source_mismatch_count > 0 && (
                  <div style={{ fontSize: 14, color: "#fca5a5" }}>ソース不一致: {data.alerts.source_mismatch_count}件（同一イベントが複数ソースで記録）</div>
                )}
                {data.alerts.ranked_d_count > 0 && (
                  <div style={{ fontSize: 14, color: "#fca5a5" }}>ランクD（疑義あり）: {data.alerts.ranked_d_count}件</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
