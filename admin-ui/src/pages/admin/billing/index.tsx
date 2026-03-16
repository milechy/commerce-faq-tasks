import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import UsageChart from "../../../components/UsageChart";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";

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
  invoice_url: string;
  portal_url: string;
}

// ─── ユーティリティ ────────────────────────────────────────
function fmtCents(cents: number): string {
  return `¥${Math.round(cents / 100).toLocaleString("ja-JP")}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("ja-JP");
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

// ─── モックデータ生成 ─────────────────────────────────────
function buildMockDaily(month: string): DailyUsage[] {
  const [year, mon] = month.split("-").map(Number);
  const days = new Date(year, mon, 0).getDate();
  return Array.from({ length: days }, (_, i) => {
    const day = i + 1;
    const reqs = 200 + Math.floor(Math.random() * 300);
    const inTok = reqs * 380;
    const outTok = reqs * 150;
    const cost = Math.round((inTok * 0.003 + outTok * 0.006) * 100);
    return {
      date: `${month}-${String(day).padStart(2, "0")}`,
      requests: reqs,
      input_tokens: inTok,
      output_tokens: outTok,
      cost_total_cents: cost,
    };
  });
}

function buildMockSummary(
  tenantId: string,
  month: string,
  daily: DailyUsage[]
): BillingSummary {
  const total_requests = daily.reduce((s, d) => s + d.requests, 0);
  const total_input_tokens = daily.reduce((s, d) => s + d.input_tokens, 0);
  const total_output_tokens = daily.reduce((s, d) => s + d.output_tokens, 0);
  const cost_llm_cents = daily.reduce((s, d) => s + d.cost_total_cents, 0);
  return {
    tenant_id: tenantId,
    month,
    total_requests,
    total_input_tokens,
    total_output_tokens,
    cost_llm_cents,
    cost_total_cents: Math.round(cost_llm_cents * 2),
    billing_status: "pending",
  };
}

const MOCK_INVOICES: Invoice[] = [
  {
    id: "inv_001",
    month: "2026-02",
    amount_cents: 85000,
    status: "paid",
    invoice_url: "#",
    portal_url: "#",
  },
  {
    id: "inv_002",
    month: "2026-01",
    amount_cents: 72000,
    status: "paid",
    invoice_url: "#",
    portal_url: "#",
  },
];

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

  const currentMonth = new Date().toISOString().slice(0, 7);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonth);

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"requests" | "cost">("requests");

  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // テナント一覧を取得
  useEffect(() => {
    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        navigate("/login", { replace: true });
        return;
      }

      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants`);
        if (res.ok) {
          const data = (await res.json()) as { tenants: Tenant[] };
          setTenants(data.tenants);
          if (data.tenants.length > 0) {
            setSelectedTenantId(data.tenants[0].id);
          }
        } else {
          const mocks: Tenant[] = [
            { id: "tenant_001", name: "サンプル株式会社" },
            { id: "tenant_002", name: "テストコーポレーション" },
          ];
          setTenants(mocks);
          setSelectedTenantId(mocks[0].id);
        }
      } catch {
        const mocks: Tenant[] = [
          { id: "tenant_001", name: "サンプル株式会社" },
          { id: "tenant_002", name: "テストコーポレーション" },
        ];
        setTenants(mocks);
        setSelectedTenantId(mocks[0].id);
      }
    })();
  }, [navigate]);

  // 請求データを取得
  const fetchBillingData = useCallback(async () => {
    if (!selectedTenantId) return;

    setLoadingData(true);
    setError(null);

    try {
      const [summaryRes, invoicesRes] = await Promise.allSettled([
        authFetch(
          `${API_BASE}/v1/admin/billing/usage?tenantId=${selectedTenantId}&month=${selectedMonth}`
        ),
        authFetch(
          `${API_BASE}/v1/admin/billing/invoices?tenantId=${selectedTenantId}`
        ),
      ]);

      const mockDaily = buildMockDaily(selectedMonth);

      if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
        const data = (await summaryRes.value.json()) as {
          summary: BillingSummary;
          daily: DailyUsage[];
        };
        setSummary(data.summary);
        setDaily(data.daily);
      } else {
        setSummary(buildMockSummary(selectedTenantId, selectedMonth, mockDaily));
        setDaily(mockDaily);
      }

      if (invoicesRes.status === "fulfilled" && invoicesRes.value.ok) {
        const data = (await invoicesRes.value.json()) as { invoices: Invoice[] };
        setInvoices(data.invoices);
      } else {
        setInvoices(MOCK_INVOICES);
      }
    } catch {
      setError(t("billing.load_error"));
    } finally {
      setLoadingData(false);
    }
  }, [selectedTenantId, selectedMonth, navigate, t]);

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
      paid: { label: t("billing.invoice_paid"), color: "#4ade80" },
      open: { label: t("billing.invoice_open"), color: "#fbbf24" },
      draft: { label: t("billing.invoice_draft"), color: "#9ca3af" },
    };
    const s = map[status];
    return (
      <span style={{ fontSize: 13, fontWeight: 600, color: s.color }}>
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
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {t("billing.ai_processing", { n: fmtNum(summary.total_input_tokens + summary.total_output_tokens) })}
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

          {/* 日次使用量テーブル */}
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
                    {[t("billing.col_date"), t("billing.col_requests"), t("billing.col_ai"), t("billing.col_cost")].map((h) => (
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
                      <td style={{ padding: "10px 12px", color: "#d1d5db" }}>{d.date}</td>
                      <td style={{ padding: "10px 12px", color: "#f9fafb", fontWeight: 600 }}>
                        {fmtNum(d.requests)}
                      </td>
                      <td style={{ padding: "10px 12px", color: "#9ca3af" }}>
                        {fmtNum(d.input_tokens + d.output_tokens)}
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
                    <td style={{ padding: "12px", fontWeight: 700, color: "#9ca3af" }}>
                      {fmtNum(summary.total_input_tokens + summary.total_output_tokens)}
                    </td>
                    <td style={{ padding: "12px", fontWeight: 700, color: "#4ade80" }}>
                      {fmtCents(summary.cost_total_cents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

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
                        <a
                          href={inv.invoice_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            ...BTN_LINK,
                            fontSize: 14,
                            padding: "10px 16px",
                          }}
                        >
                          {t("billing.view_invoice")}
                        </a>
                        <a
                          href={inv.portal_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            ...BTN_LINK,
                            fontSize: 14,
                            padding: "10px 16px",
                            borderColor: "#22c55e",
                            color: "#4ade80",
                          }}
                        >
                          {t("billing.change_payment")}
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
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
