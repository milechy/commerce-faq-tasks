// GID: LP料金表プラン別機能制限のため、AuthContextにtenantPlanを追加した回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./useAuth";

const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } }));

vi.mock("../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: (...args: any[]) => mockGetSession(...args),
      onAuthStateChange: (...args: any[]) => mockOnAuthStateChange(...args),
      signOut: vi.fn(),
    },
  },
}));

vi.mock("../lib/api", () => ({
  authFetch: vi.fn(),
  API_BASE: "http://localhost:3100",
}));

import { authFetch } from "../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function CLIENT_ADMIN_SESSION() {
  return {
    data: {
      session: {
        user: {
          id: "u1",
          email: "client@example.com",
          app_metadata: { role: "client_admin", tenant_id: "tenant-a" },
          user_metadata: {},
        },
      },
    },
  };
}

function SUPER_ADMIN_SESSION() {
  return {
    data: {
      session: {
        user: {
          id: "u2",
          email: "admin@example.com",
          app_metadata: { role: "super_admin" },
          user_metadata: {},
        },
      },
    },
  };
}

function Probe() {
  const { tenantPlan, isLoading, previewMode } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <div data-testid="probe">plan={String(tenantPlan)} preview={String(previewMode)}</div>;
}

describe("useAuth — tenantPlan", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("client_admin: /v1/admin/my-tenant のplanを取得する", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ plan: "growth" }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=growth");
    });
    expect(vi.mocked(authFetch)).toHaveBeenCalledWith("http://localhost:3100/v1/admin/my-tenant");
  });

  it("super_admin(プレビューなし): tenantPlanはnullのまま(集約ビュー)", async () => {
    mockGetSession.mockResolvedValue(SUPER_ADMIN_SESSION());

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=null");
    });
    expect(vi.mocked(authFetch)).not.toHaveBeenCalled();
  });

  it("plan未設定(undefined)時はstarterにフォールバックする", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({}));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=starter");
    });
  });

  it("取得失敗時はnullのまま(機能側で制限あり扱いにできる)", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockRejectedValueOnce(new Error("network"));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=null");
    });
  });
});
