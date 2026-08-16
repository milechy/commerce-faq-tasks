// 禁止事項21(CLAUDE.md): 500を「テナントが見つかりませんでした」と誤表示しない回帰テスト。
// このページ独自の authFetch(supabase由来のトークン + 生fetch)と、
// ApiKeysTab.fetchApiKeys が使う lib/api の authFetch の両方をモックする必要がある。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Route, Routes } from "react-router-dom";
import { LangProvider } from "../../../i18n/LangContext";
import TenantDetailPage from "./[id]";

const mockGetSession = vi.fn();

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      refreshSession: () => Promise.resolve({ data: { session: null } }),
    },
  },
}));

vi.mock("../../../auth/useAuth", () => ({
  useAuth: () => ({ enterPreview: vi.fn(), isSuperAdmin: true }),
}));

const mockApiKeysAuthFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  authFetch: (...args: unknown[]) => mockApiKeysAuthFetch(...args),
  API_BASE: "http://localhost:3100",
}));

const okSession = { data: { session: { access_token: "test-token" } } };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function renderPage(tenantId = "carnation") {
  return render(
    <LangProvider>
      <MemoryRouter initialEntries={[`/admin/tenants/${tenantId}`]}>
        <Routes>
          <Route path="/admin/tenants/:id" element={<TenantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </LangProvider>,
  );
}

describe("TenantDetailPage — エラー意味論(500 vs 404 vs 401)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetSession.mockReset().mockResolvedValue(okSession);
    mockApiKeysAuthFetch.mockReset().mockResolvedValue(jsonResponse(200, { keys: [] }));
  });

  it("200のとき: タブが描画される", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "carnation", name: "carnation", plan: "starter", is_active: true,
        allowed_origins: [], billing_enabled: false, billing_free_from: null,
        billing_free_until: null, features: { avatar: false, voice: false, rag: true },
        lemonslice_agent_id: null, conversion_types: [],
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("⚙️ 設定")).toBeTruthy());
    expect(screen.queryByText(/テナントが見つかりませんでした/)).toBeNull();
    expect(screen.queryByText(/読み込みに失敗しました/)).toBeNull();
  });

  it("404のとき: 「テナントが見つかりませんでした」を表示し、再試行ボタンは出さない", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not_found" }));

    renderPage();

    // ヘッダーのタイトルと本文の空状態の両方に出るため getAllByText で許容する
    await waitFor(() => expect(screen.getAllByText(/テナントが見つかりませんでした/).length).toBeGreaterThan(0));
    expect(screen.queryByText("やり直す")).toBeNull();
  });

  it("500のとき: 「テナントが見つかりませんでした」を表示せず、読み込み失敗+再試行ボタンを出す", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, { error: "取得に失敗しました" }));

    renderPage();

    await waitFor(() => expect(screen.getAllByText(/読み込みに失敗しました/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/テナントが見つかりませんでした/)).toBeNull();
    expect(screen.getByText("やり直す")).toBeTruthy();
  });

  it("500の後に再試行ボタンを押すと再取得し、成功すればタブが描画される", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "取得に失敗しました" }))
      .mockResolvedValue(
        jsonResponse(200, {
          id: "carnation", name: "carnation", plan: "starter", is_active: true,
          allowed_origins: [], billing_enabled: false, billing_free_from: null,
          billing_free_until: null, features: { avatar: false, voice: false, rag: true },
          lemonslice_agent_id: null, conversion_types: [],
        }),
      );
    global.fetch = fetchMock;

    renderPage();

    await waitFor(() => expect(screen.getByText("やり直す")).toBeTruthy());
    screen.getByText("やり直す").click();

    await waitFor(() => expect(screen.getByText("⚙️ 設定")).toBeTruthy());
  });

  it("401(未ログイン)のとき: 既存どおり /login へ遷移する(挙動を変えない)", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    global.fetch = vi.fn();

    render(
      <LangProvider>
        <MemoryRouter initialEntries={["/admin/tenants/carnation"]}>
          <Routes>
            <Route path="/admin/tenants/:id" element={<TenantDetailPage />} />
            <Route path="/login" element={<div>login-page</div>} />
          </Routes>
        </MemoryRouter>
      </LangProvider>,
    );

    await waitFor(() => expect(screen.getByText("login-page")).toBeTruthy());
  });
});
