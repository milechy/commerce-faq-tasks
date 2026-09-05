import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import KpiCard from "../../../components/admin/KpiCard";
import TenantSlaTable, {
  type TenantSlaRow,
} from "../../../components/admin/TenantSlaTable";
import { API_BASE, authFetch } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import { QuotaBar } from "../billing/QuotaSection";
import { useLang } from "../../../i18n/LangContext";
import type { TranslationKey } from "../../../i18n/ja";
import ShopifyDeletionQueueCard, {
  type ShopifyDeletionQueueData,
} from "../../../components/admin/ShopifyDeletionQueueCard";

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
  /** 「開いたのに会話しなかった」割合。visitor_id 記録開始前は結合不能なので
   *  trackingSince より前は母数に含めない。 */
  chatOpenDropoff?: {
    trackingSince: string | null;
    visitorsOpened: number;
    visitorsConversed: number;
    dropoffRate: number | null;
    sessionCoverage: RateMetric;
    /** GID 1218086189953625: 分母から除外した「不明(source未記録)」の訪問者数。
     *  黙って除外すると数字が合わない問い合わせを生むため、除外件数を画面に出す。 */
    unknownSourceVisitorCount?: number;
  };
  /** ナレッジ配線是正P14で既に集計はあった(👍👎)。Judgeが4通未満を評価しないため
   *  当面唯一機能する品質信号。event_tracking(行動計測)とは独立に既定ONなので、
   *  行動計測が無効なテナントでも数値が出る。 */
  answerFeedback?: {
    upCount: number;
    downCount: number;
  };
  /** L0-4(Gate 0): 実ユーザーの会話のうちmessage_count>=8(4往復以上)だった率。
   *  母数不足(30件未満)ならrate:null(禁止34)。サーバは常に返すが、
   *  古いAPI応答形状でも落ちないよう optional として扱う。 */
  deepConversationRate?: RateMetric;
  /** super_admin のときだけ返る。コードが要求する列が実行中のDBに存在するか。 */
  schemaHealth?: {
    missing: Array<{ table: string; columns: string[]; tableMissing: boolean }>;
    checkedTables: number;
    checkedColumns: number;
  };
  /** super_admin のときだけ返る。テナント×機能の点火状態。 */
  ignitionStatus?: {
    rows: Array<{
      tenantId: string;
      cells: Array<{
        feature: string;
        label: string;
        enabled: boolean;
        reason: string;
        configKey: string;
        controlledBy: "env" | "tenants.features";
      }>;
    }>;
    envControlledFeatures: string[];
    anyEnabled: boolean;
    /** H-11(GID 1217973238377692): 自動昇格がPrompt Firewallに弾かれた件数(直近lookbackDays日)。
     *  手動昇格はHTTPレスポンスで既に可視のため、自動昇格限定。 */
    autoPromotionBlockedByFirewall?: {
      count: number;
      lookbackDays: number;
    };
  };
  /** super_admin のときだけ返る。Hermes提案(tuning_rules source='hermes')の採択率。
   *  全期間・全テナント横断の累計値(月$23を払い続けるか止めるかの判断材料)。 */
  hermesAcceptanceRate?: {
    acceptanceRate: RateMetric;
    pendingCount: number;
    asOf: string;
  };
  /** super_admin のときだけ返る。A2A-0i: LemonSlice($100/月)とLiveKit($50/月)の
   *  固定費に対する当月消費率。上げ方向(80%到達)/下げ方向(3ヶ月連続50%未満)の
   *  判断材料。quota:null はこのクォータの込み枠が未確定でありenv設定待ちを意味する。 */
  fixedCostQuota?: {
    lemonslice: FixedCostQuotaLine;
    livekit: FixedCostQuotaLine;
    asOf: string;
  };
}

interface FixedCostQuotaLine {
  used: number;
  quota: number | null;
  ratio: number | null;
  upSignal: boolean;
  downSignal: boolean;
  historyMonths: number;
}

// WP-15(D11/§13.5): free_ad総量ガード(D7/planQuota.ts)の発火実績。
// GET /v1/admin/tenants/wp-provisioning-stats(super_admin限定)の応答形状。
interface WpProvisioningStats {
  active_free_ad_tenants: number;
  active_free_ad_tenant_cap: number;
  today_new_provisions: number;
  today_new_provision_cap: number;
  current_month_free_ad_cost_jpy: number;
  cost_alert_threshold_jpy: number;
  cost_alert_triggered: boolean;
  // team-lead指摘(2026-09-05): fetchTenantEconomicsの50件上限で集計対象が
  // 切り捨てられたか。trueのときcurrent_month_free_ad_cost_jpyは実際より
  // 少なく出うるため、数値をそのまま出さず注意書きに差し替える(禁止50と同じ精神)。
  cost_data_truncated: boolean;
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

// ナレッジ配線是正P14: 👍👎の集計は既にあったが誰も表示していなかった。
// MIN_VISITORS_FOR_RATE(=30, サーバ側 measurementHealth.ts)と同じ考え方で、
// 母数が小さいときは比率(誤った自信を生む)を出さず実数のみ出す。
const MIN_FEEDBACK_FOR_RATE = 30;

// L0-4(Gate 0): MIN_CONVERSATIONS_FOR_RATE(=30, サーバ側 measurementHealth.ts)と
// 同じ考え方で、4往復以上率も母数が小さいときは比率を出さず到達条件だけ示す。
const MIN_CONVERSATIONS_FOR_RATE = 30;

function DeepConversationRateDisplay({
  metric,
  t,
}: {
  metric: RateMetric;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  if (metric.rate === null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: "var(--muted-foreground)" }}>
          {t("monitoring.deep_conversation_insufficient")}
        </span>
        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {t("monitoring.deep_conversation_progress", {
            current: metric.denominator,
            required: MIN_CONVERSATIONS_FOR_RATE,
          })}
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

function FeedbackDisplay({ feedback }: { feedback: { upCount: number; downCount: number } }) {
  const total = feedback.upCount + feedback.downCount;
  if (total < MIN_FEEDBACK_FOR_RATE) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: "var(--foreground)" }}>
          👍 {feedback.upCount.toLocaleString("ja-JP")} / 👎 {feedback.downCount.toLocaleString("ja-JP")}
        </span>
        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          件数が少ないため割合は出しません（{total.toLocaleString("ja-JP")}件 / 必要 {MIN_FEEDBACK_FOR_RATE}件）
        </span>
      </div>
    );
  }
  const upRate = Math.round((feedback.upCount / total) * 1000) / 10;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
        👍 {upRate}%
      </span>
      <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
        (👍 {feedback.upCount.toLocaleString("ja-JP")} / 👎 {feedback.downCount.toLocaleString("ja-JP")})
      </span>
    </div>
  );
}

// A2A-0i: 固定費(LemonSlice/LiveKit)クォータの1行分。QuotaSection.tsxのQuotaBar
// (アバター利用枠等と同じ「用済み/込み枠」バー)をそのまま再利用する。
function FixedCostQuotaRow({
  label, unit, line,
}: {
  label: string;
  unit: string;
  line: FixedCostQuotaLine;
}) {
  if (line.quota === null) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{label}</span>
        <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
          今月 {line.used.toLocaleString("ja-JP")}{unit}(込み枠未設定)
        </span>
      </div>
    );
  }
  return (
    <div>
      {/* overageは常に0を渡す — QuotaBarの超過文言は「テナント従量課金」前提の文面
          (元々billing/QuotaSection.tsx用)で、ここ(社内のベンダー固定費監視)には
          そのまま流用できない。超過の有無はバーの色(100%以上=赤)とupSignalの
          テキストで十分伝わる。 */}
      <QuotaBar
        label={label}
        used={line.used}
        included={line.quota}
        unit={unit}
        overage={0}
        overageUnit={unit}
      />
      {line.upSignal ? (
        <p style={{ margin: "-8px 0 12px", fontSize: 13, color: "#fbbf24", fontWeight: 600 }}>
          込み枠の80%以上を消費しています。引き上げを検討してください。
        </p>
      ) : line.downSignal ? (
        <p style={{ margin: "-8px 0 12px", fontSize: 13, color: "#4ade80" }}>
          直近{line.historyMonths}ヶ月連続で込み枠の50%未満です。引き下げを検討できます。
        </p>
      ) : null}
    </div>
  );
}

export default function MonitoringPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const [data, setData] = useState<MonitoringKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // GID 1216970103691946 (PR-7): 計測ヘルス(5指標)。KPIとは別APIのため
  // 取得結果・エラーも独立させる(片方の失敗がもう片方の表示を止めないため)。
  const [health, setHealth] = useState<MeasurementHealth | null>(null);
  const [healthError, setHealthError] = useState(false);

  // WP-15(D11): client_adminには403で返るため、その場合はカード自体を出さない
  // (エラーバナーは出さない — health同様、片方の失敗がもう片方の表示を止めない設計)。
  const [wpStats, setWpStats] = useState<WpProvisioningStats | null>(null);

  // 13(Shopify D15/FR-16/§7 D-5): shop/redact 削除保留一覧・期限。
  // client_adminには403で返るため、その場合はカード自体を出さない(wpStatsと同型)。
  const [shopifyDeletionQueue, setShopifyDeletionQueue] = useState<ShopifyDeletionQueueData | null>(null);

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

  const fetchWpStats = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/wp-provisioning-stats`);
      // client_adminは403 — カードを出さないだけで、エラー扱いにはしない。
      if (!res.ok) {
        setWpStats(null);
        return;
      }
      const json = (await res.json()) as Partial<WpProvisioningStats>;
      // 形が壊れている(モック/旧いAPI応答等)場合にレンダーで例外を投げないよう、
      // 最低限の数値フィールドが揃っていることを確認してから反映する。
      if (
        typeof json.active_free_ad_tenants === "number" &&
        typeof json.active_free_ad_tenant_cap === "number" &&
        typeof json.today_new_provisions === "number" &&
        typeof json.today_new_provision_cap === "number" &&
        typeof json.current_month_free_ad_cost_jpy === "number" &&
        typeof json.cost_alert_threshold_jpy === "number" &&
        typeof json.cost_alert_triggered === "boolean" &&
        typeof json.cost_data_truncated === "boolean"
      ) {
        setWpStats(json as WpProvisioningStats);
      } else {
        setWpStats(null);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") return; // fetchKpisが遷移を担当
      setWpStats(null);
    }
  }, []);

  const fetchShopifyDeletionQueue = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/shopify/deletion-queue`);
      // client_adminは403 — カードを出さないだけで、エラー扱いにはしない(wpStatsと同型)。
      if (!res.ok) {
        setShopifyDeletionQueue(null);
        return;
      }
      const json = (await res.json()) as Partial<ShopifyDeletionQueueData>;
      if (Array.isArray(json.pending) && typeof json.total === "number") {
        setShopifyDeletionQueue(json as ShopifyDeletionQueueData);
      } else {
        setShopifyDeletionQueue(null);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") return; // fetchKpisが遷移を担当
      setShopifyDeletionQueue(null);
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
      void fetchWpStats();
      void fetchShopifyDeletionQueue();
      timerRef.current = setInterval(() => {
        void fetchKpis();
        void fetchHealth();
        void fetchWpStats();
        void fetchShopifyDeletionQueue();
      }, POLL_INTERVAL_MS);
    })();

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [fetchKpis, fetchHealth, fetchWpStats, fetchShopifyDeletionQueue, navigate]);

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
            {health?.schemaHealth && (
              <div
                style={{
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  background: health.schemaHealth.missing.length === 0 ? "rgba(34,197,94,0.10)" : "rgba(248,113,113,0.12)",
                  border: `1px solid ${health.schemaHealth.missing.length === 0 ? "rgba(34,197,94,0.35)" : "rgba(248,113,113,0.4)"}`,
                  color: health.schemaHealth.missing.length === 0 ? "#4ade80" : "#f87171",
                }}
              >
                {health.schemaHealth.missing.length === 0
                  ? "異常なし — 本番スキーマはコードと一致しています"
                  : `要対応 — 本番に存在しない列があります（${health.schemaHealth.missing.length}テーブル）`}
              </div>
            )}
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

                {/* L0-4(Gate 0): Layer 0の合否(実テナント10社／月500会話／4往復以上20%)の
                    うち「4往復以上20%」を人が判定するための計器。自動判定はしない。 */}
                <MeasurementHealthCard
                  title={t("monitoring.deep_conversation_card_title")}
                  description={t("monitoring.deep_conversation_card_desc")}
                >
                  {health?.deepConversationRate ? (
                    <DeepConversationRateDisplay metric={health.deepConversationRate} t={t} />
                  ) : (
                    <MetricPlaceholder />
                  )}
                </MeasurementHealthCard>

                {/* G5: チャットは開かれているのに会話にならない乖離。
                    visitor_id の記録が始まる前のセッションは結合しようがないため、
                    期間全体で率を出すと「0%が話した」という誤った数字になる。 */}
                <MeasurementHealthCard
                  title="開いたのに話さなかった割合"
                  description="チャットを開いた人のうち、会話に至らなかった割合"
                >
                  {!health?.chatOpenDropoff ? (
                    <MetricPlaceholder />
                  ) : health.chatOpenDropoff.trackingSince === null ? (
                    <div style={{ fontSize: 13.5, color: "var(--muted-foreground)", lineHeight: 1.8 }}>
                      まだ集計できません。会話に訪問者IDが付いた記録がありません。
                    </div>
                  ) : health.chatOpenDropoff.dropoffRate === null ? (
                    <div style={{ fontSize: 13.5, color: "var(--muted-foreground)", lineHeight: 1.8 }}>
                      判定に足りません（開いた人 {health.chatOpenDropoff.visitorsOpened} 人 / 必要 30 人）。
                      <br />
                      {new Date(health.chatOpenDropoff.trackingSince).toLocaleDateString("ja-JP")} 以降の記録のみを数えています。
                      それ以前の会話には訪問者IDが無く、結合できません。
                      {/* GID 1218086189953625: 分母には source='user' のみを数え、source未記録(不明)は
                          黙って除外せず件数を出す。behavioral_events.source は2026-08-29の後付け列で
                          過去データはNULLのまま(推定で埋めない)。 */}
                      <br />
                      不明 {(health.chatOpenDropoff.unknownSourceVisitorCount ?? 0).toLocaleString("ja-JP")} 件を除外しています（source未記録のため計測に含められません）。
                    </div>
                  ) : (
                    <>
                      <MetricValue value={`${health.chatOpenDropoff.dropoffRate}%`} />
                      <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", lineHeight: 1.8, marginTop: 4 }}>
                        開いた {health.chatOpenDropoff.visitorsOpened} 人のうち、話したのは {health.chatOpenDropoff.visitorsConversed} 人
                        <br />
                        訪問者IDが付いた会話: {health.chatOpenDropoff.sessionCoverage.numerator}／
                        {health.chatOpenDropoff.sessionCoverage.denominator} 件
                        （この割合が低いほど上の数字は当てになりません）
                        <br />
                        不明 {(health.chatOpenDropoff.unknownSourceVisitorCount ?? 0).toLocaleString("ja-JP")} 件を除外しています（source未記録のため計測に含められません）。
                      </div>
                    </>
                  )}
                </MeasurementHealthCard>

                {/* ナレッジ配線是正P14: 👍👎の集計は既にあったが誰も表示していなかった。
                    Judgeが4通未満を評価しないため、当面唯一機能する品質信号。 */}
                <MeasurementHealthCard
                  title="回答への👍👎"
                  description="answer_feedbackはevent_tracking(行動計測)と独立に既定ONのため、行動計測が無効なテナントでも数値が出ます"
                >
                  {health?.answerFeedback ? (
                    <FeedbackDisplay feedback={health.answerFeedback} />
                  ) : (
                    <MetricPlaceholder />
                  )}
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

                {/* 点火状態(R2C運用のみ)。フラグの実効値を知る手段がSSHしかない状態を解消する。
                    env でしか開閉できないものは画面から変えられない(CLAUDE.md 禁止41の是正対象)。 */}
                {health?.ignitionStatus && (
                  <MeasurementHealthCard
                    title="学習機能の点火状態"
                    description="どのテナントで何が有効か。無効なものは理由も出す"
                  >
                    {health.ignitionStatus.rows.length === 0 ? (
                      <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>テナントがありません</div>
                    ) : !health.ignitionStatus.anyEnabled ? (
                      <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>
                        有効な機能はありません
                      </div>
                    ) : null}
                    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
                      {health.ignitionStatus.rows.map((row) => (
                        <div key={row.tenantId}>
                          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{row.tenantId}</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {row.cells.map((c) => (
                              <div key={c.feature} style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                                <span style={{ color: c.enabled ? "#4ade80" : "#6b7280", fontWeight: 700 }}>
                                  {c.enabled ? "有効" : "無効"}
                                </span>
                                <span style={{ margin: "0 6px" }}>{c.label}</span>
                                <span style={{ color: "var(--muted-foreground)" }}>— {c.reason}</span>
                                <span style={{ color: "#6b7280", marginLeft: 6 }}>
                                  <code>{c.configKey}</code>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {health.ignitionStatus.envControlledFeatures.length > 0 && (
                      <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
                        このうち {health.ignitionStatus.envControlledFeatures.length} 機能は環境変数でしか切り替えられません。
                        画面から開閉できないため、点火し忘れに気づけない構造です（順次 tenants.features へ移行）。
                      </div>
                    )}
                    {/* H-11(GID 1217973238377692): 自動昇格がPrompt Firewallに弾かれた件数。
                        従来はlogger.warnのみで画面に一切出ず、母数が少ない現状では誤検知による
                        静かな取りこぼしに気づけなかった。0件でも「監視できている」ことが分かるよう
                        常に表示する(schemaHealthの「欠落なし」と同じ流儀)。 */}
                    {health.ignitionStatus.autoPromotionBlockedByFirewall && (
                      health.ignitionStatus.autoPromotionBlockedByFirewall.count === 0 ? (
                        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
                          自動での学習データ保存は、不審な内容を検知して見送られたことはありません（直近{health.ignitionStatus.autoPromotionBlockedByFirewall.lookbackDays}日）。
                        </div>
                      ) : (
                        <div style={{ marginTop: 10, fontSize: 12, color: "#f87171", fontWeight: 700, lineHeight: 1.7 }}>
                          自動での学習データ保存が、不審な内容を検知して直近{health.ignitionStatus.autoPromotionBlockedByFirewall.lookbackDays}日で{health.ignitionStatus.autoPromotionBlockedByFirewall.count}件見送られています。
                        </div>
                      )
                    )}
                  </MeasurementHealthCard>
                )}

                {/* H-7(GID 1217972930945091): Hermes提案の採択率(R2C運用のみ)。
                    評価層はR2C側にあり、Hermesにeval/LLMOpsは無い。強化するか止めるかを
                    採択率で測る。全期間・全テナント横断の累計値のため期間フィルタの対象外。 */}
                {health?.hermesAcceptanceRate && (
                  <MeasurementHealthCard
                    title="Hermes提案の採択率"
                    description="Hermesが提案し、承認(active)または却下(rejected)まで判断が済んだもののうち承認された割合（未判断のpendingは母数に含めない）"
                  >
                    <RateDisplay metric={health.hermesAcceptanceRate.acceptanceRate} />
                    <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
                      未判断(pending): {health.hermesAcceptanceRate.pendingCount.toLocaleString("ja-JP")}件
                      <br />
                      集計時点: {new Date(health.hermesAcceptanceRate.asOf).toLocaleString("ja-JP")}
                    </div>
                  </MeasurementHealthCard>
                )}

                {/* A2A-0i: LemonSlice($100/月・込み15,000クレジット)とLiveKit($50/月)の
                    固定費消費率(R2C運用のみ)。上げ方向(80%到達)は敏感に、下げ方向
                    (3ヶ月連続50%未満)は慎重に判定する。上げ方向はbillingHealthMonitor
                    経由でSlackにも通知される(このカードはWARNING未満の平常時も含め常時表示)。 */}
                {health?.fixedCostQuota && (
                  <MeasurementHealthCard
                    title="固定費クォータ消費率(LemonSlice/LiveKit)"
                    description="込み枠に対する当月消費。上げ方向は80%到達で警告、下げ方向は3ヶ月連続50%未満のときだけ示唆する"
                  >
                    <FixedCostQuotaRow label="LemonSlice" unit="クレジット" line={health.fixedCostQuota.lemonslice} />
                    <p style={{ margin: "2px 0 12px", fontSize: 11.5, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
                      ※avatar-agentのセッション終了時1回きりの送信(リトライなし)を元にした値です。
                      クラッシュ等で計上漏れがあると、実際の消費率はこれより高い可能性があります。
                    </p>
                    <FixedCostQuotaRow label="LiveKit" unit="room" line={health.fixedCostQuota.livekit} />
                    {health.fixedCostQuota.livekit.quota === null && (
                      <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
                        ※込み枠(LIVEKIT_MONTHLY_ROOM_QUOTA)が未設定のため、上げ下げの判定は保留中です。
                      </p>
                    )}
                  </MeasurementHealthCard>
                )}

                {/* WP-15(D11/§13.5): WordPress プラグイン経由の free_ad テナント
                    総量ガード(D7)の発火実績。禁止50に従い、0件でも「異常なし」の
                    ような肯定的表示にはしない — まだ流入がない旨を中立に示す。 */}
                {wpStats && (
                  <MeasurementHealthCard
                    title="WordPress経由テナントの総量ガード"
                    description="free_adテナントの同時稼働数・日次新規発行数・当月原価の実績。上限に対する現在値を示す(D7/WP-5)"
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>稼働中(WordPress経由)</span>
                      <span style={{ fontSize: 20, fontWeight: 700, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
                        {wpStats.active_free_ad_tenants.toLocaleString("ja-JP")} / {wpStats.active_free_ad_tenant_cap.toLocaleString("ja-JP")}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>本日の新規発行</span>
                      <span style={{ fontSize: 20, fontWeight: 700, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
                        {wpStats.today_new_provisions.toLocaleString("ja-JP")} / {wpStats.today_new_provision_cap.toLocaleString("ja-JP")}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>当月のfree_ad原価</span>
                      {/* team-lead指摘(2026-09-05): cost_data_truncated=trueのとき、
                          集計対象が50件上限で切り捨てられ実際より少ない値になりうる。
                          正確でない数値を正常な数値であるかのように出さない(禁止50と同じ精神)。 */}
                      {wpStats.cost_data_truncated ? (
                        <span style={{ fontSize: 15, fontWeight: 700, color: "#fbbf24" }}>集計不能</span>
                      ) : (
                        <span
                          style={{
                            fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums",
                            color: wpStats.cost_alert_triggered ? "#f87171" : "var(--foreground)",
                          }}
                        >
                          ¥{wpStats.current_month_free_ad_cost_jpy.toLocaleString("ja-JP")}
                        </span>
                      )}
                    </div>
                    {wpStats.cost_data_truncated ? (
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "#fbbf24", fontWeight: 700, lineHeight: 1.6 }}>
                        テナント数が多く、正確な原価集計ができていません(集計上限50件を超過)。
                        アラート判定(閾値到達の有無)も信頼できないため、別途確認してください。
                      </p>
                    ) : wpStats.cost_alert_triggered ? (
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "#f87171", fontWeight: 700, lineHeight: 1.6 }}>
                        当月原価がアラート閾値(¥{wpStats.cost_alert_threshold_jpy.toLocaleString("ja-JP")})に到達しています。
                      </p>
                    ) : wpStats.active_free_ad_tenants === 0 && wpStats.today_new_provisions === 0 ? (
                      // ★禁止50: 0件を「異常なし」と表示しない★ まだ流入が無い事実を中立に示す。
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
                        まだWordPress経由の流入がありません(プラグインからの新規発行が0件)。
                      </p>
                    ) : (
                      <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
                        アラート閾値: ¥{wpStats.cost_alert_threshold_jpy.toLocaleString("ja-JP")}
                      </p>
                    )}
                  </MeasurementHealthCard>
                )}

                {/* 13(Shopify D15/FR-16/§7 D-5): shop/redact 削除保留の件数・期限監視。
                    禁止50に従い、0件でも「異常なし」ではなく中立に「保留0件」と表示する
                    (ShopifyDeletionQueueCard内部で処理)。 */}
                {shopifyDeletionQueue && <ShopifyDeletionQueueCard data={shopifyDeletionQueue} />}
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
