// GID: LP料金表(Growth〜: 会話分析/成約・効果分析)に基づくnav非表示の回帰テスト
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { useAuth } from "../auth/useAuth";

vi.mock("../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("./common/NotificationBell", () => ({
  NotificationBell: () => <div />,
}));

vi.mock("./AppSwitcher", () => ({
  default: () => <div />,
}));

function baseAuth(overrides: Partial<ReturnType<typeof useAuth>>) {
  return {
    user: { id: "1", email: "a@example.com", role: "client_admin", tenantId: "tenant-a", tenantName: "Tenant A" },
    isLoading: false,
    isSuperAdmin: false,
    isClientAdmin: true,
    logout: vi.fn(),
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    enterPreview: vi.fn(),
    exitPreview: vi.fn(),
    tenantPlan: null,
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <AppSidebar />
    </MemoryRouter>,
  );
}

describe("AppSidebar — plan制限によるnav非表示", () => {
  it("client_admin + plan=starter → 会話分析/成約・効果分析が非表示", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "starter" }));
    renderSidebar();

    expect(screen.queryByText("会話分析")).toBeNull();
    expect(screen.queryByText("成約・効果分析")).toBeNull();
    // 制限対象外の項目は表示されたまま
    expect(screen.getByText("会話履歴")).toBeTruthy();
  });

  it("client_admin + plan=growth → 会話分析/成約・効果分析が表示される", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    renderSidebar();

    expect(screen.getByText("会話分析")).toBeTruthy();
    expect(screen.getByText("成約・効果分析")).toBeTruthy();
  });

  it("client_admin + plan未取得(null) → fail-safeで非表示", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: null }));
    renderSidebar();

    expect(screen.queryByText("会話分析")).toBeNull();
    expect(screen.queryByText("成約・効果分析")).toBeNull();
  });

  it("super_adminの自身の集約ビュー(プレビューなし) → planに関わらず表示される", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: true,
        isClientAdmin: false,
        tenantPlan: null,
        user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
      }),
    );
    renderSidebar();

    expect(screen.getByText("会話分析")).toBeTruthy();
    expect(screen.getByText("成約・効果分析")).toBeTruthy();
  });

  it("super_adminのプレビュー中 + plan=starter → 非表示(実際のクライアント体験を正確に反映)", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: false, // プレビュー中はclient_admin相当にフォールバック
        previewMode: true,
        previewTenantId: "preview-tenant",
        tenantPlan: "starter",
      }),
    );
    renderSidebar();

    expect(screen.queryByText("会話分析")).toBeNull();
    expect(screen.queryByText("成約・効果分析")).toBeNull();
  });
});
