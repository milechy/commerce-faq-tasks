import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import KpiCard from "../../../components/admin/KpiCard";
import TenantSlaTable, {
  type TenantSlaRow,
} from "../../../components/admin/TenantSlaTable";
import { API_BASE } from "../../../lib/api";

interface MonitoringKpis {
  completionRate: number;
  loopRate: number;
  fallbackRate: number;
  searchP95Ms: number;
  errorRate: number;
  killSwitchActive: boolean;
  sla: {
    completionRateMin: number;
    loopRateMax: number;
    fallbackRateMax: number;
    searchP95Max: number;
    errorRateMax: number;
  };
  tenants?: Array<{
    tenantId: string;
    tenantName: string;
    completionRate: number;
    loopRate: number;
    fallbackRate: number;
    searchP95Ms: number;
    errorRate: number;
    killSwitchActive: boolean;
    sla: {
      completionRateMin: number;
      loopRateMax: number;
      fallbackRateMax: number;
      searchP95Max: number;
      errorRateMax: number;
    };
  }>;
}

const POLL_INTERVAL_MS = 30_000;

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
  } catch {
    localStorage.removeItem("supabaseSession");
    return null;
  }
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export default function MonitoringPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MonitoringKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchKpis = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      navigate("/login", { replace: true });
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/admin/monitoring/kpis`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401 || res.status === 403) {
        navigate("/login", { replace: true });
        return;
      }

      if (!res.ok) throw new Error("fetch failed");

      const json = (await res.json()) as MonitoringKpis;
      setData(json);
      setError(false);
      setLastUpdated(new Date());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      navigate("/login", { replace: true });
      return;
    }

    fetchKpis();

    timerRef.current = setInterval(() => {
      fetchKpis();
    }, POLL_INTERVAL_MS);

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [fetchKpis, navigate]);

  const buildTenantRows = (): TenantSlaRow[] => {
    if (!data?.tenants) return [];
    return data.tenants.map((t) => ({
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      completionRateMet: t.completionRate >= t.sla.completionRateMin,
      loopRateMet: t.loopRate <= t.sla.loopRateMax,
      fallbackRateMet: t.fallbackRate <= t.sla.fallbackRateMax,
      searchP95Met: t.searchP95Ms <= t.sla.searchP95Max,
      errorRateMet: t.errorRate <= t.sla.errorRateMax,
      killSwitchOff: !t.killSwitchActive,
    }));
  };

  const sla = data?.sla ?? {
    completionRateMin: 70,
    loopRateMax: 10,
    fallbackRateMax: 30,
    searchP95Max: 1500,
    errorRateMax: 1,
  };

  const kpiCards = data
    ? [
        {
          name: "会話完了率",
          value: data.completionRate.toFixed(1),
          unit: "%",
          threshold: `${sla.completionRateMin}% 以上`,
          met: data.completionRate >= sla.completionRateMin,
          description: "お客様との会話が正常に完了した割合",
        },
        {
          name: "ループ検出率",
          value: data.loopRate.toFixed(1),
          unit: "%",
          threshold: `${sla.loopRateMax}% 以下`,
          met: data.loopRate <= sla.loopRateMax,
          description: "同じ質問が繰り返された会話の割合",
        },
        {
          name: "フォールバック率",
          value: data.fallbackRate.toFixed(1),
          unit: "%",
          threshold: `${sla.fallbackRateMax}% 以下`,
          met: data.fallbackRate <= sla.fallbackRateMax,
          description: "AIが答えられず切り替わった会話の割合",
        },
        {
          name: "応答速度（95%ile）",
          value: formatMs(data.searchP95Ms),
          unit: "",
          threshold: `${formatMs(sla.searchP95Max)} 以内`,
          met: data.searchP95Ms <= sla.searchP95Max,
          description: "95%の会話で達成している応答時間",
        },
        {
          name: "エラー率",
          value: data.errorRate.toFixed(2),
          unit: "%",
          threshold: `${sla.errorRateMax}% 以下`,
          met: data.errorRate <= sla.errorRateMax,
          description: "システムエラーが発生した会話の割合",
        },
        {
          name: "緊急停止スイッチ",
          value: data.killSwitchActive ? "稼働中" : "停止中",
          unit: "",
          threshold: "停止中 が正常",
          met: !data.killSwitchActive,
          description: data.killSwitchActive
            ? "緊急停止が有効です。AIの応答が一時停止しています"
            : "正常に稼働しています",
        },
      ]
    : [];

  const tenantRows = buildTenantRows();

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 32,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              background: "rgba(15,23,42,0.9)",
              border: "1px solid #1f2937",
              fontSize: 12,
              color: "#9ca3af",
              marginBottom: 8,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: error ? "#ef4444" : "#22c55e",
                boxShadow: error ? "0 0 6px #ef4444" : "0 0 6px #22c55e",
              }}
            />
            {error ? "接続エラー" : "接続中"}
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            KPI 監視ダッシュボード
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            サービスの品質指標をリアルタイムで確認できます
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <button
            onClick={() => navigate("/admin")}
            style={{
              padding: "10px 16px",
              minHeight: 44,
              borderRadius: 999,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 14,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            ← 管理画面に戻る
          </button>
          {lastUpdated && (
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              最終更新: {lastUpdated.toLocaleTimeString("ja-JP")}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div
          style={{
            marginBottom: 24,
            padding: "16px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 20 }}>⚠️</span>
          データの取得に失敗しました 🙏 自動的に再試行します
        </div>
      )}

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 240,
            color: "#9ca3af",
            fontSize: 16,
            flexDirection: "column",
            gap: 16,
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: "3px solid #1f2937",
              borderTopColor: "#4ade80",
              animation: "spin 0.8s linear infinite",
              display: "inline-block",
            }}
          />
          データを取得中...
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <>
          <section style={{ marginBottom: 40 }}>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "#9ca3af",
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              品質指標（30秒ごとに自動更新）
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
              {kpiCards.map((card) => (
                <KpiCard key={card.name} {...card} />
              ))}
            </div>
          </section>

          {tenantRows.length > 0 && (
            <section>
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#9ca3af",
                  marginBottom: 16,
                  marginTop: 0,
                }}
              >
                テナント別 SLA 達成状況
              </h2>
              <TenantSlaTable rows={tenantRows} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
