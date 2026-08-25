// GID 1217808323616744(P1-7): super_admin で /admin/billing を開くと
// プランカードが「現在のプラン: 確認中」から永遠に変わらないバグの回帰テスト。
//
// 原因: auth context の loadTenantPlan() は previewMode か client_admin しか
// プランを取得せず、素の super_admin は常に null に落ちる。しかもテナントを
// 選択するドロップダウンは PlanSection に一切効いていなかった。
//
// 修正: super_admin のプランは「選択中テナント」から解決する。GET /v1/admin/tenants
// の一覧レスポンスに plan が既に含まれているため、個別取得は増やさない。
// client_admin は従来どおり auth context の tenantPlan を使う(回帰させない)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BillingPage from "./index";

const mockGetSession = vi.fn();
vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      refreshSession: () => Promise.resolve({ data: { session: null } }),
    },
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../../../i18n/LangContext", async () => {
  const jaModule = await import("../../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string, vars?: Record<string, string | number>) => {
    let text = ja[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return text;
  };
  return {
    useLang: () => ({ lang: "ja" as const, setLang: () => {}, t: stableT }),
  };
});

const mockUseAuth = vi.fn();
vi.mock("../../../auth/useAuth", async () => {
  const actual = await vi.importActual<typeof import("../../../auth/useAuth")>("../../../auth/useAuth");
  return { ...actual, useAuth: () => mockUseAuth() };
});

const mockAuthFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

const okSession = { data: { session: { access_token: "test-token" } } };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

// /v1/admin/billing/* や /adjustments はこのテストの関心事ではない。
// 常に失敗させて、使用量サマリー等の重い子コンポーネントの描画を避ける
// (プラン表示ロジックだけを検証したいため)。
function mockAuthFetchImpl(tenantsResponse: () => ReturnType<typeof jsonResponse> | Promise<never>) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (url === "http://localhost:3100/v1/admin/tenants") {
      return Promise.resolve(tenantsResponse());
    }
    return Promise.reject(new Error("network error (out of scope for this test)"));
  });
}

function superAdminAuth(overrides: Record<string, unknown> = {}) {
  mockUseAuth.mockReturnValue({
    isSuperAdmin: true,
    isClientAdmin: false,
    user: { id: "u1", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    tenantPlan: null,
    onboardingStage: null,
    onboardingStageResolved: false,
    ...overrides,
  });
}

function clientAdminAuth(overrides: Record<string, unknown> = {}) {
  mockUseAuth.mockReturnValue({
    isSuperAdmin: false,
    isClientAdmin: true,
    user: { id: "u2", email: "tenant@example.com", role: "client_admin", tenantId: "lp-demo-avator", tenantName: "LPデモ" },
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    tenantPlan: "starter",
    onboardingStage: null,
    onboardingStageResolved: true,
    ...overrides,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/billing"]}>
      <BillingPage />
    </MemoryRouter>
  );
}

describe("BillingPage — プラン表示 (GID 1217808323616744 / P1-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(okSession);
  });

  it("super_admin: テナント一覧取得中は「読み込み中」で、無言の「確認中」に固まらない", async () => {
    let resolveTenants: (v: ReturnType<typeof jsonResponse>) => void = () => {};
    mockAuthFetch.mockImplementation((url: string) => {
      if (url === "http://localhost:3100/v1/admin/tenants") {
        return new Promise((r) => { resolveTenants = r; });
      }
      return Promise.reject(new Error("out of scope"));
    });
    superAdminAuth();
    renderPage();

    await waitFor(() => expect(screen.getByText(/読み込み中/)).toBeTruthy());
    expect(screen.queryByText(/確認中/)).toBeNull();

    resolveTenants(jsonResponse(200, {
      tenants: [{ id: "lp-demo-avator", name: "LPデモ", plan: "starter", is_active: true }],
    }));
    await waitFor(() => expect(screen.getByText(/Starter/)).toBeTruthy());
  });

  it("super_admin: 選択中テナントのプランを一覧レスポンスからそのまま表示する（個別取得しない）", async () => {
    mockAuthFetchImpl(() => jsonResponse(200, {
      tenants: [{ id: "lp-demo-avator", name: "LPデモ", plan: "starter", is_active: true }],
    }));
    superAdminAuth();
    renderPage();

    await waitFor(() => expect(screen.getByText(/現在のプラン/).textContent).toContain("Starter"));

    // GET /v1/admin/tenants/:id への個別取得が発生していないこと
    const calledUrls = mockAuthFetch.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes("/v1/admin/tenants/lp-demo-avator"))).toBe(false);
  });

  it("super_admin: テナントを切り替えるとプラン表示が追随する", async () => {
    mockAuthFetchImpl(() => jsonResponse(200, {
      tenants: [
        { id: "carnation", name: "カーネーション", plan: "growth", is_active: true },
        { id: "lp-demo-avator", name: "LPデモ", plan: "starter", is_active: true },
      ],
    }));
    superAdminAuth();
    renderPage();

    await waitFor(() => expect(screen.getByText(/現在のプラン/).textContent).toContain("Growth"));

    fireEvent.change(screen.getByLabelText("テナントを選択"), { target: { value: "lp-demo-avator" } });

    await waitFor(() => expect(screen.getByText(/現在のプラン/).textContent).toContain("Starter"));
  });

  it("super_admin: テナント一覧の取得に失敗したら「取得できませんでした」と出し、確認中のまま固まらない", async () => {
    mockAuthFetchImpl(() => jsonResponse(500, { error: "internal" }));
    superAdminAuth();
    renderPage();

    await waitFor(() => expect(screen.getByText(/取得できませんでした/)).toBeTruthy());
    expect(screen.queryByText(/確認中/)).toBeNull();
  });

  it("client_admin: 従来どおり auth context の tenantPlan を表示する（回帰なし）", async () => {
    mockAuthFetchImpl(() => jsonResponse(200, { tenants: [] }));
    clientAdminAuth({ tenantPlan: "growth" });
    renderPage();

    await waitFor(() => expect(screen.getByText(/現在のプラン/).textContent).toContain("Growth"));
    // client_admin にはテナント選択ドロップダウンを出さない(自テナント固定)
    expect(screen.queryByLabelText("テナントを選択")).toBeNull();
  });

  it("client_admin: プラン取得が未解決の間は「読み込み中」、解決後もプランが無ければ「取得できませんでした」", async () => {
    mockAuthFetchImpl(() => jsonResponse(200, { tenants: [] }));
    clientAdminAuth({ tenantPlan: null, onboardingStageResolved: false });
    const { rerender } = renderPage();

    await waitFor(() => expect(screen.getByText(/読み込み中/)).toBeTruthy());

    clientAdminAuth({ tenantPlan: null, onboardingStageResolved: true });
    rerender(
      <MemoryRouter initialEntries={["/admin/billing"]}>
        <BillingPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText(/取得できませんでした/)).toBeTruthy());
  });
});

// PR-7(2026-08-25収益監査): Stripeオンボーディング導線の回帰テスト。
// バックエンド(POST /v1/admin/billing/onboard)は tests/phase54/billingDashboard.test.ts
// で網羅済み。ここではUI側の配線 — 未契約(status='no_subscription')の時だけ
// ボタンが出る/押すとonboard APIを叩いて再取得する/super_admin限定 — だけを確認する。
describe("BillingPage — Stripeオンボーディング導線 (PR-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(okSession);
  });

  function mockOnboardingFetchImpl(opts: {
    invoicesStatus?: "ok" | "no_subscription";
    portalUrl?: string | null;
    onboardResponse?: () => ReturnType<typeof jsonResponse>;
  }) {
    const { invoicesStatus = "no_subscription", portalUrl = null, onboardResponse } = opts;
    mockAuthFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === "http://localhost:3100/v1/admin/tenants") {
        return Promise.resolve(jsonResponse(200, {
          tenants: [{ id: "lp-demo-avator", name: "LPデモ", plan: "starter", is_active: true }],
        }));
      }
      if (url.startsWith("http://localhost:3100/v1/admin/billing/invoices")) {
        return Promise.resolve(jsonResponse(200, {
          tenantId: "lp-demo-avator",
          status: invoicesStatus,
          customerId: "",
          portalUrl,
          invoices: [],
        }));
      }
      if (url === "http://localhost:3100/v1/admin/billing/onboard" && init?.method === "POST") {
        return Promise.resolve((onboardResponse ?? (() => jsonResponse(200, { ok: true, alreadyOnboarded: false })))());
      }
      return Promise.reject(new Error("out of scope (onboarding test)"));
    });
  }

  it("super_admin: 未契約テナント(no_subscription)では登録ボタンが出て、押すとonboard APIを叩いて再取得する", async () => {
    mockOnboardingFetchImpl({ invoicesStatus: "no_subscription", portalUrl: null });
    superAdminAuth();
    renderPage();

    const button = await screen.findByText("💳 支払い方法を登録する");
    fireEvent.click(button);

    await waitFor(() => {
      const onboardCalls = mockAuthFetch.mock.calls.filter(
        (c) => c[0] === "http://localhost:3100/v1/admin/billing/onboard"
      );
      expect(onboardCalls.length).toBe(1);
    });

    const onboardCall = mockAuthFetch.mock.calls.find(
      (c) => c[0] === "http://localhost:3100/v1/admin/billing/onboard"
    ) as [string, { method?: string; body?: string }];
    expect(onboardCall[1].method).toBe("POST");
    expect(JSON.parse(onboardCall[1].body ?? "{}")).toEqual({ tenantId: "lp-demo-avator" });

    await waitFor(() => expect(screen.getByText(/登録が完了しました/)).toBeTruthy());
  });

  it("super_admin: 契約済み(portalUrlあり)の場合は登録ボタンを出さず、変更リンクだけを出す", async () => {
    mockOnboardingFetchImpl({ invoicesStatus: "ok", portalUrl: "https://billing.stripe.com/session/abc" });
    superAdminAuth();
    renderPage();

    await screen.findByText("💳 支払い設定を変更");
    expect(screen.queryByText("💳 支払い方法を登録する")).toBeNull();
  });

  it("client_admin: super_admin限定ボタンなので未契約でも出ない", async () => {
    mockOnboardingFetchImpl({ invoicesStatus: "no_subscription", portalUrl: null });
    clientAdminAuth({ tenantPlan: "starter" });
    renderPage();

    await waitFor(() => expect(screen.getByText(/現在のプラン/).textContent).toContain("Starter"));
    expect(screen.queryByText("💳 支払い方法を登録する")).toBeNull();
  });

  it("super_admin: onboard APIが失敗レスポンスを返したら失敗トーストを出し、ボタンは残る(再試行可能)", async () => {
    mockOnboardingFetchImpl({
      invoicesStatus: "no_subscription",
      portalUrl: null,
      onboardResponse: () => jsonResponse(500, { error: "stripe_not_configured" }),
    });
    superAdminAuth();
    renderPage();

    const button = await screen.findByText("💳 支払い方法を登録する");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(/登録に失敗しました/)).toBeTruthy());
    expect(screen.getByText("💳 支払い方法を登録する")).toBeTruthy();
  });
});
