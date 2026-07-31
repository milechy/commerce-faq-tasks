// GID: 新UI(/copilot-preview)にログアウト手段が無く、Phase4トグルでこの画面を
// 既定にすると詰む不具合の回帰テスト。左レール下部のログアウトボタンが
// logout() → navigate("/login") を実行することを検証する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// スタブだが onSeedQuery は実体と同じ引数で呼ぶ(この画面がロックタブの質問を
// 自分のチャットへ流せているかを検証するため)。質問文自体の固定は AppSwitcher.test.tsx 側。
vi.mock("../../components/AppSwitcher", () => ({
  default: ({ onSeedQuery }: { onSeedQuery?: (query: string) => void }) => (
    <button data-testid="app-switcher-stub" onClick={() => onSeedQuery?.("R2C2について教えて")}>
      R2C2
    </button>
  ),
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

// PDF取り込みは multipart のため authFetch(常にJSONヘッダを付ける)ではなくXHRで送る。
// トークン取得だけを差し替え、supabaseクライアントの実体はテストに持ち込まない。
vi.mock("../../components/knowledge/shared", () => ({
  getAccessToken: vi.fn(() => Promise.resolve("test-token")),
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

// 相談窓口(担当者からの未読返信)もマウント時に叩かれる。バッジ2本と同じ理由で、
// /v1/admin/agent/chat の応答シーケンスを数えているテストでは0件で素通りさせる。
const isUnreadFeedbackUrl = (url: unknown) => String(url).includes("/v1/admin/feedback?");
const mockNoFeedbackReplies = () => mockOk({ items: [] });

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

// Asana 1217040568430944(P7)以降、previewMode中のsuper_adminも
// /v1/admin/tenants/:id 経由でオンボーディング判定を行う(my-tenantは使わない。
// my-tenantはJWTのtenant_idを見るため、super_adminのJWTには使えない)。
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
    vi.mocked(authFetch).mockImplementation((url: string) => {
      // Asana 1217040568430944(P7)以降、bootstrapは実際のチャットfetchの前に
      // オンボーディング判定(/v1/admin/tenants/:id)を1回awaitする。これは即座に
      // 解決させ、このテストが検証したい「実際のチャット送信中(busy)」の再現を
      // 妨げないようにする(このURLだけ他と挙動を分ける)。
      if (String(url).includes("/v1/admin/tenants/")) {
        return mockOk({ onboarding_stage: null });
      }
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    renderPage(SUPER_ADMIN_IN_PREVIEW);
    // このモックは実チャットのfetch呼び出し(bootstrap本体+左レールのバッジ取得2件)を
    // 未解決のまま止める。呼び出し回数の厳密一致では待てないため、最低1回発火した
    // ことだけを確認する。
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

  // GID: この画面には旧UIのチャットパネル(Surface A)が無く、AppSwitcherのロックタブは
  // openWithQuery(誰も見ていないContext)を叩くだけで無反応だった。
  it("AppSwitcherのロックタブ(R2C2)の質問が、この画面自身のチャットに送られる", async () => {
    renderPage();
    // 起動時ブリーフィングの完了を待つ(sending中は sendReal が無視されるため)
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("app-switcher-stub"));

    // 自分が送った質問として会話に積まれ、実APIにも送られている
    expect(await screen.findByText("R2C2について教えて")).toBeTruthy();
    await waitFor(() => {
      const chatCall = vi
        .mocked(authFetch)
        .mock.calls.find(
          ([url, init]) =>
            String(url).includes("/v1/admin/agent/chat") &&
            String((init as RequestInit | undefined)?.body).includes("R2C2について教えて"),
        );
      expect(chatCall).toBeTruthy();
    });
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
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
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
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
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

  it("weekly_summary カードの数値をそのまま描画し、未回答質問・承認待ちルールがあれば行動チップを出す", async () => {
    mockAgent({
      reply: "今週も好調です。",
      actions: [
        {
          tool: "get_weekly_briefing",
          result: "今週(月曜起点)の状況:\n会話数 142件",
          card: {
            kind: "weekly_summary",
            asOf: "2026-08-05T03:00:00.000Z",
            sessions: { total: 142, changePct: 18, prevTotal: 120 },
            avgScore: 82,
            conversions: { count: 8, total: 96000 },
            faq: { total: 45, published: 40, lastUpdated: "2026-08-01T00:00:00.000Z" },
            pendingTuningRules: 3,
            gaps: { total: 11, top: [{ id: 1, question: "送料はいくらですか？" }] },
          },
        },
      ],
    });

    await send("今週の状況を教えて");

    expect(await screen.findByText("142件")).toBeTruthy();
    expect(screen.getByText(/先週同時点比 \+18%/)).toBeTruthy();
    expect(screen.getByText("82/100")).toBeTruthy();
    expect(screen.getByText("8件・¥96,000")).toBeTruthy();
    expect(screen.getByText("承認待ちの指示ルール")).toBeTruthy();
    expect(screen.getByText("「送料はいくらですか？」")).toBeTruthy();

    // チップはサーバ集計値(card)から決定的に導く。LLMの文には付けられない
    await waitFor(() => expect(screen.getByRole("button", { name: "FAQにする" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "確認する" })).toBeTruthy();
  });

  it("未回答質問・承認待ちルールが0件なら行動チップを出さない", async () => {
    mockAgent({
      reply: "順調です。",
      actions: [
        {
          tool: "get_weekly_briefing",
          result: "今週(月曜起点)の状況:\n会話数 30件",
          card: {
            kind: "weekly_summary",
            asOf: "2026-08-05T03:00:00.000Z",
            sessions: { total: 30, changePct: null, prevTotal: 0 },
            avgScore: null,
            conversions: { count: 2, total: 10000 },
            faq: { total: 10, published: 10, lastUpdated: null },
            pendingTuningRules: 0,
            gaps: { total: 0, top: [] },
          },
        },
      ],
    });

    await send("今週の状況を教えて");

    await screen.findByText("30件");
    expect(screen.queryByRole("button", { name: "FAQにする" })).toBeNull();
    expect(screen.queryByRole("button", { name: "確認する" })).toBeNull();
  });

  // GID 1217040318322843: 会話復元(sessionStorage)で古いまとめがそのまま画面に残り、
  // いつ時点のデータか分からないまま今日の数字として読まれてしまう問題の回帰テスト。
  it("集計時点(asOf)が今日なら鮮度の注記を出さない", async () => {
    mockAgent({
      reply: "今週も好調です。",
      actions: [
        {
          tool: "get_weekly_briefing",
          result: "今週(月曜起点)の状況:\n会話数 50件",
          card: {
            kind: "weekly_summary",
            asOf: new Date().toISOString(),
            sessions: { total: 50, changePct: null, prevTotal: 0 },
            avgScore: null,
            conversions: null,
            faq: null,
            pendingTuningRules: null,
            gaps: null,
          },
        },
      ],
    });

    await send("今週の状況を教えて");

    await screen.findByText("50件");
    expect(screen.getByText(/集計時点/)).toBeTruthy();
    expect(screen.queryByText(/別の日に取得した内容です/)).toBeNull();
  });

  it("集計時点(asOf)が別の日(会話復元など)なら古い内容だと分かる注記を出す", async () => {
    mockAgent({
      reply: "先日の状況です。",
      actions: [
        {
          tool: "get_weekly_briefing",
          result: "今週(月曜起点)の状況:\n会話数 50件",
          card: {
            kind: "weekly_summary",
            asOf: "2020-01-01T00:00:00.000Z",
            sessions: { total: 50, changePct: null, prevTotal: 0 },
            avgScore: null,
            conversions: null,
            faq: null,
            pendingTuningRules: null,
            gaps: null,
          },
        },
      ],
    });

    await send("今週の状況を教えて");

    await screen.findByText("50件");
    expect(await screen.findByText(/別の日に取得した内容です/)).toBeTruthy();
  });

  // REAL_TOOL_LABEL への登録を忘れると、画面に生の英語ツール名がそのまま出る
  // (パネル側のラベル表が9件で取り残されたのと同型の事故)。新ツール追加時の回帰。
  it("アバターの一覧・停止ツールは生の英語名ではなく日本語ラベルで表示される", async () => {
    mockAgent({
      reply: "アバターの状況をお伝えしました。",
      actions: [
        { tool: "get_avatar_list", result: "アバター設定は1件あります:\n- 接客担当（稼働中） ID: av-1" },
        { tool: "deactivate_avatar", result: "アバター「接客担当」を停止しました。" },
      ],
    });

    await send("アバターの一覧を見せて");

    expect(await screen.findByText("アバター一覧の取得")).toBeTruthy();
    expect(screen.getByText("アバターの停止")).toBeTruthy();
    expect(screen.queryByText("get_avatar_list")).toBeNull();
    expect(screen.queryByText("deactivate_avatar")).toBeNull();
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
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
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

  it("保存済みの会話があれば復元し、起動時ブリーフィング(agent/chat)は取得しない", async () => {
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
    // ブリーフィング取得(agent/chat)は走らない(復元済みの会話に割り込ませないため)。
    // 一方 my-tenant は Asana 1217040702485762(P5)以降、復元時にも「次の一手」判定のために
    // 呼ばれる(下の別テストで検証)。左レールの件数バッジ取得は復元の有無と無関係に独立して走る。
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v1/admin/agent/chat"))).toBe(false);
  });

  // Asana 1217040702485762(P5): 復元時でもオンボーディング未完了なら「次の一手」を提示する
  // (旧実装は復元時にブートストラップを丸ごとスキップし、次にすべきことが消えていた)。
  it("復元時、オンボーディングが未完了なら次の一手が追加で提示される", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({
          onboarding_stage: {
            industryAnswered: true,
            knowledgePublished: false,
            widgetInstalled: false,
            firstConversation: false,
          },
        });
      }
      return mockOk({ reply: "今週も順調です。", actions: [] });
    });
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
    expect(await screen.findByText(/下書きとして登録済み/)).toBeTruthy();
    expect(screen.getByText("下書きを見る")).toBeTruthy();
  });

  it("復元時、オンボーディングが全段階完了済みなら次の一手は表示されない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({
          onboarding_stage: {
            industryAnswered: true,
            knowledgePublished: true,
            widgetInstalled: true,
            firstConversation: true,
          },
        });
      }
      return mockOk({ reply: "今週も順調です。", actions: [] });
    });
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
    expect(screen.queryByText("下書きを見る")).toBeNull();
    expect(screen.queryByText("埋め込みコードを見る")).toBeNull();
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

// GID 1217008695995707: サーバは全メトリクスの surface ラベルにこの値をそのまま載せる
// (docs/AGENT_METRICS.md)。この面が名乗り損ねると、全画面UI由来のターンが 'unknown' に
// 混ざり、docs/CHAT_SURFACE_DECISION.md の「全画面UIが主たる面になりつつあるのか」に
// 数字で答えられなくなる。
describe("CopilotPreviewPage — リクエストボディの surface", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      return mockOk({ reply: "今週も順調です。", actions: [] });
    });
  });

  it("起動時ブリーフィングも手動送信も surface: fullscreen で送る", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(getComposer(), { target: { value: "営業時間を教えて" } });
    fireEvent.click(screen.getByLabelText("送信"));

    await waitFor(() => expect(screen.getByText("営業時間を教えて")).toBeTruthy());

    const chatBodies = vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

    // ブリーフィングと手動送信の2本。どちらも同じ transport 経由なので同じ値を名乗る
    expect(chatBodies.length).toBeGreaterThanOrEqual(2);
    expect(chatBodies.map((b) => b.surface)).toEqual(chatBodies.map(() => "fullscreen"));
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
    // テナント一覧(選択画面用)は叩かない。個別テナント取得(オンボーディング判定、下のテストで検証)は叩く。
    expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).endsWith("/v1/admin/tenants"))).toBe(false);
  });

  // Asana 1217040568430944(P7)
  it("previewMode中のsuper_adminはmy-tenantではなく/v1/admin/tenants/:idでオンボーディング判定する", async () => {
    renderPage(SUPER_ADMIN_IN_PREVIEW);

    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v1/admin/tenants/tenant-preview"))).toBe(true);
    expect(urls.some((u) => u.includes("/v1/admin/my-tenant"))).toBe(false);
  });

  it("previewMode中、テナントがオンボーディング未完了なら次の一手が提示される(代行導線)", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).includes("/v1/admin/tenants/tenant-preview")) {
        return mockOk({
          onboarding_stage: {
            industryAnswered: false,
            knowledgePublished: false,
            widgetInstalled: false,
            firstConversation: false,
          },
        });
      }
      return mockOk({ reply: "了解しました。", actions: [] });
    });

    renderPage(SUPER_ADMIN_IN_PREVIEW);

    expect(await screen.findByText(/どんな業種ですか/)).toBeTruthy();
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

// GID 1217007387443283: GUI固有として旧UIへ丸投げしていたPDF取り込みを、会話の中の
// カードとして完結させる最初の1件。受付条件(拡張子/MIME/サイズ)は旧UIのPDFタブと
// lib/bookPdfUpload.ts を共有しているため、ここで見るのは「会話UIとして成立しているか」
// (通信前に断れているか・失敗してもチャットが死なないか・成功が他の書き込み操作と
// 同じ形で伝わるか)に絞る。
type XhrListener = (...args: unknown[]) => void;

class MockXHR {
  static instances: MockXHR[] = [];
  uploadListeners: Record<string, XhrListener[]> = {};
  upload = {
    addEventListener: (event: string, cb: XhrListener) => {
      (this.uploadListeners[event] ??= []).push(cb);
    },
  };
  listeners: Record<string, XhrListener[]> = {};
  status = 0;
  responseText = "";
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();

  constructor() {
    MockXHR.instances.push(this);
  }

  addEventListener(event: string, cb: XhrListener) {
    (this.listeners[event] ??= []).push(cb);
  }

  fireProgress(loaded: number, total: number) {
    for (const cb of this.uploadListeners["progress"] ?? []) {
      cb({ lengthComputable: true, loaded, total });
    }
  }

  fireLoad(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    for (const cb of this.listeners["load"] ?? []) cb();
  }

  fireError() {
    for (const cb of this.listeners["error"] ?? []) cb();
  }
}

function makeFile(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** コンポーザ(textareaと送信ボタンを含む枠)がドロップの受け皿 */
function getComposerDropZone(): HTMLElement {
  return getComposer().parentElement as HTMLElement;
}

function dropFiles(files: File[]) {
  fireEvent.drop(getComposerDropZone(), {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

describe("CopilotPreviewPage — コンポーザへのPDFドラッグ＆ドロップ", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function readyPage(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
    renderPage(overrides);
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
  }

  it("PDFを落とすと旧UIと同じ既存エンドポイントへ送信が始まる(新APIを作らない)", async () => {
    await readyPage();

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    const xhr = MockXHR.instances[0]!;
    expect(xhr.open).toHaveBeenCalledWith("POST", "http://localhost:3100/v1/admin/knowledge/book-pdf");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer test-token");
    // 会話の中に進捗カードが出る
    expect(await screen.findByText("PDFを受け取っています")).toBeTruthy();
    expect(screen.getByText("料金表.pdf")).toBeTruthy();

    xhr.fireProgress(40, 100);
    expect(await screen.findByText("40%")).toBeTruthy();
  });

  it("previewMode中のsuper_adminはプレビュー対象テナント宛に送信する", async () => {
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

    dropFiles([makeFile("manual.pdf", "application/pdf")]);

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    expect(MockXHR.instances[0]!.open).toHaveBeenCalledWith(
      "POST",
      "http://localhost:3100/v1/admin/knowledge/book-pdf?tenant=tenant-preview",
    );
  });

  it("PDF以外を落とすと、通信せずやわらかい日本語で断る", async () => {
    await readyPage();

    dropFiles([makeFile("メモ.txt", "text/plain")]);

    expect(await screen.findByText("PDFを受け取れませんでした")).toBeTruthy();
    expect(screen.getByText("PDFファイル（またはPDFをまとめたZIPファイル）を送ってください。")).toBeTruthy();
    expect(MockXHR.instances.length).toBe(0);
  });

  it("上限を超えるPDFは通信する前に断る", async () => {
    await readyPage();

    dropFiles([makeFile("大きい資料.pdf", "application/pdf", 11 * 1024 * 1024)]);

    expect(await screen.findByText("PDFは1ファイル10MBまでです。分割してから送ってみてください。")).toBeTruthy();
    expect(MockXHR.instances.length).toBe(0);
  });

  it("通信に失敗してもチャットは壊れず、そのまま次のメッセージを送れる", async () => {
    await readyPage();

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0]!.fireError();

    expect(
      await screen.findByText("うまく送れませんでした。通信の状態を確かめて、もう一度お試しください。"),
    ).toBeTruthy();
    // 技術的な文言(ステータスコード等)は出さない
    expect(screen.queryByText(/413|MIME|status/i)).toBeNull();

    fireEvent.change(getComposer(), { target: { value: "営業時間を教えて" } });
    fireEvent.click(screen.getByLabelText("送信"));
    expect(await screen.findByText("営業時間を教えて")).toBeTruthy();
  });

  it("サーバー側で失敗した場合もやわらかい案内カードになる", async () => {
    await readyPage();

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0]!.fireLoad(401, { error: "unauthorized" });

    expect(
      await screen.findByText("ログインの有効期限が切れたようです。もう一度ログインしてからお試しください。"),
    ).toBeTruthy();
    expect(screen.queryByText(/unauthorized/)).toBeNull();
  });

  it("成功すると成功カードが出て、他の書き込み操作と同じく実操作の件数に加算される", async () => {
    await readyPage();
    expect(screen.getByLabelText("実際の操作 0件")).toBeTruthy();

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0]!.fireLoad(201, { id: 42, title: "料金表", status: "uploaded" });

    expect(await screen.findByText("PDFを受け取りました")).toBeTruthy();
    expect(
      screen.getByText("読み込みが終わると、この資料の内容から答えられるようになります。"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("実際の操作 1件")).toBeTruthy());
  });

  it("📎ボタンからでも同じ取り込みができる(ドラッグできない環境向け)", async () => {
    await readyPage();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(screen.getByLabelText("PDFを添付")).toBeTruthy();
    fireEvent.change(input, { target: { files: [makeFile("料金表.pdf", "application/pdf")] } });

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    expect(await screen.findByText("PDFを受け取っています")).toBeTruthy();
  });
});

// 「これを既定の画面にする」トグルの計測(chat_first_toggle)。トグルの実体は localStorage
// のままで、この通信は測るだけの副回線 — 成否がトグルの見た目・保存値に影響してはならない。
describe("CopilotPreviewPage — 既定画面トグルの計測(chat_first_toggle)", () => {
  const UI_EVENT_URL = "http://localhost:3100/v1/admin/agent/ui-event";

  const uiEventCalls = () =>
    vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/ui-event"));

  const sentEvents = () => uiEventCalls().map(([, options]) => JSON.parse(String(options?.body)));

  /** トグルのつまみの位置。ON=19px / OFF=3px（見た目の状態そのもの） */
  const knobLeft = (button: HTMLElement) => (button.querySelector("span > span") as HTMLElement).style.left;

  const getToggle = () =>
    waitFor(() => screen.getByRole("button", { name: /これを既定の画面にする/ }));

  // この環境(happy-dom)は window.localStorage を提供しないため、chatFirstDefault.test.ts と
  // 同じくMapベースの最小実装で補う(トグルの保存値まで検証するため素通りモックにはしない)。
  function installFakeLocalStorage() {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
      },
    });
  }

  beforeEach(() => {
    installFakeLocalStorage();
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (String(url).includes("/v1/admin/agent/ui-event")) return mockOk({ ok: true });
      return mockOk({ reply: "了解しました。", actions: [] });
    });
  });

  it("ONにすると enabled:true で ui-event が送られる", async () => {
    renderPage();
    const toggle = await getToggle();
    expect(knobLeft(toggle)).toBe("3px");

    fireEvent.click(toggle);

    await waitFor(() => expect(uiEventCalls().length).toBe(1));
    expect(uiEventCalls()[0][1]).toMatchObject({ method: "POST" });
    expect(uiEventCalls()[0][0]).toBe(UI_EVENT_URL);
    expect(sentEvents()).toEqual([{ event: "chat_first_toggle", enabled: true }]);
    expect(knobLeft(toggle)).toBe("19px");
    expect(window.localStorage.getItem("r2c_chat_first_default")).toBe("true");
  });

  it("OFFに戻すと enabled:false で ui-event が送られる", async () => {
    window.localStorage.setItem("r2c_chat_first_default", "true");
    renderPage();
    const toggle = await getToggle();
    expect(knobLeft(toggle)).toBe("19px");

    fireEvent.click(toggle);

    await waitFor(() => expect(uiEventCalls().length).toBe(1));
    expect(sentEvents()).toEqual([{ event: "chat_first_toggle", enabled: false }]);
    expect(knobLeft(toggle)).toBe("3px");
    expect(window.localStorage.getItem("r2c_chat_first_default")).toBeNull();
  });

  it("送信が失敗してもトグルはONになったまま(巻き戻さない・エラーも出さない)", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (String(url).includes("/v1/admin/agent/ui-event")) return Promise.reject(new Error("network down"));
      return mockOk({ reply: "了解しました。", actions: [] });
    });

    renderPage();
    const toggle = await getToggle();

    fireEvent.click(toggle);

    await waitFor(() => expect(uiEventCalls().length).toBe(1));
    expect(knobLeft(toggle)).toBe("19px");
    expect(window.localStorage.getItem("r2c_chat_first_default")).toBe("true");
    expect(screen.queryByText(/エラー/)).toBeNull();
    expect(screen.queryByText(/うまく送信できませんでした/)).toBeNull();
  });

  it("トグルを触らなければ ui-event は送られない", async () => {
    renderPage();
    await getToggle();

    expect(uiEventCalls()).toEqual([]);
  });
});

// GID 1217008702879233: パネル(Surface A)にしか無かった2機能を全画面UIへ移植する。
// 1件目 = 相談窓口ループ(担当者からのお返事 → 解決しました/まだ解決しません)。
// ロジックは lib/feedbackReplies.ts をパネルと共有しているため、ここで確かめるのは
// 「この画面がそのフックに繋がっており、同じAPIを同じ手順で叩くか」。
// 対になるパネル側の回帰テストは components/AdminAgent/AdminAgentPanel.test.tsx。
const REPLY = {
  id: "fb-1",
  message: "送料の設定はどこから変えますか",
  reply_body: "設定ページから変更できます",
  replied_at: "2026-07-28T01:00:00Z",
};

describe("CopilotPreviewPage — 相談窓口(担当者からのお返事)", () => {
  function mockFeedback(items: unknown[]) {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockOk({ items });
      return mockOk({ reply: "了解しました。", actions: [] });
    });
  }

  it("未読のお返事があると、全画面チャットにもお返事が出る", async () => {
    mockFeedback([REPLY]);
    renderPage();

    expect(await screen.findByText("担当者からお返事が届きました")).toBeTruthy();
    // どの相談への返事かは日時と同じ1行に収めているため、部分一致で確かめる
    expect(screen.getByText(/送料の設定はどこから変えますか/)).toBeTruthy();
    expect(screen.getByText("設定ページから変更できます")).toBeTruthy();
  });

  it("未読が無ければお返事は出ない", async () => {
    mockFeedback([]);
    renderPage();

    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("担当者からお返事が届きました")).toBeNull();
  });

  it("2件以上あると「＋あと{n}件」で残りを案内する(パネルと同じ1件表示)", async () => {
    mockFeedback([REPLY, { ...REPLY, id: "fb-2" }]);
    renderPage();

    expect(await screen.findByText("＋あと1件")).toBeTruthy();
  });

  it("「解決しました」で既読化され、お返事は画面から消える", async () => {
    mockFeedback([REPLY]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "解決しました" }));

    await waitFor(() =>
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback/fb-1/read",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("担当者からお返事が届きました")).toBeNull());
  });

  it("「まだ解決しません」で既読化 + parent_feedback_id 付きの再相談が送られる(パネルと同一手順)", async () => {
    mockFeedback([REPLY]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "まだ解決しません" }));

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback/fb-1/read",
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            message: "送料の設定はどこから変えますか",
            category: "other",
            parent_feedback_id: "fb-1",
          }),
        }),
      );
    });
  });

  it("previewMode中のsuper_adminはプレビュー対象テナントの未読を取得する", async () => {
    mockFeedback([]);
    renderPage(SUPER_ADMIN_IN_PREVIEW);

    await waitFor(() => {
      const url = vi.mocked(authFetch).mock.calls.map((c) => String(c[0])).find(isUnreadFeedbackUrl);
      expect(url).toBeTruthy();
      expect(url).toContain("tenant_id=tenant-preview");
    });
  });

  it("テナントを特定できないsuper_admin(preview外)では未読を取得しない", async () => {
    mockFeedback([]);
    renderPage({ isSuperAdmin: true, isClientAdmin: false, user: { id: "2", email: "a@example.com", role: "super_admin", tenantId: null, tenantName: null } });

    await waitFor(() => expect(screen.getByText("どのお客様として見ますか？")).toBeTruthy());
    expect(vi.mocked(authFetch).mock.calls.map((c) => String(c[0])).filter(isUnreadFeedbackUrl)).toEqual([]);
  });
});

// 移植した2件目 = 回答の出どころ(answered_from)ラベル。3値の語彙はサーバ
// (agentRoutes.ts)・パネル(AdminAgentPanel.tsx)と同一で、増やしたり言い換えたりしない。
describe("CopilotPreviewPage — 回答の出どころ(answered_from)", () => {
  function mockAnsweredFrom(answeredFrom?: string) {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      agentCalls += 1;
      // 起動時ブリーフィング(1回目)には載せず、ユーザーの質問への回答(2回目)で検証する
      if (agentCalls === 1) return mockOk({ reply: "今週も順調です。", actions: [] });
      return mockOk({
        reply: "全国一律550円です。",
        actions: [],
        ...(answeredFrom ? { answered_from: answeredFrom } : {}),
      });
    });
    // タイプライター演出を切って応答を同期的に確定させる
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
  }

  async function ask() {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(getComposer(), { target: { value: "送料はいくら？" } });
    fireEvent.click(screen.getByLabelText("送信"));
    expect(await screen.findByText("全国一律550円です。")).toBeTruthy();
  }

  it("faq_list は「登録した知識データから回答しました」と出る", async () => {
    mockAnsweredFrom("faq_list");
    await ask();
    expect(screen.getByText("📚 登録した知識データから回答しました")).toBeTruthy();
  });

  it("tool_action は「操作を実行しました」と出る", async () => {
    mockAnsweredFrom("tool_action");
    await ask();
    expect(screen.getByText("⚙️ 操作を実行しました")).toBeTruthy();
  });

  it("general は「R2Cの使い方ガイドから回答しました」と出る", async () => {
    mockAnsweredFrom("general");
    await ask();
    expect(screen.getByText("💡 R2Cの使い方ガイドから回答しました")).toBeTruthy();
  });

  it("answered_from が無い応答ではラベルを出さない(3値以外は表示しない)", async () => {
    mockAnsweredFrom(undefined);
    await ask();
    expect(screen.queryByText(/回答しました|操作を実行しました/)).toBeNull();
  });
});

// 相談窓口ループの入口(パネルの FeedbackPrompt と同じ導線)。
describe("CopilotPreviewPage — 解決確認プロンプト", () => {
  function mockChat() {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      if (String(url).includes("/v1/admin/feedback")) return mockOk({ id: "fb-9" });
      return mockOk({ reply: "申し訳ございません、その情報は登録されていません。", actions: [] });
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
  }

  async function ask(text: string) {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(getComposer(), { target: { value: text } });
    fireEvent.click(screen.getByLabelText("送信"));
    return screen.findByText("このお返事で解決しましたか？");
  }

  it("起動時ブリーフィングだけの状態では出ない(ユーザーが何も聞いていないため)", async () => {
    mockChat();
    renderPage();

    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("このお返事で解決しましたか？")).toBeNull();
  });

  it("「うまく解決しなかった」で質問文が相談として送られ、確認文言に変わる", async () => {
    mockChat();
    await ask("割引クーポンはありますか");

    fireEvent.click(screen.getByRole("button", { name: "うまく解決しなかった" }));

    await waitFor(() =>
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "割引クーポンはありますか", category: "other" }),
        }),
      ),
    );
    expect(await screen.findByText("✅ 担当者に伝えました。お返事はこの画面に届きます。")).toBeTruthy();
  });

  it("「はい」で消え、相談は送られない", async () => {
    mockChat();
    await ask("送料を教えて");

    fireEvent.click(screen.getByRole("button", { name: "はい" }));

    expect(screen.queryByText("このお返事で解決しましたか？")).toBeNull();
    const posted = vi
      .mocked(authFetch)
      .mock.calls.filter((c) => String(c[0]).endsWith("/v1/admin/feedback"));
    expect(posted).toEqual([]);
  });
});
