// GID: 新UI(/copilot-preview)にログアウト手段が無く、Phase4トグルでこの画面を
// 既定にすると詰む不具合の回帰テスト。左レール下部のログアウトボタンが
// logout() → navigate("/login") を実行することを検証する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CopilotPreviewPage from "./index";
import { useAuth } from "../../auth/useAuth";

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { authFetch } from "../../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as Response);

function baseAuth(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: { id: "1", email: "a@example.com", role: "client_admin", tenantId: "tenant-a", tenantName: "Tenant A" },
    isLoading: false,
    isSuperAdmin: false,
    isClientAdmin: true,
    logout: vi.fn().mockResolvedValue(undefined),
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    enterPreview: vi.fn(),
    exitPreview: vi.fn(),
    tenantPlan: null,
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

function renderPage(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  vi.mocked(useAuth).mockReturnValue(baseAuth(overrides));
  return render(
    <MemoryRouter>
      <CopilotPreviewPage />
    </MemoryRouter>,
  );
}

describe("CopilotPreviewPage — ログアウト", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    // マウント時のブリーフィング取得(sendReal)・オンボーディング判定を素通りさせる
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });
  });

  it("ログアウトボタンが描画されている", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy());
  });

  it("クリックすると logout() が呼ばれ、/login へ遷移する", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    renderPage({ logout });

    const button = await waitFor(() => screen.getByRole("button", { name: /ログアウト/ }));
    fireEvent.click(button);

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true }));
  });

  it("previewMode中でもログアウトボタンが機能する(super_admin自身がログアウトされる)", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    renderPage({
      logout,
      previewMode: true,
      previewTenantId: "tenant-preview",
      previewTenantName: "Preview Tenant",
      isSuperAdmin: true,
    });

    const button = await waitFor(() => screen.getByRole("button", { name: /ログアウト/ }));
    fireEvent.click(button);

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true }));
  });
});

// GID: /copilot-preview のモバイル対応(左レールのドロワー化)の回帰テスト。
// happy-dom ではレイアウトの実際の見た目(幅・position:fixed の描画結果等)は検証できないため、
// ドロワーの開閉状態(className)・オーバーレイの有無・会話中ロックが維持されることを
// 状態遷移として検証する。タイプライター演出は matchMedia で reduce-motion を強制して無効化し、
// テストを決定的にしている。
function getRail(): HTMLElement {
  return document.querySelector(".cp-rail") as HTMLElement;
}

function getBackdrop(): HTMLElement | null {
  return document.querySelector(".cp-rail-backdrop");
}

describe("CopilotPreviewPage — モバイル左レールのドロワー化", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({ reply: "今週も順調です", actions: [] }));
    // タイプライター演出(setInterval)を無効化し、応答を同期的に確定させてテストを決定的にする
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("初期状態ではドロワーは閉じており、オーバーレイも存在しない", async () => {
    // super_admin(client_admin以外)は my-tenant 判定をスキップして直接ブリーフィングへ進む
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    expect(getRail().className).not.toContain("cp-rail-open");
    expect(getBackdrop()).toBeNull();
  });

  it("ハンバーガーボタンでドロワーが開き、背景オーバーレイが表示される", async () => {
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));

    expect(getRail().className).toContain("cp-rail-open");
    expect(getBackdrop()).not.toBeNull();
  });

  it("オーバーレイをタップするとドロワーが閉じる", async () => {
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(getBackdrop()).not.toBeNull();

    fireEvent.click(getBackdrop()!);

    expect(getBackdrop()).toBeNull();
    expect(getRail().className).not.toContain("cp-rail-open");
  });

  it("レール内の閉じるボタン(✕)でもドロワーが閉じる", async () => {
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(getRail().className).toContain("cp-rail-open");

    fireEvent.click(screen.getByRole("button", { name: "メニューを閉じる" }));
    expect(getRail().className).not.toContain("cp-rail-open");
  });

  it("会話中でない状態でカテゴリーを選択するとドロワーが閉じる", async () => {
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null } });
    // bootstrap完了(送信ボタンのdisabled解除)を待ってから操作する
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(getRail().className).toContain("cp-rail-open");

    fireEvent.click(screen.getByRole("button", { name: /今週のまとめ/ }));
    expect(getRail().className).not.toContain("cp-rail-open");
  });

  it("会話中(busy)は他カテゴリーへの切り替えロックがドロワー化後も維持される", async () => {
    let resolveFetch: (v: Response) => void = () => {};
    vi.mocked(authFetch).mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(getRail().className).toContain("cp-rail-open");

    // sending中は現在アクティブでないカテゴリーのボタンがdisabledのまま(ドロワー化前と同じロック)
    const weeklyBtn = screen.getByRole("button", { name: /今週のまとめ/ }) as HTMLButtonElement;
    expect(weeklyBtn.disabled).toBe(true);

    // disabledボタンはクリックしても何も起きない(active・ドロワー状態とも変化しない)
    fireEvent.click(weeklyBtn);
    expect(getRail().className).toContain("cp-rail-open");

    // 後片付け: pendingのfetchを解決し、タイマー等が残らないようにする
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ reply: "ok", actions: [] }) } as unknown as Response);
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
  });
});
