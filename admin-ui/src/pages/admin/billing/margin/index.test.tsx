// admin-ui/src/pages/admin/billing/margin/index.test.tsx
//
// ★このテストが守っているもの★
// 1. 単位の取り違え(原価は$、売上・粗利は¥、換算値は≈¥)
// 2. null を 0 として描かないこと(禁止20)。
//    「算出不可」を「¥0」と出すと、赤字テナントを黒字と誤読させる。
// 3. 読み込み失敗で無限スピナーを残さないこと
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MarginDashboardPage from "./index";

const mockGetSession = vi.fn();
vi.mock("../../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      refreshSession: () => Promise.resolve({ data: { session: null } }),
    },
  },
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../../../i18n/LangContext", async () => {
  const jaModule = await import("../../../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  return {
    useLang: () => ({ lang: "ja" as const, setLang: () => {}, t: (k: string) => ja[k] ?? k }),
  };
});

const mockAuthFetch = vi.fn();
vi.mock("../../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

const okSession = { data: { session: { access_token: "t" } } };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const ROW = {
  tenant_id: "acme",
  tenant_name: "Acme",
  plan: "standard",
  total_requests: 1200,
  text_units: 1500,
  avatar_minutes: 40,
  revenue_estimate_jpy: 22_300,
  cost_base_usd_cents: 1000,      // $10
  cost_base_jpy: 1500,            // ≈¥1,500
  cost_nonbillable_usd_cents: 0,
  cost_nonbillable_jpy: 0,
  gross_profit_jpy: 20_800,
  gross_margin_pct: 93.3,
  estimation_method: "recorded",
  recorded_row_ratio: 1,
  unavailable_reason: null,
};

function body(rows: unknown[] = [ROW], extra: Record<string, unknown> = {}) {
  return {
    period_yyyymm: "202609",
    period_from: "2026-08-31T15:00:00.000Z",
    period_to: "2026-09-30T15:00:00.000Z",
    boundary: "jst_calendar_month",
    margin_assumed: 10,
    fx: { usd_jpy: 150, source: "default", basis: "fixed_rate_estimate" },
    cost_basis: "variable_only",
    tenants: rows,
    truncated: false,
    ...extra,
  };
}

function renderPage() {
  return render(<MemoryRouter><MarginDashboardPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(okSession);
  mockAuthFetch.mockResolvedValue(jsonResponse(200, body()));
});

describe("MarginDashboardPage", () => {
  it("採算一覧を描画する", async () => {
    renderPage();
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("standard")).toBeTruthy();
  });

  it("★単位の取り違え防止: 原価は $、売上・粗利は ¥、換算値は ≈¥★", async () => {
    const { container } = renderPage();
    await screen.findByText("Acme");
    const text = container.textContent ?? "";
    expect(text).toContain("$10");      // API原価(USDセント)
    expect(text).toContain("¥22,300");  // 売上(円)
    expect(text).toContain("¥20,800");  // 粗利(円)
    expect(text).toContain("≈¥1,500");  // 換算値は近似記号つき
  });

  it("★売上が算出不可なら「算出不可」であって「¥0」ではない★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([{
      ...ROW, revenue_estimate_jpy: null, gross_profit_jpy: null,
      gross_margin_pct: null, unavailable_reason: "revenue_estimate_unavailable",
    }])));
    const { container } = renderPage();
    await screen.findByText("Acme");
    const text = container.textContent ?? "";
    expect(text).toContain("算出不可");
    expect(text).not.toContain("¥0");
  });

  it("推計原価には「推計」チップが付く（実測と見分けられる）", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([
      { ...ROW, estimation_method: "derived", recorded_row_ratio: 0 },
    ])));
    renderPage();
    expect(await screen.findByText("推計")).toBeTruthy();
  });

  it("★固定費を含まないことを常時表示する★", async () => {
    const { container } = renderPage();
    await screen.findByText("Acme");
    expect(container.textContent).toContain("固定費");
  });

  it("為替が固定レートの概算であることを明示する", async () => {
    const { container } = renderPage();
    await screen.findByText("Acme");
    expect(container.textContent).toContain("固定レート");
  });

  it("マージン倍率を開示する（後から検算できる）", async () => {
    const { container } = renderPage();
    await screen.findByText("Acme");
    expect(container.textContent).toContain("×10");
  });

  it("既定は粗利率の昇順（採算の悪い順に並ぶ）", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([
      { ...ROW, tenant_id: "good", tenant_name: "Good", gross_margin_pct: 90 },
      { ...ROW, tenant_id: "bad", tenant_name: "Bad", gross_margin_pct: 10 },
    ])));
    const { container } = renderPage();
    await screen.findByText("Bad");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain("Bad");
  });

  it("★算出不可の行はソートで常に末尾（0扱いで最上位に来ない）★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([
      { ...ROW, tenant_id: "n", tenant_name: "NullOne", gross_margin_pct: null },
      { ...ROW, tenant_id: "bad", tenant_name: "Bad", gross_margin_pct: 10 },
    ])));
    const { container } = renderPage();
    await screen.findByText("Bad");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain("Bad");
    expect(rows[1]?.textContent).toContain("NullOne");
  });

  it("ソート見出しをクリックすると並びが変わる", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([
      { ...ROW, tenant_id: "a", tenant_name: "AAA", total_requests: 10 },
      { ...ROW, tenant_id: "b", tenant_name: "BBB", total_requests: 999 },
    ])));
    const { container } = renderPage();
    await screen.findByText("AAA");
    fireEvent.click(screen.getByText("リクエスト"));
    await waitFor(() => {
      expect(container.querySelectorAll("tbody tr")[0]?.textContent).toContain("AAA");
    });
  });

  it("★読み込み失敗で無限スピナーを残さず、再試行できる★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(500, {}));
    renderPage();
    await waitFor(() => expect(screen.queryByText("読み込み中…")).toBeNull());
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("403 は「super_admin のみ」と伝える（原因が分かる文言）", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(403, {}));
    renderPage();
    expect(await screen.findByText(/super_admin のみ/)).toBeTruthy();
  });

  it("契約が壊れたレスポンスでもクラッシュせずエラー表示に落ちる", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { tenants: "not-an-array" }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("上限で切られたことを黙らずに出す", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([ROW], { truncated: true })));
    renderPage();
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("未ログインならログイン画面へ送る", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    renderPage();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true }));
  });

  it("★表は横スクロールできる（390px で本文が溢れない）★", async () => {
    const { container } = renderPage();
    await screen.findByText("Acme");
    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    const wrapper = table!.parentElement as HTMLElement;
    expect(wrapper.style.overflowX).toBe("auto");
  });

  it("利用が無い月は空表ではなく説明を出す", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([])));
    renderPage();
    expect(await screen.findByText(/利用のあったテナントはありません/)).toBeTruthy();
  });
});

describe('MarginDashboardPage — イレギュラー操作・XSS耐性', () => {
  it('★tenant_name に <script> が混ざっても実行可能なDOMとして解釈されない★', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([{
      ...ROW, tenant_name: '<script>window.__xss_margin = true</script>Evil Corp',
    }])));
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());

    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __xss_margin?: boolean }).__xss_margin).toBeUndefined();
    expect(container.textContent).toContain('<script>');
  });

  it('テナントが1000件でもクラッシュせず描画する(大規模データの耐性)', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...ROW, tenant_id: `t${i}`, tenant_name: `T${i}` }));
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body(many)));
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(1000));
  });

  it('period に未来月を指定しても(月セレクタの選択肢外の値が来ても)クラッシュしない', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([ROW], { period_yyyymm: '209912' })));
    const { container } = renderPage();
    await screen.findByText('Acme');
    expect(container.textContent).not.toContain('undefined');
  });

  it('同じ月を素早く連続選択しても(月セレクタの多重fire)最終状態が壊れない', async () => {
    renderPage();
    await screen.findByText('Acme');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const target = select.options[1]?.value ?? select.value;
    fireEvent.change(select, { target: { value: target } });
    fireEvent.change(select, { target: { value: target } });
    fireEvent.change(select, { target: { value: target } });
    await waitFor(() => expect(select.value).toBe(target));
  });

  it('CSVボタンはデータが0件のとき無効化される(空データでのエクスポート試行を防ぐ)', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body([])));
    renderPage();
    await screen.findByText(/利用のあったテナントはありません/);
    const btn = screen.getByText('CSVで書き出す') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('★テナント名をクリックするとドリルダウンが開き、選択中の月(period)で突合を叩く★(P1b)', async () => {
    // MarginDashboardPage は UpsellProposalsSection(GET /v1/admin/upsell-proposals)と
    // 自身の economics 一覧取得を両方 authFetch で叩くため、calls[0]/[1] はその2本。
    // クリック後のドリルダウン用リクエストは calls[2] に来る。
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [], truncated: false }))
      .mockResolvedValueOnce(jsonResponse(200, body()))
      .mockResolvedValueOnce(jsonResponse(200, {
        row: ROW,
        period_yyyymm: '202609', period_from: 'x', period_to: 'y', boundary: 'jst_calendar_month',
        margin_assumed: 10, fx: { usd_jpy: 150, source: 'default', basis: 'fixed_rate_estimate' },
        cost_basis: 'variable_only',
        invoiced: {
          amount_jpy: 23_000, status: 'paid', invoice_id: 'in_1', hosted_invoice_url: null,
          finalized: true, reason: null,
        },
        variance_jpy: 700,
      }));
    renderPage();
    await screen.findByText('Acme');

    fireEvent.click(screen.getByTitle('Stripe実請求との突合を見る'));

    await waitFor(() => {
      const call = mockAuthFetch.mock.calls[2]!;
      expect(call[0]).toBe('http://localhost:3100/v1/admin/billing/economics/acme?period=202609&reconcile=stripe');
    });
    expect(await screen.findByText(/¥23,000/)).toBeTruthy();
  });

  it('ドリルダウンを閉じても背後の一覧はそのまま残る', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [], truncated: false }))
      .mockResolvedValueOnce(jsonResponse(200, body()))
      .mockResolvedValueOnce(jsonResponse(500, {}));
    renderPage();
    await screen.findByText('Acme');

    fireEvent.click(screen.getByTitle('Stripe実請求との突合を見る'));
    await screen.findByText(/取得に失敗しました/);

    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(screen.queryByText(/取得に失敗しました/)).toBeNull();
    expect(screen.getByText('Acme')).toBeTruthy();
  });
});
