// テナント自身のプラン変更UI。
// ここで固定するのは見た目ではなく「開示義務」に当たる挙動:
//   - 実行前に確認を挟むこと（1クリックでプランが変わらない）
//   - ダウングレードで失う機能を名指しで出すこと
//   - free_ad の制約（上限・バッジ・共有プール必須）を出すこと
//   - 「即時反映」と言わないこと（CLAUDE.md 禁止38: ウィジェットは最大24hキャッシュ）
//   - tenantId を body に載せないこと（CLAUDE.md 禁止1）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlanSection } from "./PlanSection";
import { authFetch } from "../../../lib/api";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const mockUseAuth = vi.fn();
vi.mock("../../../auth/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

const asClientAdmin = () => mockUseAuth.mockReturnValue({ user: { role: "client_admin" } });

beforeEach(() => {
  vi.clearAllMocks();
  asClientAdmin();
  (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => ({ plan: "growth" }),
  });
});

function renderSection(currentPlan: "free_ad" | "starter" | "growth" | "enterprise" | null) {
  const onChanged = vi.fn();
  const showToast = vi.fn();
  render(<PlanSection currentPlan={currentPlan} onChanged={onChanged} showToast={showToast} />);
  return { onChanged, showToast };
}

describe("PlanSection", () => {
  it("現在のプランを利用中として示し、そのボタンは押せない", () => {
    renderSection("starter");
    expect(screen.getByText(/利用中/)).toBeTruthy();
    const starterBtn = screen.getByRole("button", { name: /Starter/ });
    expect((starterBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("プランを選んだだけでは変更されず、確認が出る", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    expect(screen.getByText(/変更しますか？/)).toBeTruthy();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("アップグレードでは使えるようになる機能を出す", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    expect(screen.getByText("使えるようになる機能")).toBeTruthy();
    expect(screen.getByText("AIアバター")).toBeTruthy();
  });

  it("ダウングレードでは失う機能を名指しで出す", () => {
    renderSection("enterprise");
    fireEvent.click(screen.getByRole("button", { name: /Starter/ }));
    expect(screen.getByText("使えなくなる機能")).toBeTruthy();
    expect(screen.getByText("音声クローン")).toBeTruthy();
    expect(screen.getByText("ディープリサーチ")).toBeTruthy();
  });

  it("free_ad を選ぶと上限・バッジ・共有プール必須を出す", () => {
    renderSection("growth");
    fireEvent.click(screen.getByRole("button", { name: /Free/ }));
    expect(screen.getByText(/月200リクエストまで/)).toBeTruthy();
    // プラン選択肢の説明文にも同じ文言があるため複数ヒットする
    expect(screen.getAllByText(/Powered by R2C/).length).toBeGreaterThan(0);
    expect(screen.getByText(/共有学習プール/)).toBeTruthy();
  });

  it("既発生分が遡らないことを明示する", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    expect(screen.getByText(/変更前の単価のまま請求されます/)).toBeTruthy();
  });

  // ★禁止38★ ウィジェット配信は最大24hキャッシュ。即時反映を約束してはいけない。
  it("「即時反映」と書かず、反映に時間がかかることを伝える", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    const dialogText = document.body.textContent ?? "";
    expect(dialogText).not.toMatch(/即時反映|すぐに反映されます/);
    expect(dialogText).toMatch(/最大24時間/);
  });

  it("確認後に PUT /v1/admin/my-tenant/plan を呼び、body にテナントIDを載せない", async () => {
    const { onChanged } = renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const [url, init] = (authFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/v1/admin/my-tenant/plan");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ plan: "growth" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("growth"));
  });

  it("APIが失敗したらメッセージを出し、変更済みとして扱わない", async () => {
    (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ message: "テナントIDが見つかりません" }),
    });
    const { onChanged } = renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

    await waitFor(() => expect(screen.getByText("テナントIDが見つかりません")).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
  });

  // super_admin の JWT には tenant_id が無く API が 403 を返すため、
  // 押せるボタンとして出さない。判定は生の role（CLAUDE.md 禁止13: isSuperAdmin を使わない）。
  it("client_admin 以外には変更ボタンを出さない", () => {
    mockUseAuth.mockReturnValue({ user: { role: "super_admin" } });
    renderSection("starter");
    expect((screen.getByRole("button", { name: /Growth/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/テナント管理者アカウントから/)).toBeTruthy();
  });

  it("プラン未確定でも画面が壊れない", () => {
    renderSection(null);
    expect(screen.getByText(/確認中/)).toBeTruthy();
  });
});
