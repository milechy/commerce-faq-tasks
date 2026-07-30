// GID: /copilot-preview では AppSwitcher のロックタブ(R2C2)クリックが無反応だった
// 不具合の回帰テスト。あの画面には AdminAgentUIProvider が無いため、
// useAdminAgentUI() を無条件に呼ぶと throw する。旧UI(Provider有り)の挙動を
// 変えないまま、Provider無しでも onSeedQuery 経由で動くことを固定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AppSwitcher from "./AppSwitcher";
import { AdminAgentUIProvider, useAdminAgentUI } from "../contexts/AdminAgentUIContext";
import { authFetch } from "../lib/api";

// AAAS_ADMIN_URL 未設定だと AppSwitcher は null を返すため、モジュール評価前に立てる
vi.hoisted(() => {
  vi.stubEnv("VITE_AAAS_ADMIN_URL", "https://r2c2.example.test");
});

vi.mock("../auth/useAuth", () => ({
  useAuth: vi.fn(() => ({ isSuperAdmin: false, isLoading: false })),
}));

vi.mock("../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

vi.mock("../lib/supabaseClient", () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

beforeEach(() => {
  // has_r2c2=false = R2C2未契約 → ロックタブ(質問を種まきする側)になる
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ has_r2c2: false }),
  } as Response);
});

// Provider の openWithQuery が呼ばれたことを、Provider の実状態で確認する
function SeedProbe() {
  const { isOpen, seedQuery } = useAdminAgentUI();
  return <div data-testid="probe">{`${isOpen ? "open" : "closed"}/${seedQuery ?? "-"}`}</div>;
}

async function clickR2c2Tab() {
  await waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /R2C2/ }));
}

describe("AppSwitcher", () => {
  it("旧UI(onSeedQuery無し): ロックタブのクリックで openWithQuery が呼ばれる", async () => {
    render(
      <AdminAgentUIProvider>
        <AppSwitcher />
        <SeedProbe />
      </AdminAgentUIProvider>,
    );

    expect(screen.getByTestId("probe").textContent).toBe("closed/-");

    await clickR2c2Tab();

    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("open/R2C2について教えて"),
    );
  });

  it("Provider無し(=/copilot-preview相当)でも onSeedQuery があればクラッシュしない", () => {
    expect(() => render(<AppSwitcher onSeedQuery={vi.fn()} />)).not.toThrow();
    expect(screen.getByRole("button", { name: /R2C2/ })).toBeTruthy();
  });

  it("Provider無し: ロックタブのクリックで onSeedQuery が質問文で呼ばれる", async () => {
    const onSeedQuery = vi.fn();
    render(<AppSwitcher onSeedQuery={onSeedQuery} />);

    await clickR2c2Tab();

    expect(onSeedQuery).toHaveBeenCalledWith("R2C2について教えて");
  });
});
