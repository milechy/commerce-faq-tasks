// 回帰テスト: GET /v1/admin/tenants の応答形状 (is_active/created_at/api_key_count)
// と Tenant 型のフィールド名の不一致により、フィルタ・ソート・状態バッジ・APIキー件数・
// 作成日表示が全て機能しなくなっていた問題の修正確認。
// [id].test.tsx と同じパターンで supabase の getSession をモックする
// （このページ独自の authFetch は lib/api ではなく supabase から直接トークンを取る）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TenantsPage from "./index";

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

const okSession = { data: { session: { access_token: "test-token" } } };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

// GET /v1/admin/tenants の実際の応答形状（is_active/created_at/api_key_count、snake_case）
function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: "carnation",
    name: "カーネーション",
    plan: "starter" as const,
    is_active: true,
    api_key_count: 2,
    created_at: "2026-03-14T00:00:00Z",
    billing_enabled: false,
    billing_free_from: null,
    billing_free_until: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/tenants"]}>
      <TenantsPage />
    </MemoryRouter>
  );
}

describe("TenantsPage — API応答形状とUIフィールドの整合性", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetSession.mockResolvedValue(okSession);
  });

  it("is_active=true のテナントを「有効」バッジで表示する（status由来の誤判定が無いこと）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ is_active: true })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("有効")).toBeTruthy());
  });

  it("is_active=false のテナントを「無効」バッジで表示する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ is_active: false })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("無効")).toBeTruthy());
  });

  it("provisioning_source='wordpress_plugin' のテナントに「WordPress」バッジを表示する(WP-15/D11)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ provisioning_source: "wordpress_plugin" })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("WordPress")).toBeTruthy());
  });

  it("provisioning_source='manual'(既定)のテナントには流入元バッジを出さない", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ provisioning_source: "manual" })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("カーネーション")).toBeTruthy());
    expect(screen.queryByText("WordPress")).toBeNull();
  });

  it("api_key_count を実際の件数で表示する（0固定のバグの回帰防止）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ api_key_count: 3 })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("APIキー: 3件")).toBeTruthy());
  });

  it("api_key_count が0のテナントは「APIキー: 0件」と表示する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ api_key_count: 0 })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("APIキー: 0件")).toBeTruthy());
  });

  it("created_at を「作成日: -」ではなく実際の日付で表示する（NaN比較バグの回帰防止）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ created_at: "2026-03-14T00:00:00Z" })] })
    );
    renderPage();
    await waitFor(() => {
      const el = screen.getByText(/作成日:/);
      expect(el.textContent).not.toContain("作成日: -");
      expect(el.textContent).toContain("2026");
    });
  });

  it("id を旧slugの代わりに表示する（DBに存在しないslug列を参照しない）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { tenants: [makeTenant({ id: "carnation" })] })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("carnation")).toBeTruthy());
  });

  it('「有効のみ」フィルタで is_active=false のテナントを除外する（フィルタ0件バグの回帰防止）', async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        tenants: [
          makeTenant({ id: "active-tenant", name: "有効テナント", is_active: true }),
          makeTenant({ id: "inactive-tenant", name: "無効テナント", is_active: false }),
        ],
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("有効テナント")).toBeTruthy());
    expect(screen.getByText("無効テナント")).toBeTruthy();

    fireEvent.click(screen.getByText("有効のみ"));

    await waitFor(() => expect(screen.queryByText("無効テナント")).toBeNull());
    expect(screen.getByText("有効テナント")).toBeTruthy();
  });

  it('「無効のみ」フィルタで is_active=true のテナントを除外する', async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        tenants: [
          makeTenant({ id: "active-tenant", name: "有効テナント", is_active: true }),
          makeTenant({ id: "inactive-tenant", name: "無効テナント", is_active: false }),
        ],
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("有効テナント")).toBeTruthy());

    fireEvent.click(screen.getByText("無効のみ"));

    await waitFor(() => expect(screen.queryByText("有効テナント")).toBeNull());
    expect(screen.getByText("無効テナント")).toBeTruthy();
  });

  it("作成日ソートを created_at の実日付で正しく並べ替える（NaN比較で常に0だったバグの回帰防止）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        tenants: [
          makeTenant({ id: "older", name: "古いテナント", created_at: "2026-01-01T00:00:00Z" }),
          makeTenant({ id: "newer", name: "新しいテナント", created_at: "2026-06-01T00:00:00Z" }),
        ],
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("新しいテナント")).toBeTruthy());

    // 既定は created_at 降順 → 新しい方が先に描画される
    const names = screen.getAllByText(/テナント$/).map((el) => el.textContent);
    expect(names.indexOf("新しいテナント")).toBeLessThan(names.indexOf("古いテナント"));
  });
});
