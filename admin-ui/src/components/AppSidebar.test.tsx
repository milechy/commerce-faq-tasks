// GID: LP料金表(Growth〜: 会話分析/成約・効果分析)に基づくnav非表示の回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppSidebar, MobileHeader, MobileBottomBar } from "./AppSidebar";
import { useAuth } from "../auth/useAuth";

vi.mock("../auth/useAuth", () => ({
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

vi.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("./common/NotificationBell", () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

vi.mock("./AppSwitcher", () => ({
  default: () => <div />,
}));

// happy-dom は matchMedia を実装していないため、既存テスト(デスクトップ幅前提)が
// AppSidebar/MobileHeader の viewport 判定で例外を起こさないよう、既定でデスクトップ
// (max-width: 767px に非マッチ)としてモックする。モバイル固有のテストは
// このモックを個別に上書きする。
function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  mockMatchMedia(false);
});

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

// GID 1216944004404664: LP未記載機能の正式プラン組み入れ。
// Starterから提供する機能に誤ってゲートをかけていないことの回帰テスト。
describe("AppSidebar — Starterプランでも使える機能(誤ゲート防止の回帰テスト)", () => {
  it("client_admin + plan=starter → 対応中の会話/未回答質問/お客様への声がけ設定が表示される", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "starter" }));
    renderSidebar();

    expect(screen.getByText("対応中の会話")).toBeTruthy();
    expect(screen.getByText("未回答質問")).toBeTruthy();
    expect(screen.getByText("お客様への声がけ設定")).toBeTruthy();
  });

  it("client_admin + plan未取得(null) → 対応中の会話/未回答質問/お客様への声がけ設定は非ゲートのため表示される", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: null }));
    renderSidebar();

    expect(screen.getByText("対応中の会話")).toBeTruthy();
    expect(screen.getByText("未回答質問")).toBeTruthy();
    expect(screen.getByText("お客様への声がけ設定")).toBeTruthy();
  });
});

describe("AppSidebar — ご利用状況・お支払いの可視性", () => {
  it("client_adminにも「ご利用状況・お支払い」が表示される（旧UIはsuper_admin限定表示ではなかった）", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    renderSidebar();

    expect(screen.getByText("ご利用状況・お支払い")).toBeTruthy();
  });

  it("super_adminにも表示される", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: true,
        isClientAdmin: false,
        user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
      }),
    );
    renderSidebar();

    expect(screen.getByText("ご利用状況・お支払い")).toBeTruthy();
  });
});

// GID 1216993321226858: 旧UIから新UI(/copilot-preview)への復帰導線。
// target="_blank" が効かない環境やチャット・ファースト既定OFFのユーザーが
// 旧UIで行き止まりにならないことを担保する。
describe("AppSidebar — AIチャット(新UI)への復帰導線", () => {
  it("client_admin → /copilot-preview?from=legacy へのリンクが表示される", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    renderSidebar();

    const link = screen.getByText("AIチャットに戻る").closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/copilot-preview?from=legacy");
    // 既存navの回帰確認
    expect(screen.getByText("会話履歴")).toBeTruthy();
  });

  it("super_adminのプレビュー中(isClientAdmin=true) → 表示される", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: false, // プレビュー中はclient_admin相当にフォールバック
        isClientAdmin: true,
        previewMode: true,
        previewTenantId: "preview-tenant",
        tenantPlan: "growth",
      }),
    );
    renderSidebar();

    expect(screen.getByText("AIチャットに戻る").closest("a")?.getAttribute("href")).toBe(
      "/copilot-preview?from=legacy",
    );
    expect(screen.getByText("会話履歴")).toBeTruthy();
  });

  it("プレビューなしのsuper_admin → 非表示(テナント未解決でチャットが機能しないため)", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: true,
        isClientAdmin: false,
        previewMode: false,
        user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
      }),
    );
    renderSidebar();

    expect(screen.queryByText("AIチャットに戻る")).toBeNull();
    // 既存navは従来どおり表示されたまま
    expect(screen.getByText("会話履歴")).toBeTruthy();
    expect(screen.getByText("テナント管理")).toBeTruthy();
  });

  // GID 1217535151513730: rel="opener"付きの内部リンクで開かれた新規タブなら
  // window.opener が渡っている。SPA遷移せずタブごと閉じて元のタブ(会話が残っている側)へ戻す。
  it("window.openerがある場合 → クリックでタブを閉じ、SPA遷移しない", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    const originalOpener = window.opener;
    Object.defineProperty(window, "opener", { value: {}, configurable: true });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      renderSidebar();
      const link = screen.getByText("AIチャットに戻る").closest("a") as HTMLAnchorElement;
      fireEvent.click(link);

      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "opener", { value: originalOpener, configurable: true });
      closeSpy.mockRestore();
    }
  });

  it("window.openerが無い場合 → タブを閉じずリンクのまま(通常のSPA遷移に任せる)", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    const originalOpener = window.opener;
    Object.defineProperty(window, "opener", { value: null, configurable: true });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      renderSidebar();
      const link = screen.getByText("AIチャットに戻る").closest("a") as HTMLAnchorElement;
      fireEvent.click(link);

      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "opener", { value: originalOpener, configurable: true });
      closeSpy.mockRestore();
    }
  });

  // GID: ブラウザはタブ内で複数ページ遷移した後などclose()を無視することがある
  // (script非開設扱いになるため)。閉じられなかった場合に「詰み」にならず、
  // 通常のSPA遷移へフォールバックすることの回帰テスト。
  it("window.opener はあるがタブが閉じられない場合 → 少し待って通常のSPA遷移にフォールバックする", async () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    mockNavigate.mockReset();
    const originalOpener = window.opener;
    Object.defineProperty(window, "opener", { value: {}, configurable: true });
    // close()が呼ばれても実際には閉じない(=window.closedがfalseのまま)状況を再現する
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      renderSidebar();
      const link = screen.getByText("AIチャットに戻る").closest("a") as HTMLAnchorElement;
      fireEvent.click(link);

      expect(closeSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/copilot-preview?from=legacy"));
    } finally {
      Object.defineProperty(window, "opener", { value: originalOpener, configurable: true });
      closeSpy.mockRestore();
    }
  });
});

// GID 1217535151513730: モバイル下部バー(5枠)。analyticsはgrowth以上のプラン制限があり
// starterテナントには意味の無い枠のため、client_adminには代わりにAIチャットへの導線を出す。
// previewModeでない素のsuper_adminには従来どおりanalyticsを出す。
describe("AppSidebar — MobileBottomBar(client_adminは分析→AIチャットに置換)", () => {
  function renderBottomBar() {
    return render(
      <MemoryRouter>
        <MobileBottomBar />
      </MemoryRouter>,
    );
  }

  it("client_admin → 「分析」の代わりに「AIチャット」(/copilot-preview)が出る", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    renderBottomBar();

    expect(screen.queryByText("分析")).toBeNull();
    const link = screen.getByText("AIチャット").closest("a");
    expect(link?.getAttribute("href")).toBe("/copilot-preview");
    // 残り4枠は従来どおり
    expect(screen.getByText("ホーム")).toBeTruthy();
    expect(screen.getByText("会話")).toBeTruthy();
    expect(screen.getByText("知識データ")).toBeTruthy();
    expect(screen.getByText("設定")).toBeTruthy();
  });

  it("プレビューなしの素のsuper_admin → 従来どおり「分析」が出る", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: true,
        isClientAdmin: false,
        previewMode: false,
        user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
      }),
    );
    renderBottomBar();

    expect(screen.getByText("分析")).toBeTruthy();
    expect(screen.queryByText("AIチャット")).toBeNull();
  });

  it("super_adminのプレビュー中(isClientAdmin=true) → 「AIチャット」が出る", () => {
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({
        isSuperAdmin: false,
        isClientAdmin: true,
        previewMode: true,
        previewTenantId: "preview-tenant",
        tenantPlan: "growth",
      }),
    );
    renderBottomBar();

    expect(screen.getByText("AIチャット")).toBeTruthy();
    expect(screen.queryByText("分析")).toBeNull();
  });
});

// GID: ThemeToggle を common/ThemeToggle.tsx へ切り出した際の回帰テスト。
// 移設のみでスタイル・ロジックは変更していないため、フッターのテーマ切替
// (ライト/ダーク/自動の3ボタン)が従来どおり描画されることだけを確認する。
describe("AppSidebar — ThemeToggle切り出し後の回帰テスト", () => {
  it("フッターにテーマ切替(ライト/ダーク/自動)が描画される", () => {
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    renderSidebar();

    expect(screen.getByTitle("ライト")).toBeTruthy();
    expect(screen.getByTitle("ダーク")).toBeTruthy();
    expect(screen.getByTitle("自動")).toBeTruthy();
  });
});

// 通知ベルの3重マウント回帰テスト(オフスクリーンrailの非マウント化)。
// .app-sidebar は @media(max-width:767px) で transform: translateX(-100%) されるだけで
// DOMには残るため、NotificationBell(setIntervalでポーリング)がAppSidebar rail /
// MobileHeader上部バー / モバイルドロワーの最大3箇所で同時にマウントされ得た。
describe("AppSidebar / MobileHeader — 通知ベルの3重マウント解消", () => {
  it("デスクトップ幅: ベルはAppSidebar(rail)の1個のみ描画される", () => {
    mockMatchMedia(false); // (max-width: 767px) に非マッチ = デスクトップ
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    renderSidebar();

    expect(screen.getAllByTestId("notification-bell")).toHaveLength(1);
  });

  it("デスクトップ幅: MobileHeaderはnullを返しベルを持たない(二重ポーリング防止)", () => {
    mockMatchMedia(false);
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    const { container } = render(
      <MemoryRouter>
        <MobileHeader />
      </MemoryRouter>,
    );

    expect(screen.queryAllByTestId("notification-bell")).toHaveLength(0);
    expect(container.firstChild).toBeNull();
  });

  it("モバイル幅: AppSidebarはnullを返しベルを持たない(オフスクリーンrailの非マウント化)", () => {
    mockMatchMedia(true); // (max-width: 767px) にマッチ = モバイル
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    const { container } = renderSidebar();

    expect(screen.queryAllByTestId("notification-bell")).toHaveLength(0);
    expect(container.firstChild).toBeNull();
  });

  it("モバイル幅: ベルはMobileHeader上部バーの1個のみ描画される", () => {
    mockMatchMedia(true);
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    render(
      <MemoryRouter>
        <MobileHeader />
      </MemoryRouter>,
    );

    expect(screen.getAllByTestId("notification-bell")).toHaveLength(1);
  });

  it("モバイル幅でドロワーを開いても、ベルは1個のまま(ドロワー側のベルは出さない)", () => {
    mockMatchMedia(true);
    vi.mocked(useAuth).mockReturnValue(baseAuth({ tenantPlan: "growth" }));
    render(
      <MemoryRouter>
        <MobileHeader />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText("メニューを開く"));

    expect(screen.getAllByTestId("notification-bell")).toHaveLength(1);
  });
});
