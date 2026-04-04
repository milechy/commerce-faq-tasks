import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import UsageChart from "../../../components/UsageChart";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";

// ─── 型定義 ────────────────────────────────────────────────
interface Tenant {
  id: string;
  name: string;
}

interface BillingSummary {
  tenant_id: string;
  month: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cost_llm_cents: number;
  cost_total_cents: number;
  billing_status: "pending" | "invoiced" | "error";
}

interface DailyUsage {
  date: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_total_cents: number;
}

interface Invoice {
  id: string;
  month: string;
  amount_cents: number;
  status: "paid" | "open" | "draft";
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  portal_url: string;
}

interface CostBreakdownItem {
  label: string;
  cost_yen: number;
  request_count: number;
  percentage: number;
}

interface CostBreakdown {
  total_yen: number;
  breakdown: Record<string, CostBreakdownItem>;
}

interface CrossTenantRow {
  tenant_id: string;
  total_requests: number;
  cost_total_cents: number;
}

// ─── ユーティリティ ────────────────────────────────────────
function fmtCents(cents: number): string {
  return `¥${Math.round(cents / 100).toLocaleString("ja-JP")}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("ja-JP");
}

function fmtDate(dateStr: string): string {
  const s = dateStr.slice(0, 10); // normalize ISO to "YYYY-MM-DD"
  const [y, m, d] = s.split("-");
  return `${y}年${m}月${d}日`;
}

/** YYYY-MM → from/to の日付範囲を返す */
function monthToDateRange(month: string): { from: string; to: string } {
  const [year, mon] = month.split("-").map(Number);
  const from = `${year}-${String(mon).padStart(2, "0")}-01`;
  const nextMonth = mon === 12 ? new Date(year + 1, 0, 1) : new Date(year, mon, 1);
  const to = nextMonth.toISOString().slice(0, 10);
  return { from, to };
}

/** Unix timestamp (秒) → "YYYY-MM" */
function tsToYearMonth(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── CSVエクスポート ───────────────────────────────────────
function exportCsv(data: DailyUsage[], tenantName: string, month: string, header: string) {
  const rows = data.map((d) =>
    [
      d.date,
      d.requests,
      d.input_tokens,
      d.output_tokens,
      Math.round(d.cost_total_cents / 100),
    ].join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `usage_${tenantName}_${month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── スタイル定数 ─────────────────────────────────────────
const CARD: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background:
    "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
};

const BTN_LINK: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 18px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid #374151",
  background: "transparent",
  color: "#e5e7eb",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};

// ─── メインページ ─────────────────────────────────────────
export default function BillingPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { isSuperAdmin, user, previewMode, previewTenantId, previewTenantName } = useAuth();

  const currentMonth = new Date().toISOString().slice(0, 7);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonth);

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [costBreakdown, setCostBreakdown] = useState<CostBreakdown | null>(null);
  const [crossTenantRows, setCrossTenantRows] = useState<CrossTenantRow[]>([]);

  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"requests" | "cost">("requests");

  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // テナント一覧を取得（Super Admin: 全テナント / Client Admin: 自テナントのみ）
  useEffect(() => {
    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        navigate("/login", { replace: true });
        return;
      }

      if (isSuperAdmin) {
        try {
          const res = await authFetch(`${API_BASE}/v1/admin/tenants`);
          if (res.ok) {
            const data = (await res.json()) as { tenants: Tenant[] };
            setTenants(data.tenants);
            if (data.tenants.length > 0) {
              setSelectedTenantId(data.tenants[0].id);
            }
          }
        } catch {
          // テナント取得失敗時は空のまま
        }
      } else {
        // Client Admin（本人またはプレビューモード）: 自テナントのみ
        const tenantId = previewMode
          ? (previewTenantId ?? "")
          : (user?.tenantId ?? "");
        const tenantName = previewMode
          ? (previewTenantName ?? tenantId)
          : (user?.tenantName ?? tenantId);
        if (tenantId) {
          setTenants([{ id: tenantId, name: tenantName }]);
          setSelectedTenantId(tenantId);
        }
      }
    })();
  }, [navigate, isSuperAdmin, user, previewMode, previewTenantId, previewTenantName]);

  // 請求データを取得
  const fetchBillingData = useCallback(async () => {
    if (!selectedTenantId) return;

    setLoadingData(true);
    setError(null);
    setSummary(null);
    setDaily([]);
    setInvoices([]);
    setPortalUrl(null);
    setCostBreakdown(null);
    setCrossTenantRows([]);

    const { from, to } = monthToDateRange(selectedMonth);

    try {
      const [usageRes, invoicesRes, breakdownRes, crossTenantRes] = await Promise.allSettled([
        authFetch(
          `${API_BASE}/v1/admin/billing/usage?tenantId=${selectedTenantId}&from=${from}&to=${to}`
        ),
        authFetch(
          `${API_BASE}/v1/admin/billing/invoices?tenantId=${selectedTenantId}`
        ),
        authFetch(
          `${API_BASE}/v1/admin/billing/cost-breakdown?tenantId=${selectedTenantId}&from=${from}&to=${to}`
        ),
        ...(isSuperAdmin
          ? [authFetch(`${API_BASE}/v1/admin/billing/usage?group_by=tenant&from=${from}&to=${to}`)]
          : []),
      ]);

      // ─── 使用量データ ───────────────────────────────────────
      if (usageRes.status === "fulfilled" && usageRes.value.ok) {
        const data = (await usageRes.value.json()) as {
          tenantId: string;
          daily: Array<{
            date: string;
            total_requests: number;
            chat_requests: number;
            avatar_requests: number;
            voice_requests: number;
            input_tokens: number;
            output_tokens: number;
            cost_llm_cents: number;
            cost_total_cents: number;
          }>;
          monthly: Array<{
            month: string;
            total_requests: number;
            input_tokens: number;
            output_tokens: number;
            cost_llm_cents: number;
            cost_total_cents: number;
          }>;
        };

        // daily マッピング
        const mappedDaily: DailyUsage[] = data.daily.map((d) => ({
          date: d.date,
          requests: d.total_requests,
          input_tokens: d.input_tokens ?? 0,
          output_tokens: d.output_tokens ?? 0,
          cost_total_cents: d.cost_total_cents,
        }));
        setDaily(mappedDaily);

        // summary を monthly から導出（選択月の行、なければ daily 集計）
        const monthRow = data.monthly.find((m) => m.month === selectedMonth);
        const totalRequests = monthRow?.total_requests
          ?? mappedDaily.reduce((s, d) => s + d.requests, 0);
        const costLlmCents = monthRow?.cost_llm_cents
          ?? data.daily.reduce((s, d) => s + d.cost_llm_cents, 0);
        const costTotalCents = monthRow?.cost_total_cents
          ?? mappedDaily.reduce((s, d) => s + d.cost_total_cents, 0);
        const totalInputTokens = monthRow?.input_tokens
          ?? mappedDaily.reduce((s, d) => s + d.input_tokens, 0);
        const totalOutputTokens = monthRow?.output_tokens
          ?? mappedDaily.reduce((s, d) => s + d.output_tokens, 0);

        setSummary({
          tenant_id: selectedTenantId,
          month: selectedMonth,
          total_requests: totalRequests,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          cost_llm_cents: costLlmCents,
          cost_total_cents: costTotalCents,
          billing_status: costTotalCents > 0 ? "invoiced" : "pending",
        });
      } else if (usageRes.status === "fulfilled") {
        // APIが200以外を返した場合（no_active_subscription など）
        setSummary({
          tenant_id: selectedTenantId,
          month: selectedMonth,
          total_requests: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          cost_llm_cents: 0,
          cost_total_cents: 0,
          billing_status: "pending",
        });
      }

      // ─── 請求履歴 ─────────────────────────────────────────
      if (invoicesRes.status === "fulfilled" && invoicesRes.value.ok) {
        const data = (await invoicesRes.value.json()) as {
          tenantId: string;
          customerId: string;
          portalUrl: string;
          invoices: Array<{
            id: string;
            status: string;
            amountDue: number;
            amountPaid: number;
            currency: string;
            periodStart: number;
            periodEnd: number;
            hostedInvoiceUrl: string | null;
            invoicePdf: string | null;
            created: number;
          }>;
        };

        setPortalUrl(data.portalUrl ?? null);

        const mappedInvoices: Invoice[] = data.invoices.map((inv) => ({
          id: inv.id,
          month: tsToYearMonth(inv.periodStart),
          amount_cents: inv.amountDue,
          status: (["paid", "open", "draft"].includes(inv.status)
            ? inv.status
            : "open") as Invoice["status"],
          hosted_invoice_url: inv.hostedInvoiceUrl ?? null,
          invoice_pdf: inv.invoicePdf ?? null,
          portal_url: data.portalUrl ?? "#",
        }));
        setInvoices(mappedInvoices);
      }

      // ─── コスト内訳 ───────────────────────────────────────
      if (breakdownRes.status === "fulfilled" && breakdownRes.value.ok) {
        const bd = (await breakdownRes.value.json()) as CostBreakdown;
        setCostBreakdown(bd);
      }

      // ─── Super Admin: テナント横断 ──────────────────────
      if (
        isSuperAdmin &&
        crossTenantRes !== undefined &&
        crossTenantRes.status === "fulfilled" &&
        crossTenantRes.value.ok
      ) {
        const ct = (await crossTenantRes.value.json()) as {
          group_by: string;
          tenants: CrossTenantRow[];
        };
        setCrossTenantRows(ct.tenants ?? []);
      }
    } catch {
      setError(t("billing.load_error"));
    } finally {
      setLoadingData(false);
    }
  }, [selectedTenantId, selectedMonth, isSuperAdmin, t]);

  useEffect(() => {
    fetchBillingData();
  }, [fetchBillingData]);

  const selectedTenant = tenants.find((t) => t.id === selectedTenantId);

  // 請求ステータスバッジ
  const statusBadge = (status: BillingSummary["billing_status"]) => {
    const map = {
      pending: { label: t("billing.status_pending"), bg: "rgba(234,179,8,0.15)", color: "#fbbf24" },
      invoiced: { label: t("billing.status_invoiced"), bg: "rgba(34,197,94,0.15)", color: "#4ade80" },
      error: { label: t("billing.status_error"), bg: "rgba(239,68,68,0.15)", color: "#f87171" },
    };
    const s = map[status];
    return (
      <span
        style={{
          display: "inline-block",
          padding: "3px 12px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 600,
          background: s.bg,
          color: s.color,
        }}
      >
        {s.label}
      </span>
    );
  };

  // 請求書ステータスバッジ
  const invoiceStatusBadge = (status: Invoice["status"]) => {
    const map = {
      paid: {
        label: t("billing.invoice_paid"),
        bg: "rgba(34,197,94,0.15)",
        color: "#4ade80",
        border: "rgba(74,222,128,0.3)",
      },
      open: {
        label: t("billing.invoice_open"),
        bg: "rgba(234,179,8,0.15)",
        color: "#fbbf24",
        border: "rgba(234,179,8,0.3)",
      },
      draft: {
        label: t("billing.invoice_draft"),
        bg: "rgba(107,114,128,0.15)",
        color: "#9ca3af",
        border: "rgba(107,114,128,0.3)",
      },
    };
    const s = map[status];
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 10px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          background: s.bg,
          color: s.color,
          border: `1px solid ${s.border}`,
        }}
      >
        {s.label}
      </span>
    );
  };

  // 概要タイトル: "2026年03月 — テナント名 の概要"
  const summaryTitle = (() => {
    const [year, mon] = selectedMonth.split("-");
    const monthLabel = `${year}/${mon}`;
    return t("billing.summary_title", { month: monthLabel, tenant: selectedTenant?.name ?? "—" });
  })();

  // ─── レンダリング ────────────────────────────────────────
  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {/* ヘッダー */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 28,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{
              ...BTN_LINK,
              marginBottom: 12,
              fontSize: 14,
              color: "#9ca3af",
            }}
          >
            {t("billing.back")}
          </button>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("billing.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("billing.subtitle")}
          </p>
        </div>
        <LangSwitcher />
      </header>

      {/* エラー */}
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

      {/* テナント・月 セレクター */}
      <section style={{ ...CARD, marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
          {/* Super Admin のみテナントフィルター表示 */}
          {isSuperAdmin && (
            <div style={{ flex: "1 1 200px" }}>
              <label
                htmlFor="tenant-select"
                style={{ display: "block", fontSize: 13, color: "#9ca3af", fontWeight: 600, marginBottom: 6 }}
              >
                {t("billing.tenant_select")}
              </label>
              <select
                id="tenant-select"
                value={selectedTenantId}
                onChange={(e) => setSelectedTenantId(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "rgba(0,0,0,0.3)",
                  color: "#e5e7eb",
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ flex: "1 1 160px" }}>
            <label
              htmlFor="month-select"
              style={{ display: "block", fontSize: 13, color: "#9ca3af", fontWeight: 600, marginBottom: 6 }}
            >
              {t("billing.month_select")}
            </label>
            <input
              id="month-select"
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              style={{
                width: "100%",
                padding: "12px 14px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid #374151",
                background: "rgba(0,0,0,0.3)",
                color: "#e5e7eb",
                fontSize: 15,
                boxSizing: "border-box",
              }}
            />
          </div>

          {portalUrl && (
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...BTN_LINK,
                borderColor: "#22c55e",
                color: "#4ade80",
                fontSize: 14,
                alignSelf: "flex-end",
              }}
            >
              {t("billing.change_payment")}
            </a>
          )}
        </div>
      </section>

      {/* ローディング */}
      {loadingData ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 160,
            color: "#9ca3af",
            fontSize: 15,
          }}
        >
          <span style={{ marginRight: 8 }}>⏳</span>
          {t("billing.loading")}
        </div>
      ) : summary ? (
        <>
          {/* 概要カード */}
          <section style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
              {summaryTitle}
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {/* リクエスト数 */}
              <div style={{ ...CARD, flex: "1 1 140px" }}>
                <div style={{ fontSize: 26, marginBottom: 4 }}>📊</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#f9fafb", lineHeight: 1 }}>
                  {fmtNum(summary.total_requests)}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginTop: 4 }}>
                  {t("billing.total_requests")}
                </div>
              </div>

              {/* AI処理量 */}
              <div style={{ ...CARD, flex: "1 1 140px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 26 }}>🤖</span>
                  <span
                    title="AIが文章を読み書きした量です"
                    style={{ fontSize: 13, color: "#6b7280", cursor: "help" }}
                  >
                    (?)
                  </span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#a78bfa", lineHeight: 1 }}>
                  {fmtNum(summary.total_input_tokens + summary.total_output_tokens)}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginTop: 4 }}>
                  AIの処理量
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  AIが文章を読み書きした量
                </div>
              </div>

              {/* LLMコスト（原価） */}
              <div style={{ ...CARD, flex: "1 1 140px" }}>
                <div style={{ fontSize: 26, marginBottom: 4 }}>💹</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#60a5fa", lineHeight: 1 }}>
                  {fmtCents(summary.cost_llm_cents)}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginTop: 4 }}>
                  {t("billing.ai_cost")}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {t("billing.ai_cost_sub")}
                </div>
              </div>

              {/* 請求額 */}
              <div style={{ ...CARD, flex: "1 1 140px" }}>
                <div style={{ fontSize: 26, marginBottom: 4 }}>🧾</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#4ade80", lineHeight: 1 }}>
                  {fmtCents(summary.cost_total_cents)}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginTop: 4 }}>
                  {t("billing.total_amount")}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {t("billing.total_amount_sub")}
                </div>
              </div>

              {/* お支払い状況 */}
              <div style={{ ...CARD, flex: "1 1 140px" }}>
                <div style={{ fontSize: 26, marginBottom: 4 }}>💳</div>
                <div style={{ marginTop: 4 }}>
                  {statusBadge(summary.billing_status)}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginTop: 8 }}>
                  {t("billing.payment_status")}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {t("billing.payment_status_sub")}
                </div>
              </div>
            </div>
          </section>

          {/* 使用量グラフ */}
          {daily.length > 0 && (
            <section style={{ ...CARD, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: 0 }}>
                  {t("billing.chart_title")}
                </h2>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setChartMode("requests")}
                    style={{
                      padding: "6px 14px",
                      minHeight: 36,
                      borderRadius: 8,
                      border: "none",
                      background: chartMode === "requests" ? "#22c55e" : "rgba(255,255,255,0.05)",
                      color: chartMode === "requests" ? "#022c22" : "#9ca3af",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("billing.requests")}
                  </button>
                  <button
                    onClick={() => setChartMode("cost")}
                    style={{
                      padding: "6px 14px",
                      minHeight: 36,
                      borderRadius: 8,
                      border: "none",
                      background: chartMode === "cost" ? "#22c55e" : "rgba(255,255,255,0.05)",
                      color: chartMode === "cost" ? "#022c22" : "#9ca3af",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("billing.cost")}
                  </button>
                </div>
              </div>
              <UsageChart data={daily} mode={chartMode} />
            </section>
          )}

          {/* コスト内訳 */}
          {costBreakdown && costBreakdown.total_yen > 0 && (
            <section style={{ ...CARD, marginBottom: 20 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: "0 0 16px" }}>
                コスト内訳
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Object.entries(costBreakdown.breakdown).map(([feature, item]) => {
                  const colors: Record<string, string> = {
                    chat:   "#60a5fa",
                    avatar: "#f472b6",
                    voice:  "#4ade80",
                  };
                  const color = colors[feature] ?? "#9ca3af";
                  return (
                    <div key={feature}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ color: "#d1d5db", fontWeight: 600 }}>{item.label}</span>
                        <span style={{ color }}>¥{item.cost_yen.toLocaleString("ja-JP")} ({item.percentage}%)</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${item.percentage}%`,
                            borderRadius: 4,
                            background: color,
                            transition: "width 0.4s ease",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 日次使用量テーブル */}
          {daily.length > 0 && (
            <section style={{ ...CARD, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: 0 }}>
                  {t("billing.daily_title")}
                </h2>
                <button
                  onClick={() => {
                    exportCsv(daily, selectedTenant?.name ?? "tenant", selectedMonth, t("billing.csv_header"));
                    showToast(t("billing.csv_downloaded"));
                  }}
                  style={{
                    ...BTN_LINK,
                    fontSize: 14,
                    padding: "8px 16px",
                    minHeight: 44,
                  }}
                >
                  {t("billing.csv_download")}
                </button>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 480 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #1f2937" }}>
                      {[t("billing.col_date"), t("billing.col_requests"), t("billing.col_cost")].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: "10px 12px",
                            textAlign: "left",
                            fontSize: 12,
                            fontWeight: 600,
                            color: "#6b7280",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {daily.map((d) => (
                      <tr
                        key={d.date}
                        style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}
                      >
                        <td style={{ padding: "10px 12px", color: "#d1d5db" }}>{fmtDate(d.date)}</td>
                        <td style={{ padding: "10px 12px", color: "#f9fafb", fontWeight: 600 }}>
                          {fmtNum(d.requests)}
                        </td>
                        <td style={{ padding: "10px 12px", color: "#4ade80", fontWeight: 600 }}>
                          {fmtCents(d.cost_total_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: "1px solid #374151" }}>
                      <td style={{ padding: "12px", fontWeight: 700, color: "#f9fafb" }}>{t("billing.total")}</td>
                      <td style={{ padding: "12px", fontWeight: 700, color: "#f9fafb" }}>
                        {fmtNum(summary.total_requests)}
                      </td>
                      <td style={{ padding: "12px", fontWeight: 700, color: "#4ade80" }}>
                        {fmtCents(summary.cost_total_cents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}

          {/* データなし */}
          {daily.length === 0 && summary.total_requests === 0 && (
            <section style={{ ...CARD, marginBottom: 20, textAlign: "center", padding: "32px 20px" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
              <div style={{ fontSize: 15, color: "#6b7280" }}>{t("billing.no_data")}</div>
            </section>
          )}

          {/* 請求履歴 */}
          <section style={{ ...CARD, marginBottom: 32 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 16, margin: "0 0 16px" }}>
              {t("billing.invoice_title")}
            </h2>

            {invoices.length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px", color: "#6b7280", fontSize: 14 }}>
                {t("billing.invoice_empty")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {invoices.map((inv) => {
                  const [year, mon] = inv.month.split("-");
                  const monthLabel = `${year}/${mon}`;
                  return (
                    <div
                      key={inv.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "14px 16px",
                        borderRadius: 10,
                        border: "1px solid #1f2937",
                        background: "rgba(0,0,0,0.2)",
                        flexWrap: "wrap",
                        gap: 12,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb" }}>
                          {t("billing.invoice_month", { month: monthLabel })}
                        </div>
                        <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 2 }}>
                          {t("billing.invoice_amount", { amount: fmtCents(inv.amount_cents) })} &nbsp;|&nbsp;{" "}
                          {invoiceStatusBadge(inv.status)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {inv.hosted_invoice_url && (
                          <a
                            href={inv.hosted_invoice_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              ...BTN_LINK,
                              fontSize: 13,
                              padding: "8px 14px",
                              borderColor: "#22c55e",
                              color: "#4ade80",
                            }}
                          >
                            {t("billing.view_detail")}
                          </a>
                        )}
                        {inv.invoice_pdf && (
                          <a
                            href={inv.invoice_pdf}
                            target="_blank"
                            rel="noopener noreferrer"
                            download
                            style={{
                              ...BTN_LINK,
                              fontSize: 13,
                              padding: "8px 14px",
                              borderColor: "#374151",
                              color: "#9ca3af",
                            }}
                          >
                            📥 PDF
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          {/* Super Admin: テナント横断利用状況 */}
          {isSuperAdmin && crossTenantRows.length > 0 && (
            <section style={{ ...CARD, marginBottom: 32 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: "0 0 16px" }}>
                テナント別利用状況（今月）
              </h2>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 400 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #1f2937" }}>
                      {["テナントID", "リクエスト数", "今月のご利用額"].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: "10px 12px",
                            textAlign: "left",
                            fontSize: 12,
                            fontWeight: 600,
                            color: "#6b7280",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {crossTenantRows.map((row) => (
                      <tr
                        key={row.tenant_id}
                        style={{ borderBottom: "1px solid rgba(31,41,55,0.5)", cursor: "pointer" }}
                        onClick={() => setSelectedTenantId(row.tenant_id)}
                      >
                        <td style={{ padding: "10px 12px", color: "#60a5fa", fontWeight: 600 }}>
                          {row.tenant_id}
                        </td>
                        <td style={{ padding: "10px 12px", color: "#f9fafb" }}>
                          {fmtNum(row.total_requests)}
                        </td>
                        <td style={{ padding: "10px 12px", color: "#4ade80", fontWeight: 600 }}>
                          {fmtCents(row.cost_total_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : !loadingData && !error ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 20px",
            color: "#6b7280",
            fontSize: 15,
          }}
        >
          {tenants.length === 0 ? t("billing.no_tenant") : t("billing.select_tenant")}
        </div>
      ) : null}

      {/* トースト */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#22c55e",
            color: "#022c22",
            padding: "12px 24px",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 600,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 9999,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
