import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import KpiCard from "../../../components/admin/KpiCard";
import TenantSlaTable, {
  type TenantSlaRow,
} from "../../../components/admin/TenantSlaTable";
import { API_BASE, authFetch } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";

interface RateMetric {
  numerator: number;
  denominator: number;
  rate: number | null; // null = 母数不足で判定できない(CLAUDE.md 禁止34)
}

interface MeasurementHealth {
  sourceBreakdown: Array<{ source: string; count: number }>;
  emptySessionCount: number;
  cvSessionLinkRate: RateMetric;
  outcomeRecordRate: RateMetric & { autoRecorded: number };
  validUserSessionCount: number;
  /** super_admin のときだけ返る。コードが要求する列が実行中のDBに存在するか。 */
  schemaHealth?: {
    missing: Array<{ table: string; columns: string[]; tableMissing: boolean }>;
    checkedTables: number;
    checkedColumns: number;
  };
}

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

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// GID 1216970103691946 (PR-7): 計測ヘルスカード群。KpiCardは「SLA達成/未達成」の
// 二値判定を前提にしており、計測ヘルスの指標(内訳・件数・母数不足の可能性がある率)
// には合わないため専用の軽量カードを使う。
function MeasurementHealthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: "1 1 260px",
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "18px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>{title}</div>
      {children}
      <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{description}</div>
    </div>
  );
}

function MetricPlaceholder() {
  return (
    <span style={{ fontSize: 14, color: "var(--muted-foreground)" }}>取得中...</span>
  );
}

function MetricValue({ value, met }: { value: string; met?: boolean }) {
  const color = met === undefined ? "var(--foreground)" : met ? "#4ade80" : "#fbbf24";
  return (
    <span style={{ fontSize: 28, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
  );
}

// CLAUDE.md 禁止34: 母数(denominator)が0のときは 0% や矢印を出さず、
// 「判定に足りない」ことと生の件数(0/0など)をそのまま示す。
function RateDisplay({ metric }: { metric: RateMetric }) {
  if (metric.rate === null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: "var(--muted-foreground)" }}>判定に足りない</span>
        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {metric.numerator.toLocaleString("ja-JP")} / {metric.denominator.toLocaleString("ja-JP")}件
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
        {metric.rate}%
      </span>
      <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
        ({metric.numerator.toLocaleString("ja-JP")} / {metric.denominator.toLocaleString("ja-JP")}件)
      </span>
    </div>
  );
}

export default function MonitoringPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MonitoringKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // GID 1216970103691946 (PR-7): 計測ヘルス(5指標)。KPIとは別APIのため
  // 取得結果・エラーも独立させる(片方の失敗がもう片方の表示を止めないため)。
  const [health, setHealth] = useState<MeasurementHealth | null>(null);
  const [healthError, setHealthError] = useState(false);

  const fetchKpis = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/monitoring/kpis`);

      if (!res.ok) throw new Error("fetch failed");

      const json = (await res.json()) as MonitoringKpis;
      setData(json);
      setError(false);
      setLastUpdated(new Date());
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/analytics/measurement-health`);
      if (!res.ok) throw new Error("fetch failed");
      const json = (await res.json()) as MeasurementHealth;
      setHealth(json);
      setHealthError(false);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") return; // fetchKpisが遷移を担当
      setHealthError(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        navigate("/login", { replace: true });
        return;
      }
      void fetchKpis();
      void fetchHealth();
      timerRef.current = setInterval(() => { void fetchKpis(); void fetchHealth(); }, POLL_INTERVAL_MS);
    })();

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [fetchKpis, fetchHealth, navigate]);

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
          name: "同じ質問の繰り返し率",
          value: data.loopRate.toFixed(1),
          unit: "%",
          threshold: `${sla.loopRateMax}% 以下`,
          met: data.loopRate <= sla.loopRateMax,
          description: "同じ質問が繰り返された会話の割合",
        },
        {
          name: "AIが答えられなかった割合",
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
          "var(--background)",
        color: "var(--foreground)",
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
              background: "var(--card)",
              border: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--muted-foreground)",
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
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            システム稼働状況
          </h1>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
            AIサービスの品質指標をリアルタイムで確認できます
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <button
            onClick={() => navigate("/admin")}
            style={{
              padding: "10px 16px",
              minHeight: 44,
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted-foreground)",
              fontSize: 14,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            ← 管理画面に戻る
          </button>
          {lastUpdated && (
            <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
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
            color: "var(--muted-foreground)",
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
                color: "var(--muted-foreground)",
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

          <section style={{ marginBottom: 40 }}>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--muted-foreground)",
                marginBottom: 4,
                marginTop: 0,
              }}
            >
              計測ヘルス（直近30日）
            </h2>
            <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 0, marginBottom: 16 }}>
              「何を直しても効果を測れない」状態を脱したかを確認する画面です。以降の効果測定の判定母数になります。
            </p>
            {healthError ? (
              <div
                style={{
                  padding: "14px 16px",
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  color: "var(--muted-foreground)",
                  fontSize: 14,
                }}
              >
                計測ヘルスの取得に失敗しました
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                <MeasurementHealthCard
                  title="トラフィックの内訳"
                  description="e2e / 未タグ付けの新規発生が0に近いほど計測が汚染されていません"
                >
                  {health ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {health.sourceBreakdown.length === 0 ? (
                        <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>データなし</span>
                      ) : (
                        health.sourceBreakdown.map((row) => (
                          <div key={row.source} style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                            <span style={{ color: "var(--muted-foreground)" }}>{row.source}</span>
                            <span style={{ fontWeight: 700, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
                              {row.count.toLocaleString("ja-JP")}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <MetricPlaceholder />
                  )}
                </MeasurementHealthCard>

                <MeasurementHealthCard
                  title="空セッション（message_count = 0）"
                  description="0件が正常です。増えている場合は記録経路の不具合を疑ってください"
                >
                  {health ? <MetricValue value={health.emptySessionCount.toLocaleString("ja-JP")} met={health.emptySessionCount === 0} /> : <MetricPlaceholder />}
                </MeasurementHealthCard>

                <MeasurementHealthCard
                  title="CVの会話結合率"
                  description="コンバージョンが会話セッションに正しく結合できた割合"
                >
                  {health ? <RateDisplay metric={health.cvSessionLinkRate} /> : <MetricPlaceholder />}
                </MeasurementHealthCard>

                <MeasurementHealthCard
                  title="成果(outcome)記録率"
                  description="実ユーザーの会話のうち成果が記録された割合（自動記録件数も表示）"
                >
                  {health ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <RateDisplay metric={health.outcomeRecordRate} />
                      <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                        うち自動記録: {health.outcomeRecordRate.autoRecorded.toLocaleString("ja-JP")}件
                      </span>
                    </div>
                  ) : (
                    <MetricPlaceholder />
                  )}
                </MeasurementHealthCard>

                <MeasurementHealthCard
                  title="実ユーザーの有効セッション数"
                  description="判定に使える母数そのもの（source=userかつメッセージあり）"
                >
                  {health ? <MetricValue value={health.validUserSessionCount.toLocaleString("ja-JP")} /> : <MetricPlaceholder />}
                </MeasurementHealthCard>

                {/* スキーマ適用ズレ(R2C運用のみ)。コードは配備済みでも本番に列が無いと
                    記録だけが無言で落ちる。2026-08-24 の visitor_id / product_* がその実例。 */}
                {health?.schemaHealth && (
                  <MeasurementHealthCard
                    title="本番スキーマとコードの整合"
                    description="コードが書き込む列が本番に存在するか（未適用のmigrationを検知する）"
                  >
                    {health.schemaHealth.missing.length === 0 ? (
                      <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>
                        欠落なし（{health.schemaHealth.checkedTables}テーブル / {health.schemaHealth.checkedColumns}列を確認）
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#f87171" }}>
                          {health.schemaHealth.missing.length}件のテーブルで列が不足しています
                        </div>
                        {health.schemaHealth.missing.map((m) => (
                          <div key={m.table} style={{ fontSize: 13, lineHeight: 1.7 }}>
                            <code style={{ fontWeight: 700 }}>{m.table}</code>
                            {m.tableMissing ? "（テーブルごと存在しません）" : "："}
                            {!m.tableMissing && <code>{m.columns.join(", ")}</code>}
                          </div>
                        ))}
                        <div style={{ fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
                          該当する migration を本番に適用してください。適用は人の承認が必要です。
                          記録が無言で落ちるため、エラーログには現れません。
                        </div>
                      </div>
                    )}
                  </MeasurementHealthCard>
                )}
              </div>
            )}
          </section>

          {tenantRows.length > 0 && (
            <section>
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--muted-foreground)",
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
