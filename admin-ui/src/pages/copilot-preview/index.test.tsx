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

// GID: 旧UI(AppSidebar)との共通シェルパリティ(通知ベル/AppSwitcher)の回帰テスト用。
// AppSidebar.test.tsx と同じくスタブ化する — NotificationBell は実APIポーリングを、
// AppSwitcher は useAdminAgentUI(AdminAgentUIProviderが必要)を持つため、ページ単体の
// テストでは実体を必要としない。ThemeToggle/LangSwitcher は Context にデフォルト値が
// あり Provider 無しで安全に描画できるため、実コンポーネントのまま検証する。
vi.mock("../../components/common/NotificationBell", () => ({
  NotificationBell: () => <div data-testid="notification-bell-stub" />,
}));

vi.mock("../../components/AppSwitcher", () => ({
  default: () => <div data-testid="app-switcher-stub" />,
}));

// 会話の永続化(sessionStorage)はストアをモックして検証する。既定は「保存済みの会話なし」
// なので、これ以前から存在するテストの挙動は永続化の導入前と完全に同じになる。
vi.mock("../../lib/chatSessionStore", async () => {
  const actual = await vi.importActual<typeof import("../../lib/chatSessionStore")>("../../lib/chatSessionStore");
  return {
    ...actual,
    restoreChatSession: vi.fn(() => null),
    saveChatSession: vi.fn(),
    clearChatSession: vi.fn(),
  };
});

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { authFetch } from "../../lib/api";
import {
  CHAT_SESSION_SURFACE_FULLSCREEN,
  restoreChatSession,
  saveChatSession,
} from "../../lib/chatSessionStore";

// 復元モックはテスト間で持ち越さない(既定は「保存済みの会話なし」)
beforeEach(() => {
  vi.mocked(restoreChatSession).mockReturnValue(null);
  vi.mocked(saveChatSession).mockReset();
});

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as Response);

// 左レールの件数バッジ用にマウント時に叩かれる2本(既存の /v1/admin/agent/chat の応答
// シーケンスに割り込まないよう、既存テストでは常に0件で素通りさせる)
const BADGE_URL_RE = /knowledge\/gaps\/count|chat-history\/escalations/;
const isBadgeUrl = (url: unknown) => BADGE_URL_RE.test(String(url));
const mockEmptyBadges = () => mockOk({ count: 0, escalations: [] });

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

// super_admin は my-tenant のオンボーディング判定をスキップして直接ブリーフィングへ進む。
// プレビュー未選択(previewMode=false)のsuper_adminはテナント選択画面になるため、
// チャット本体の挙動を検証するテストではクライアントビューに入った状態を使う。
const SUPER_ADMIN_IN_PREVIEW: Partial<ReturnType<typeof useAuth>> = {
  isSuperAdmin: true,
  isClientAdmin: false,
  previewMode: true,
  previewTenantId: "tenant-preview",
  previewTenantName: "Preview Tenant",
  user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
};

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
      if (isBadgeUrl(url)) return mockEmptyBadges();
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
    vi.mocked(authFetch).mockImplementation((url: string) =>
      isBadgeUrl(url) ? mockEmptyBadges() : mockOk({ reply: "今週も順調です", actions: [] }),
    );
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
    renderPage(SUPER_ADMIN_IN_PREVIEW);
    // bootstrap完了(送信ボタンのdisabled解除)を待ってから操作する。左レールの件数
    // バッジ取得(gaps/count・escalations)がbootstrapと並行して独立に走るため、
    // 呼び出し回数の厳密一致では待てない。
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    expect(getRail().className).not.toContain("cp-rail-open");
    expect(getBackdrop()).toBeNull();
  });

  it("ハンバーガーボタンでドロワーが開き、背景オーバーレイが表示される", async () => {
    renderPage(SUPER_ADMIN_IN_PREVIEW);
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));

    expect(getRail().className).toContain("cp-rail-open");
    expect(getBackdrop()).not.toBeNull();
  });

  it("オーバーレイをタップするとドロワーが閉じる", async () => {
    renderPage(SUPER_ADMIN_IN_PREVIEW);
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(getBackdrop()).not.toBeNull();

    fireEvent.click(getBackdrop()!);

    expect(getBackdrop()).toBeNull();
    expect(getRail().className).not.toContain("cp-rail-open");
  });

  it("レール内の閉じるボタン(✕)でもドロワーが閉じる", async () => {
    renderPage(SUPER_ADMIN_IN_PREVIEW);
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(getRail().className).toContain("cp-rail-open");

    fireEvent.click(screen.getByRole("button", { name: "メニューを閉じる" }));
    expect(getRail().className).not.toContain("cp-rail-open");
  });

  it("会話中でない状態でカテゴリーを選択するとドロワーが閉じる", async () => {
    renderPage(SUPER_ADMIN_IN_PREVIEW);
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
    renderPage(SUPER_ADMIN_IN_PREVIEW);
    // このモックは全fetch呼び出し(bootstrap本体+左レールのバッジ取得2件)を未解決のまま止める。
    // 呼び出し回数の厳密一致では待てないため、最低1回発火したことだけを確認する。
    await waitFor(() => expect(authFetch).toHaveBeenCalled());

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

// GID: 新UI(/copilot-preview)には旧UI(AppSidebar)の共通シェル機能が丸ごと落ちていた
// (App.tsx がAppSidebarより手前で早期returnするため)。ログアウト・モバイル対応に続き、
// 残る4機能(テーマ切替/言語切替/通知ベル/AppSwitcher)の回帰テスト。
describe("CopilotPreviewPage — 共通シェル機能パリティ(テーマ/言語/通知/AppSwitcher)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });
  });

  it("テーマ切替(ライト/ダーク/自動)が描画されている", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy());

    expect(screen.getByTitle("ライト")).toBeTruthy();
    expect(screen.getByTitle("ダーク")).toBeTruthy();
    expect(screen.getByTitle("自動")).toBeTruthy();
  });

  it("テーマ切替ボタンをクリックしてもエラーにならない(Provider無し=デフォルト値でも安全)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy());

    expect(() => fireEvent.click(screen.getByTitle("ダーク"))).not.toThrow();
  });

  it("言語切替(日本語/English)が描画されている", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy());

    expect(screen.getByRole("button", { name: /日本語/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /English/ })).toBeTruthy();
  });

  it("通知ベルが描画されている", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy());

    expect(screen.getByTestId("notification-bell-stub")).toBeTruthy();
  });

  it("AppSwitcher(R2C⇄R2C2)が描画されている", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy());

    expect(screen.getByTestId("app-switcher-stub")).toBeTruthy();
  });
});

// GID: 旧UIへの案内リンクは /admin/* という同一SPA内のパスのため、同じタブで開くと
// CopilotPreviewPage ごとアンマウントされて会話(msgs/sessionIdRef)が消えていた。
// 別タブで開くこと(と、その旨がユーザーに伝わること)の回帰テスト。
describe("CopilotPreviewPage — 旧UI案内リンクカード", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    // 起動時ブリーフィングも同じエンドポイントを叩くため、リンクカードは
    // ユーザーが送った2回目以降の応答にだけ載せる(カードが1枚だけであることを保証する)
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      agentCalls += 1;
      if (agentCalls === 1) return mockOk({ reply: "今週のまとめです。", actions: [] });
      return mockOk({
        reply: "請求管理画面をご案内しました。",
        actions: [
          {
            tool: "get_legacy_ui_link",
            result:
              "この操作は請求管理画面から行えます。\n画面: 請求管理\nURL: /admin/billing\n" +
              "説明: 請求書の再送・金額調整・無料期間設定・一時停止/再開はこちらの画面で行えます",
          },
        ],
      });
    });
  });

  it("リンクは別タブで開き、会話が残る旨の補足が添えられる", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(screen.getByPlaceholderText(/指示ルール/), { target: { value: "請求書を再送したい" } });
    fireEvent.click(screen.getByLabelText("送信"));

    const link = await screen.findByRole("link", { name: /請求管理を開く/ });
    expect(link.getAttribute("href")).toBe("/admin/billing");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("別タブで開きます。この会話はそのまま残ります。")).toBeTruthy();
  });
});

// GID: バックエンドの構造化カード(card)から直接リンクカードを描画する経路の回帰テスト。
// 自然文の言い回しが変わるとカードが黙って消える正規表現依存を外すための追加経路で、
// card を返すのは現状 get_legacy_ui_link のみ。card が無いツールは従来の正規表現
// フォールバックで描画され続ける(この2経路の共存をここで固定する)。
describe("CopilotPreviewPage — 構造化カード(card)からの描画", () => {
  function mockAgent(secondResponse: unknown) {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    // 起動時ブリーフィングも同じエンドポイントを叩くため、カードは2回目の応答にだけ載せる
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      agentCalls += 1;
      if (agentCalls === 1) return mockOk({ reply: "今週のまとめです。", actions: [] });
      return mockOk(secondResponse);
    });
  }

  async function send(text: string) {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByPlaceholderText(/指示ルール/), { target: { value: text } });
    fireEvent.click(screen.getByLabelText("送信"));
  }

  it("card があれば、自然文が3行フォーマットに一致しなくてもリンクカードを描画する", async () => {
    const description = "画像候補の選択・音声クローン・性格設定・ライブテストはこちらの画面で行えます";
    mockAgent({
      reply: "アバタースタジオをご案内しました。",
      actions: [
        {
          tool: "get_legacy_ui_link",
          // 正規表現(画面:/URL:/説明:)に一切一致しない自然文。従来のパース経路だけなら
          // カードにならず汎用表示に落ちるため、描画されたことが card 経由の証拠になる。
          result: "アバタースタジオでご対応いただけます。",
          card: { kind: "legacy_link", label: "アバタースタジオ", url: "/admin/avatar/studio", description },
        },
      ],
    });

    await send("アバターを設定したい");

    const link = await screen.findByRole("link", { name: /アバタースタジオを開く/ });
    expect(link.getAttribute("href")).toBe("/admin/avatar/studio");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // 説明文も card の構造化フィールドから来ている
    expect(screen.getByText(description)).toBeTruthy();
  });

  it("card が無い既存ツールは、従来どおり自然文の正規表現パースでリンクカードになる", async () => {
    const description = "会話内容の確認とその会話セッションの削除はこちらの画面で行えます";
    mockAgent({
      reply: "会話履歴画面をご案内しました。",
      actions: [
        {
          tool: "get_legacy_ui_link",
          result: `この操作は会話履歴画面から行えます。\n画面: 会話履歴\nURL: /admin/chat-history\n説明: ${description}`,
        },
      ],
    });

    await send("会話を削除したい");

    const link = await screen.findByRole("link", { name: /会話履歴を開く/ });
    expect(link.getAttribute("href")).toBe("/admin/chat-history");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText(description)).toBeTruthy();
  });
});

function getComposer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/指示ルール/) as HTMLTextAreaElement;
}

// 想定ユーザーは100%日本語入力の店主。かな漢字変換の確定Enterで未変換のまま
// 送信されてしまう不具合の回帰テスト(判定条件自体は lib/utils.test.ts で検証済み)。
describe("CopilotPreviewPage — コンポーザのIME/改行", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });
    // タイプライター演出を無効化して応答を同期的に確定させる
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

  it("IME変換中(compositionStart後)のEnterでは送信しない", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    const composer = getComposer();
    fireEvent.compositionStart(composer);
    fireEvent.change(composer, { target: { value: "そうりょう" } });

    const callsBefore = vi.mocked(authFetch).mock.calls.length;
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(vi.mocked(authFetch).mock.calls.length).toBe(callsBefore);
    expect(composer.value).toBe("そうりょう");
  });

  it("変換確定後(compositionEnd後)のEnterでは送信する", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    const composer = getComposer();
    fireEvent.compositionStart(composer);
    fireEvent.change(composer, { target: { value: "送料を教えて" } });
    fireEvent.compositionEnd(composer);
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("送料を教えて")).toBeTruthy());
    expect(getComposer().value).toBe("");
  });

  it("Shift+Enterでは送信しない(改行のため)", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    const composer = getComposer();
    fireEvent.change(composer, { target: { value: "1行目" } });

    const callsBefore = vi.mocked(authFetch).mock.calls.length;
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });

    expect(vi.mocked(authFetch).mock.calls.length).toBe(callsBefore);
    expect(composer.value).toBe("1行目");
  });
});

// GID 1217007364341838: 下書き提案のチップ(保存して/やめておく)を押さずに別の話題を
// 打った場合、未使用のチップが宙ぶらりんで残り、新しい応答の隣に古い選択肢が並んでいた。
// 入力欄は塞がない(=チップを無視して打てる)まま、送信時にチップを使用済みにする。
describe("CopilotPreviewPage — 保留中の下書きチップを無視して送信", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      agentCalls += 1;
      if (agentCalls === 1) return mockOk({ reply: "今週も順調です。", actions: [] });
      if (agentCalls === 2) {
        return mockOk({
          reply: "こんな内容でどうでしょう？",
          actions: [{ tool: "suggest_faq", result: "質問: 送料はいくら？\n回答: 全国一律550円です。\n分類: 配送" }],
        });
      }
      return mockOk({ reply: "承知しました。", actions: [] });
    });
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

  it("チップを押さず自由入力を送ると、チップは使用済みになり新しいメッセージが送信される", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(getComposer(), { target: { value: "送料のFAQを作って" } });
    fireEvent.click(screen.getByLabelText("送信"));

    await waitFor(() => expect(screen.getByRole("button", { name: "保存して" })).toBeTruthy());
    // チップ待ちでも入力欄は塞がない(「やっぱりいいです」と打てる)
    expect(getComposer().disabled).toBe(false);

    fireEvent.change(getComposer(), { target: { value: "やっぱりやめて、営業時間を教えて" } });
    fireEvent.click(screen.getByLabelText("送信"));

    await waitFor(() => expect(screen.getByText("やっぱりやめて、営業時間を教えて")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "保存して" })).toBeNull();
    expect(screen.queryByRole("button", { name: "やめておく" })).toBeNull();
  });
});

// GID 1217007275511487: 左レールが「今どれだけ溜まっているか」を一切示しておらず、
// 旧ダッシュボードのstatカード無しでは対応漏れに気づけなかった。既存エンドポイント
// (knowledge/gaps/count・chat-history/escalations)の件数をバッジで出す。
// 0件・取得失敗時はバッジを出さない(店主に「0」やエラーを読ませない)。
describe("CopilotPreviewPage — 左レールの件数バッジ", () => {
  // バッジ用件数の応答だけを差し替え、それ以外(オンボーディング判定・エージェント応答)は共通
  function mockBadges(opts: { gaps?: unknown; escalations?: unknown; reject?: boolean }) {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (isBadgeUrl(u)) {
        if (opts.reject) return Promise.reject(new Error("network down"));
        if (u.includes("gaps/count")) return mockOk(opts.gaps ?? { count: 0 });
        return mockOk(opts.escalations ?? { escalations: [] });
      }
      if (u.includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });
  }

  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
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

  it("未回答質問・対応中の会話が1件以上あればカテゴリーに件数バッジが出る", async () => {
    mockBadges({
      gaps: { count: 3 },
      escalations: { escalations: [{ id: "e1" }, { id: "e2" }] },
    });
    renderPage();

    expect(await screen.findByLabelText("未回答質問 3件")).toBeTruthy();
    expect(screen.getByLabelText("対応中の会話 2件")).toBeTruthy();
    // バッジはカテゴリーボタンの中に出る(独立した要素ではない)
    expect(screen.getByRole("button", { name: /知識データ/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /会話の履歴/ }).textContent).toContain("2");
  });

  it("テナントのIDでスコープした既存エンドポイントを叩く(新規APIを作らない)", async () => {
    mockBadges({ gaps: { count: 1 }, escalations: { escalations: [] } });
    renderPage();

    await screen.findByLabelText("未回答質問 1件");
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://localhost:3100/v1/admin/knowledge/gaps/count?tenant=tenant-a");
    expect(urls).toContain("http://localhost:3100/v1/admin/chat-history/escalations?tenant=tenant-a");
  });

  it("previewMode中はプレビュー対象テナントの件数を取得する", async () => {
    mockBadges({ gaps: { count: 5 }, escalations: { escalations: [] } });
    renderPage({
      previewMode: true,
      previewTenantId: "tenant-preview",
      previewTenantName: "Preview Tenant",
      isSuperAdmin: true,
    });

    await screen.findByLabelText("未回答質問 5件");
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://localhost:3100/v1/admin/knowledge/gaps/count?tenant=tenant-preview");
  });

  it("0件のカテゴリーにはバッジを出さない", async () => {
    mockBadges({ gaps: { count: 0 }, escalations: { escalations: [] } });
    renderPage();

    // バッジ取得の完了を待つため、件数のある側(ここでは無い)ではなくボタン自体の描画を待つ
    await waitFor(() => expect(screen.getByRole("button", { name: /知識データ/ })).toBeTruthy());
    await waitFor(() =>
      expect(vi.mocked(authFetch).mock.calls.some((c) => String(c[0]).includes("gaps/count"))).toBe(true),
    );

    expect(screen.queryByLabelText(/未回答質問 /)).toBeNull();
    expect(screen.queryByLabelText(/対応中の会話 /)).toBeNull();
    expect(screen.getByRole("button", { name: /知識データ/ }).textContent).not.toContain("0");
  });

  it("件数の取得に失敗してもエラーを出さず、チャットはそのまま使える", async () => {
    mockBadges({ reject: true });
    renderPage();

    // チャットは通常どおり起動し、送信もできる
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(getComposer(), { target: { value: "送料を教えて" } });
    fireEvent.click(screen.getByLabelText("送信"));
    await waitFor(() => expect(screen.getByText("送料を教えて")).toBeTruthy());

    // バッジは出ず、技術的なエラー文言も一切出さない
    expect(screen.queryByLabelText(/未回答質問 /)).toBeNull();
    expect(screen.queryByLabelText(/対応中の会話 /)).toBeNull();
    expect(screen.queryByText(/network down/)).toBeNull();
    expect(screen.queryByText(/失敗/)).toBeNull();
  });

  it("テナントを特定できないsuper_admin(preview外)では件数を取得しない(全テナント合計を出さない)", async () => {
    // previewMode未選択のsuper_adminはテナント選択画面に入るため(別PRで追加)、
    // 通常のチャット/左レール自体がまだマウントされない。そのためバッジ用エンドポイントは
    // 一切呼ばれない — 「全テナント合計」を誤って出す経路が無いことがここでの確認点。
    mockBadges({ gaps: { count: 7 }, escalations: { escalations: [{ id: "e1" }] } });
    renderPage({
      isSuperAdmin: true,
      isClientAdmin: false,
      user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: /どのお客様として見ますか/ })).toBeTruthy());
    expect(screen.queryByLabelText("送信")).toBeNull();
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some(isBadgeUrl)).toBe(false);
    expect(screen.queryByLabelText(/未回答質問 /)).toBeNull();
  });
});

// GID 1217007298292152: 会話がReactのuseStateだけに載っていたため、リロード・ブラウザバック・
// モバイルのタブ破棄で会話が丸ごと消えていた。同一タブのsessionStorageから復元し、
// 復元できた場合は起動時ブートストラップ(週次ブリーフィング/オンボーディング)を行わない。
describe("CopilotPreviewPage — 会話の復元(sessionStorage)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "今週も順調です。", actions: [] });
    });
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

  it("保存済みの会話があれば復元し、起動時ブリーフィングは取得しない", async () => {
    vi.mocked(restoreChatSession).mockReturnValue({
      sessionId: "restored-session-id",
      messages: [
        { id: 201, role: "me", text: "送料を教えて" },
        { id: 202, role: "ai", text: "全国一律550円です。" },
      ],
      history: [
        { role: "user", content: "送料を教えて" },
        { role: "assistant", content: "全国一律550円です。" },
      ],
    });

    renderPage();

    expect(await screen.findByText("全国一律550円です。")).toBeTruthy();
    expect(screen.getByText("送料を教えて")).toBeTruthy();
    // ブリーフィング取得(agent/chat)もオンボーディング判定(my-tenant)も走らない。
    // 左レールの件数バッジ取得(gaps/count・escalations)は復元の有無と無関係に独立して
    // 走るため許容する — ここで見るのはブリーフィング固有のエンドポイントのみ。
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v1/admin/agent/chat"))).toBe(false);
    expect(urls.some((u) => u.includes("/v1/admin/my-tenant"))).toBe(false);
  });

  it("保存済みの会話が無ければ、従来通り起動時ブリーフィングを取得する(回帰)", async () => {
    renderPage();

    await waitFor(() =>
      expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).includes("/v1/admin/agent/chat"))).toBe(true),
    );
    expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).includes("/v1/admin/my-tenant"))).toBe(true);
    expect(await screen.findByText("今週も順調です。")).toBeTruthy();
  });

  it("会話が更新されると、その面のキーで保存される", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(getComposer(), { target: { value: "営業時間を教えて" } });
    fireEvent.click(screen.getByLabelText("送信"));

    await waitFor(() => expect(saveChatSession).toHaveBeenCalled());
    const [surface, session] = vi.mocked(saveChatSession).mock.calls.at(-1)!;
    expect(surface).toBe(CHAT_SESSION_SURFACE_FULLSCREEN);
    expect(session.sessionId).toBeTruthy();
    expect(JSON.stringify(session.messages)).toContain("営業時間を教えて");
    // 直近履歴ウィンドウも一緒に保存される(先頭2件は起動時ブリーフィングの分)
    expect(session.history?.slice(-2)).toEqual([
      { role: "user", content: "営業時間を教えて" },
      { role: "assistant", content: "今週も順調です。" },
    ]);
  });
});

// GID 1217007275510096: プレビュー未選択のsuper_adminは、ほぼ全てのツールが
// 「テナントが特定できません」を返して会話が行き止まりになっていた。チャットを
// 始める前にテナントを選ばせ、既存のクライアントビュー(enterPreview)へ入れる。
describe("CopilotPreviewPage — super_adminのテナント選択", () => {
  const TENANTS = [
    { id: "tenant-a", name: "あおぞら商店" },
    { id: "tenant-b", name: "みどり工房" },
  ];

  const SUPER_ADMIN_NO_PREVIEW: Partial<ReturnType<typeof useAuth>> = {
    isSuperAdmin: true,
    isClientAdmin: false,
    previewMode: false,
    user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
  };

  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).includes("/v1/admin/tenants")) return mockOk({ tenants: TENANTS, total: TENANTS.length });
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });
  });

  it("previewMode未選択のsuper_adminにはテナント選択が出て、チャット(ブリーフィング)は始まらない", async () => {
    renderPage(SUPER_ADMIN_NO_PREVIEW);

    await waitFor(() => expect(screen.getByRole("button", { name: /あおぞら商店/ })).toBeTruthy());
    expect(screen.getByRole("heading", { name: /どのお客様として見ますか/ })).toBeTruthy();
    // チャット本体(コンポーザ)はまだ出さない
    expect(screen.queryByLabelText("送信")).toBeNull();
    // 一覧取得のみ。エージェントAPI(ブリーフィング)は叩かない
    expect(vi.mocked(authFetch).mock.calls.every(([url]) => String(url).includes("/v1/admin/tenants"))).toBe(true);
  });

  it("テナントを選ぶと enterPreview(テナントID, テナント名) が呼ばれる", async () => {
    const enterPreview = vi.fn();
    renderPage({ ...SUPER_ADMIN_NO_PREVIEW, enterPreview });

    const button = await waitFor(() => screen.getByRole("button", { name: /みどり工房/ }));
    fireEvent.click(button);

    expect(enterPreview).toHaveBeenCalledWith("tenant-b", "みどり工房");
  });

  it("previewMode中のsuper_adminはテナント選択を挟まず通常のチャットになる", async () => {
    renderPage(SUPER_ADMIN_IN_PREVIEW);

    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("heading", { name: /どのお客様として見ますか/ })).toBeNull();
    expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).includes("/v1/admin/tenants"))).toBe(false);
  });

  it("client_adminにはテナント選択が出ず、常に通常のチャットになる", async () => {
    renderPage();

    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("heading", { name: /どのお客様として見ますか/ })).toBeNull();
    expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).includes("/v1/admin/tenants"))).toBe(false);
  });

  it("テナント一覧が取得できない場合は再読み込みを促す(白画面にしない)", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).includes("/v1/admin/tenants")) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });
    renderPage(SUPER_ADMIN_NO_PREVIEW);

    await waitFor(() => expect(screen.getByText(/テナント一覧を取得できませんでした/)).toBeTruthy());
  });
});
