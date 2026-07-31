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

  it("アバター見本の提案(suggest_avatar_preset)はcardの構造化データがそのまま描画される", async () => {
    mockAgent({
      reply: "見本をご提案しました。",
      actions: [
        {
          tool: "suggest_avatar_preset",
          result: "「Haruka」というアバターの見本があります。\nとても丁寧な性格です。\nプリセットID: preset-1\nこのまま採用しますか？",
          card: { kind: "avatar_preset", presetId: "preset-1", name: "Haruka", imageUrl: null, description: "とても丁寧な性格です。" },
        },
      ],
    });

    await send("アバターを作りたい");

    expect(await screen.findByText("Haruka")).toBeTruthy();
    expect(screen.getByText("とても丁寧な性格です。")).toBeTruthy();
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

  it("chat_session_list カードは一覧を表示し、次の1件を選ぶチップを添える(短縮IDの手打ち不要)", async () => {
    mockAgent({
      reply: "直近の会話は1件です。",
      actions: [
        {
          tool: "get_chat_sessions",
          result: "会話セッション一覧（全1件中1件）:\n[sess-aaa] 2026-07-17 (4件) 「送料はいくらですか」",
          card: {
            kind: "chat_session_list",
            total: 1,
            sessions: [{ shortId: "sess-aaa", startedAt: "2026-07-17T10:00:00Z", messageCount: 4, preview: "送料はいくらですか" }],
          },
        },
      ],
    });

    await send("最近の会話を見せて");

    expect(await screen.findByText("送料はいくらですか")).toBeTruthy();
    expect(screen.getByText(/全1件中1件/)).toBeTruthy();
    // 短縮IDを手打ちせず、チップから次の1件を選べる
    const chip = await screen.findByRole("button", { name: /07-17 送料はいくらですか/ });
    expect(chip).toBeTruthy();
  });

  it("chat_session_list のチップを押すと、短縮IDを含む自然文が実送信される", async () => {
    vi.mocked(authFetch).mockReset();
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      agentCalls += 1;
      if (agentCalls === 1) return mockOk({ reply: "今週のまとめです。", actions: [] });
      if (agentCalls === 2) {
        return mockOk({
          reply: "1件見つかりました。",
          actions: [
            {
              tool: "get_chat_sessions",
              result: "会話セッション一覧（全1件中1件）:\n[sess-aaa] 2026-07-17 (4件) 「送料はいくらですか」",
              card: {
                kind: "chat_session_list",
                total: 1,
                sessions: [{ shortId: "sess-aaa", startedAt: "2026-07-17T10:00:00Z", messageCount: 4, preview: "送料はいくらですか" }],
              },
            },
          ],
        });
      }
      return mockOk({ reply: "会話の内容はこちらです。", actions: [] });
    });

    await send("最近の会話を見せて");
    const chip = await screen.findByRole("button", { name: /07-17 送料はいくらですか/ });
    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByText("[sess-aaa]の会話を見せて")).toBeTruthy());
  });

  it("chat_session_messages カードは会話本文をロールラベル付きで表示する", async () => {
    mockAgent({
      reply: "会話内容はこちらです。",
      actions: [
        {
          tool: "get_chat_session_messages",
          result: "セッション[a1b2c3d4]の会話（全1件中1件）:\nお客様: 送料はいくらですか",
          card: {
            kind: "chat_session_messages",
            shortId: "a1b2c3d4",
            totalMessages: 1,
            messages: [{ roleLabel: "お客様", content: "送料はいくらですか" }],
          },
        },
      ],
    });

    await send("a1b2c3d4の会話を見せて");

    expect(await screen.findByText("お客様")).toBeTruthy();
    expect(screen.getByText("送料はいくらですか")).toBeTruthy();
  });

  it("record_session_outcome が確認待ちのときは「記録して」チップを出し、押すと実送信する", async () => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    let outcomeCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      outcomeCalls += 1;
      if (outcomeCalls === 1) return mockOk({ reply: "今週のまとめです。", actions: [] });
      if (outcomeCalls === 2) {
        return mockOk({
          reply: "確認をお願いします。",
          actions: [
            {
              tool: "record_session_outcome",
              result:
                "セッション[oooo1111]の成果を「購入完了」として記録するには確認が必要です。ユーザーに提示し、同意を得てから confirmed=true で再度実行してください",
            },
          ],
        });
      }
      return mockOk({ reply: "記録しました。", actions: [] });
    });

    await send("oooo1111の成果を購入完了で記録して");

    const chip = await screen.findByRole("button", { name: "記録して" });
    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByText("はい、お願いします")).toBeTruthy());
  });

  it("record_session_outcome が確認待ちのときに「やめておく」を押すと、記録せず辞退の自然文を送る", async () => {
    mockAgent({
      reply: "確認をお願いします。",
      actions: [
        {
          tool: "record_session_outcome",
          result:
            "セッション[oooo1111]の成果を「購入完了」として記録するには確認が必要です。ユーザーに提示し、同意を得てから confirmed=true で再度実行してください",
        },
      ],
    });

    await send("oooo1111の成果を購入完了で記録して");

    const declineButton = await screen.findByRole("button", { name: "やめておく" });
    fireEvent.click(declineButton);

    await waitFor(() => expect(screen.getByText("やめておきます")).toBeTruthy());
    const chatBodies = vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(chatBodies.at(-1)?.message).toBe("やめておきます");
  });

  it("delete_chat_session が確認待ちのときは「削除して」チップを出し、押すと実送信する", async () => {
    mockAgent({
      reply: "確認をお願いします。",
      actions: [
        {
          tool: "delete_chat_session",
          result:
            "セッション[dddd1111]の削除には確認が必要です。この操作は取り消せません。\n理由: テストのため削除\nこの内容でよいかユーザーに提示し、同意を得てから confirmed=true で再度実行してください",
        },
      ],
    });

    await send("dddd1111をテストのため削除して");

    const chip = await screen.findByRole("button", { name: "削除して" });
    expect(screen.getByRole("button", { name: "やめておく" })).toBeTruthy();
    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByText("はい、削除してください")).toBeTruthy());
    const chatBodies = vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(chatBodies.at(-1)?.message).toBe("はい、削除してください");
  });

  it("delete_chat_session が確認待ちのときに「やめておく」を押すと、削除せず辞退の自然文を送る(不可逆操作なので取り消しが明確に効くことを確認)", async () => {
    mockAgent({
      reply: "確認をお願いします。",
      actions: [
        {
          tool: "delete_chat_session",
          result:
            "セッション[dddd1111]の削除には確認が必要です。この操作は取り消せません。\n理由: テストのため削除\nこの内容でよいかユーザーに提示し、同意を得てから confirmed=true で再度実行してください",
        },
      ],
    });

    await send("dddd1111をテストのため削除して");

    const declineButton = await screen.findByRole("button", { name: "やめておく" });
    fireEvent.click(declineButton);

    await waitFor(() => expect(screen.getByText("やめておきます")).toBeTruthy());
    const chatBodies = vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(chatBodies.at(-1)?.message).toBe("やめておきます");
  });

  it("conversation_evaluation カードは総合スコア・4軸・所見を表示する(旧UIと同一の閾値)", async () => {
    mockAgent({
      reply: "評価はこちらです。",
      actions: [
        {
          tool: "get_conversation_evaluation",
          result: "セッション[eeee1111]の対応品質評価: 総合85点\n心理対応力: 90 / 顧客対応力: 80 / 商談進行力: 70 / 禁止事項の遵守率: 100\n所見: 丁寧な対応でした",
          card: {
            kind: "conversation_evaluation",
            shortId: "eeee1111",
            overallScore: 85,
            axes: [
              { label: "心理対応力", score: 90 },
              { label: "顧客対応力", score: 80 },
              { label: "商談進行力", score: 70 },
              { label: "禁止事項の遵守率", score: 100 },
            ],
            notes: "丁寧な対応でした",
          },
        },
      ],
    });

    await send("eeee1111の対応品質を教えて");

    expect(await screen.findByText(/総合85点/)).toBeTruthy();
    expect(screen.getByText(/心理対応力: 90/)).toBeTruthy();
    expect(screen.getByText(/禁止事項の遵守率: 100/)).toBeTruthy();
    expect(screen.getByText("丁寧な対応でした")).toBeTruthy();
  });

  it("conversation_evaluation カードは未測定(null)の軸を「未測定」と表示する(0点と混同しない)", async () => {
    mockAgent({
      reply: "評価はこちらです。",
      actions: [
        {
          tool: "get_conversation_evaluation",
          result: "セッション[eeee1111]の対応品質評価: 総合60点\n心理対応力: 未測定 / 顧客対応力: 60 / 商談進行力: 未測定 / 禁止事項の遵守率: 100",
          card: {
            kind: "conversation_evaluation",
            shortId: "eeee1111",
            overallScore: 60,
            axes: [
              { label: "心理対応力", score: null },
              { label: "顧客対応力", score: 60 },
              { label: "商談進行力", score: null },
              { label: "禁止事項の遵守率", score: 100 },
            ],
            notes: null,
          },
        },
      ],
    });

    await send("eeee1111の対応品質を教えて");

    expect(await screen.findByText(/心理対応力: 未測定/)).toBeTruthy();
    expect(screen.getByText(/商談進行力: 未測定/)).toBeTruthy();
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

  // GID: 1ターンに suggest_faq(下書き提案の確認待ち)と get_weekly_briefing(未回答質問あり)が
  // 同時に来た場合、優先されるべきは「保存して/やめておく」(確認が必要な保留中の書き込み)で、
  // 週次まとめのチップではない。同時発生は稀だが、chips は現状 if/elseif の単一選択(排他)で
  // 実装されているため、優先順位が実装の分岐順そのものに委ねられている。この境界を固定する。
  it("suggest_faqの確認待ちと週次まとめの行動チップが同一ターンに同居した場合、確認待ちの保存/やめるが優先される", async () => {
    mockAgent({
      reply: "下書きと今週の状況をまとめました。",
      actions: [
        { tool: "suggest_faq", result: "質問: 送料はいくら？\n回答: 全国一律550円です。\n分類: 配送" },
        {
          tool: "get_weekly_briefing",
          result: "今週(月曜起点)の状況:\n会話数 10件",
          card: {
            kind: "weekly_summary",
            asOf: "2026-08-05T03:00:00.000Z",
            sessions: { total: 10, changePct: null, prevTotal: 0 },
            avgScore: null,
            conversions: null,
            faq: null,
            pendingTuningRules: 2,
            gaps: { total: 5, top: [{ id: 1, question: "返品はできますか？" }] },
          },
        },
      ],
    });

    await send("FAQ案を作りつつ今週の状況も教えて");

    await waitFor(() => expect(screen.getByRole("button", { name: "保存して" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "やめておく" })).toBeTruthy();
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

  // GID: asOf は改ざん/破損した sessionStorage から復元される可能性がある(手動編集・
  // 古いスキーマのデータ等)。修正前は new Date(不正値) を toISOString() に渡した瞬間に
  // 例外が飛び、WeeklySummaryCard の描画自体が失敗して画面がスレッドごと真っ白になっていた
  // (このページに React Error Boundary は無い)。回帰テスト。
  it("集計時点(asOf)が不正な値でもクラッシュせず「不明」として表示する", async () => {
    mockAgent({
      reply: "今週の状況です。",
      actions: [
        {
          tool: "get_weekly_briefing",
          result: "今週(月曜起点)の状況:\n会話数 50件",
          card: {
            kind: "weekly_summary",
            asOf: "this-is-not-a-valid-date",
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

    // クラッシュしていれば "50件" を含むこの後続描画自体に到達しない
    await screen.findByText("50件");
    expect(screen.getByText(/集計時点: 不明/)).toBeTruthy();
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

  // mockAgent は2回目以降すべて同じ応答を返す(単発の描画確認向け)ため、
  // クリック後の3ターン目に別の応答を返す必要があるこのテストだけは自前でモックする。
  it("見本提案が出たら「採用して」チップが出て、押すと自然文で採用を伝える", async () => {
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
          reply: "見本をご提案しました。",
          actions: [
            {
              tool: "suggest_avatar_preset",
              result: "「Haruka」というアバターの見本があります。\nプリセットID: preset-1\nこのまま採用しますか？",
              card: { kind: "avatar_preset", presetId: "preset-1", name: "Haruka", imageUrl: null, description: "とても丁寧な性格です。" },
            },
          ],
        });
      }
      return mockOk({
        reply: "採用しました。",
        actions: [{ tool: "adopt_avatar_preset", result: "アバター「Haruka」を採用しました。まだ公開はされていません。" }],
      });
    });

    await send("アバターを作りたい");

    const adoptButton = await screen.findByRole("button", { name: "採用して" });
    expect(screen.getByRole("button", { name: "やめておく" })).toBeTruthy();

    fireEvent.click(adoptButton);

    await waitFor(() => expect(screen.getByText("採用してください")).toBeTruthy());
    const chatBodies = vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(chatBodies.at(-1)?.message).toBe("採用してください");
    // 二度押し防止: 前のターンのチップは使用済みになり消える
    expect(screen.queryByRole("button", { name: "採用して" })).toBeNull();
  });

  // D3: 500字のtextでは実質3〜4件しか出ていなかった一覧が、cardでは件数によらず全件出る回帰。
  it("get_tuning_rules: 15件を超えても全件がカードに描画される(500字打ち切りの回帰)", async () => {
    const rules = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      triggerPattern: `トリガー${i + 1}`,
      expectedBehavior: `振る舞い${i + 1}`,
      priority: 5,
      isActive: i % 2 === 0,
    }));
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（20件、うち有効10件・無効10件）です。詳しい内容は一覧でご確認いただけます。",
          card: { kind: "tuning_rules_list", rules, totalCount: 20 },
        },
      ],
    });

    await send("指示ルールの状況を教えて");

    expect(await screen.findByText("トリガー1")).toBeTruthy();
    expect(screen.getByText("トリガー20")).toBeTruthy();
    expect(screen.getAllByText("✅ 有効")).toHaveLength(10);
    expect(screen.getAllByText("⏸️ 無効")).toHaveLength(10);
  });

  it("get_tuning_rules: card が無い場合は従来どおり自然文の agentAction 表示になる(後方互換)", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        { tool: "get_tuning_rules", result: "有効な指示ルールはありません" },
      ],
    });

    await send("指示ルールの状況を教えて");

    // agentAction汎用表示は「ラベル：結果」を1つのspanにまとめるため、
    // 完全一致ではなく正規表現の部分一致で確認する(他のagentAction回帰テストと同じ形式)。
    expect(await screen.findByText(/有効な指示ルールはありません/)).toBeTruthy();
  });

  // D6: 下書きカードの表示内容が保存内容(トリガー/対応方針/優先度)と一致することの回帰。
  it("suggest_tuning_rule: cardがあれば優先度も表示される(D6、以前は黙って捨てられていた)", async () => {
    mockAgent({
      reply: "こう提案します。保存してよいですか？",
      actions: [
        {
          tool: "suggest_tuning_rule",
          result: "提案:\nトリガー: 保証\n対応方針: 2年とお伝えする\n優先度: 8\n",
          card: { kind: "tuning_rule_draft", triggerPattern: "保証", expectedBehavior: "2年とお伝えする", priority: 8 },
        },
      ],
    });

    await send("保証について聞かれたら2年と答えて");

    expect(await screen.findByText("どんな時に")).toBeTruthy();
    expect(screen.getByText("保証")).toBeTruthy();
    expect(screen.getByText("2年とお伝えする")).toBeTruthy();
    expect(screen.getByText("優先度")).toBeTruthy();
    expect(screen.getByText("高")).toBeTruthy();
  });

  it("suggest_tuning_rule: 対応方針が複数行でも1行目だけに切られず全行表示される(D6)", async () => {
    const multiline = "1行目の案内。\n2行目の補足。\n3行目の締めくくり。";
    mockAgent({
      reply: "こう提案します。保存してよいですか？",
      actions: [
        {
          tool: "suggest_tuning_rule",
          result: `提案:\nトリガー: 保証\n対応方針: ${multiline}\n優先度: 5\n`,
          card: { kind: "tuning_rule_draft", triggerPattern: "保証", expectedBehavior: multiline, priority: 5 },
        },
      ],
    });

    await send("保証について聞かれたら2年と答えて");

    expect(await screen.findByText("1行目の案内。", { exact: false })).toBeTruthy();
    expect(screen.getByText("2行目の補足。", { exact: false })).toBeTruthy();
    expect(screen.getByText("3行目の締めくくり。", { exact: false })).toBeTruthy();
  });

  it("suggest_tuning_rule: cardが無い場合は従来どおり自然文の正規表現パースでカードになる(後方互換)", async () => {
    mockAgent({
      reply: "こう提案します。保存してよいですか？",
      actions: [
        { tool: "suggest_tuning_rule", result: "提案:\nトリガー: 保証\n対応方針: 2年とお伝えする\n優先度: 5\n" },
      ],
    });

    await send("保証について聞かれたら2年と答えて");

    expect(await screen.findByText("どんな時に")).toBeTruthy();
    expect(screen.getByText("保証")).toBeTruthy();
    expect(screen.getByText("2年とお伝えする")).toBeTruthy();
    // card が無い正規表現フォールバック経路には優先度が無いため表示されない
    expect(screen.queryByText("優先度")).toBeNull();
  });

  // P4-1: AI提案ルールの承認/却下と根拠提示
  it("get_tuning_rules: AI提案(未承認)には出所バッジと承認/却下ボタン、根拠が表示される", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（1件、うち有効0件・無効1件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 1,
            rules: [
              {
                id: 42,
                triggerPattern: "送料",
                expectedBehavior: "一律500円とお伝えする",
                priority: 5,
                isActive: false,
                source: "judge",
                status: "pending",
                evidence: { avgScore: 38, effectivePrinciples: ["共感"], failedPrinciples: ["クロージング"] },
              },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");

    expect(await screen.findByText(/AIの提案（未承認）/)).toBeTruthy();
    // 根拠は評価IDなど内部識別子をそのまま出さず、店主の言葉に言い換える
    expect(screen.getByText(/もとになった会話の対応の質/)).toBeTruthy();
    expect(screen.getByText(/共感/)).toBeTruthy();
    expect(screen.getByText(/クロージング/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "有効にする" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "却下する" })).toBeTruthy();
  });

  it("get_tuning_rules: 自分で作ったルール(source=manual)にはAI提案バッジも承認ボタンも出ない", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（1件、うち有効1件・無効0件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 1,
            rules: [
              { id: 1, triggerPattern: "保証", expectedBehavior: "2年", priority: 5, isActive: true, source: "manual", status: null, evidence: null },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");

    await screen.findByText("保証");
    expect(screen.queryByText(/AIの提案/)).toBeNull();
    expect(screen.queryByRole("button", { name: "有効にする" })).toBeNull();
    expect(screen.queryByRole("button", { name: "却下する" })).toBeNull();
  });

  it("get_tuning_rules: 却下済み(status=rejected)には承認ボタンが出ず、却下済みバッジのみ表示される", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（1件、うち有効0件・無効1件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 1,
            rules: [
              { id: 43, triggerPattern: "値引き", expectedBehavior: "応じない", priority: 3, isActive: false, source: "judge", status: "rejected", evidence: null },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");

    expect(await screen.findByText(/AIの提案（却下済み）/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "有効にする" })).toBeNull();
    expect(screen.queryByRole("button", { name: "却下する" })).toBeNull();
  });

  it("get_tuning_rules: 「有効にする」を押すと承認の自然文が実送信される", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（1件、うち有効0件・無効1件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 1,
            rules: [
              { id: 42, triggerPattern: "送料", expectedBehavior: "一律500円とお伝えする", priority: 5, isActive: false, source: "judge", status: "pending", evidence: null },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");
    const approveButton = await screen.findByRole("button", { name: "有効にする" });

    fireEvent.click(approveButton);

    await waitFor(() => {
      const calls = vi.mocked(authFetch).mock.calls;
      const chatCall = calls.find(([url]) => String(url).includes("/v1/admin/agent/chat"));
      expect(chatCall).toBeTruthy();
    });
    const lastCall = vi.mocked(authFetch).mock.calls[vi.mocked(authFetch).mock.calls.length - 1];
    const body = JSON.parse((lastCall![1] as RequestInit).body as string);
    expect(body.message).toContain("ID: 42");
    expect(body.message).toContain("承認して有効にしてください");
  });

  // 壊れやすいポイント: card.rules.map() 内で各行に承認/却下ボタンを描画しており、
  // クロージャがループ変数を正しく捕捉していないと「どのボタンを押しても
  // 最後の行のIDが送信される」という事故になりうる(JSのvar由来のバグの定番形)。
  // 複数の未承認提案を同時に表示し、それぞれのボタンが自分自身のIDだけを
  // 送信することを固定する。
  it("get_tuning_rules: 複数のAI提案が同時に表示されても各行のボタンは自分自身のIDだけを送信する", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（2件、うち有効0件・無効2件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 2,
            rules: [
              { id: 10, triggerPattern: "送料", expectedBehavior: "一律500円", priority: 5, isActive: false, source: "judge", status: "pending", evidence: null },
              { id: 20, triggerPattern: "営業時間", expectedBehavior: "10時〜18時", priority: 3, isActive: false, source: "judge", status: "pending", evidence: null },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");
    const approveButtons = await screen.findAllByRole("button", { name: "有効にする" });
    expect(approveButtons).toHaveLength(2);

    // 2件目(ID:20)の「有効にする」だけをクリックする
    fireEvent.click(approveButtons[1]!);

    await waitFor(() => {
      const calls = vi.mocked(authFetch).mock.calls;
      expect(calls.some(([url]) => String(url).includes("/v1/admin/agent/chat"))).toBe(true);
    });
    const lastCall = vi.mocked(authFetch).mock.calls[vi.mocked(authFetch).mock.calls.length - 1];
    const body = JSON.parse((lastCall![1] as RequestInit).body as string);
    // 1件目(ID:10)ではなく、クリックした2件目(ID:20)のIDが送信されること
    expect(body.message).toContain("ID: 20");
    expect(body.message).not.toContain("ID: 10");
  });

  // 壊れやすいポイント: evidenceが空オブジェクト{}の場合(avgScore等すべて
  // undefined)、根拠ブロックが空のdivとして描画され続けると、店主から見て
  // 「何も書かれていない謎の空白」が出る視覚バグになる。何も表示しないか、
  // 少なくともクラッシュしないことを固定する。
  it("get_tuning_rules: evidenceが空オブジェクトでもクラッシュせず、空の根拠行は表示されない", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（1件、うち有効0件・無効1件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 1,
            rules: [
              { id: 42, triggerPattern: "送料", expectedBehavior: "一律500円", priority: 5, isActive: false, source: "judge", status: "pending", evidence: {} },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");

    expect(await screen.findByText(/AIの提案（未承認）/)).toBeTruthy();
    expect(screen.queryByText(/もとになった会話の対応の質/)).toBeNull();
    expect(screen.queryByText(/効果があった対応/)).toBeNull();
    expect(screen.queryByText(/うまくいかなかった対応/)).toBeNull();
  });

  // 壊れやすいポイント: is_active=true(=承認され本番に反映済み)なのに
  // statusがpending/nullのまま(LLMがstatusの同時指定を忘れた等で発生しうる
  // 不整合状態)。承認判定はis_activeを唯一の権威とするため、この場合でも
  // 「未承認」バッジやボタンが誤って出続けてはならないことを固定する。
  it("get_tuning_rules: is_active=trueだがstatusがpendingのまま(不整合状態)でも未承認バッジやボタンは出ない", async () => {
    mockAgent({
      reply: "指示ルールの状況をお伝えしました。",
      actions: [
        {
          tool: "get_tuning_rules",
          result: "指示ルール一覧（1件、うち有効1件・無効0件）です。詳しい内容は一覧でご確認いただけます。",
          card: {
            kind: "tuning_rules_list",
            totalCount: 1,
            rules: [
              { id: 42, triggerPattern: "送料", expectedBehavior: "一律500円", priority: 5, isActive: true, source: "judge", status: "pending", evidence: null },
            ],
          },
        },
      ],
    });

    await send("指示ルールの状況を教えて");

    await screen.findByText("✅ 有効");
    expect(screen.queryByText(/未承認/)).toBeNull();
    expect(screen.queryByRole("button", { name: "有効にする" })).toBeNull();
    expect(screen.queryByRole("button", { name: "却下する" })).toBeNull();
    // 出所は分かるようにAIの提案タグ自体は出す(承認済みとして扱われるだけで消えない)
    expect(screen.getByText(/AIの提案/)).toBeTruthy();
  });
});

function getComposer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/指示ルール/) as HTMLTextAreaElement;
}

// アバター画像候補の生成・採用は、エージェントツール経由にせずチャットから直接
// POST /v1/admin/avatar/fal/generate / PATCH /v1/admin/avatar/configs/:id を叩く。
// この2エンドポイントの応答を authFetch のURL分岐で個別に制御する。
describe("CopilotPreviewPage — アバター画像候補の生成・採用", () => {
  function mockAdoptedThenEndpoints(opts: {
    generate?: () => Promise<Response>;
    patch?: () => Promise<Response>;
  }) {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      if (String(url).includes("/v1/admin/avatar/fal/generate")) {
        return opts.generate ? opts.generate() : mockOk({ images: ["https://img/1.png"] });
      }
      if (String(url).includes("/v1/admin/avatar/configs/")) {
        return opts.patch ? opts.patch() : mockOk({ id: "cfg-1" });
      }
      if (String(url).includes("/v1/admin/agent/chat")) {
        agentCalls += 1;
        if (agentCalls === 1) return mockOk({ reply: "今週も順調です。", actions: [] });
        return mockOk({
          reply: "採用しました。",
          actions: [
            {
              tool: "adopt_avatar_preset",
              result: "アバター「Haruka」を採用しました。まだ公開はされていません。",
              card: { kind: "avatar_adopted", configId: "cfg-1", name: "Haruka", imageUrl: null, description: "とても丁寧な性格です。" },
            },
          ],
        });
      }
      return mockOk({});
    });
  }

  async function sendAndAdopt() {
    renderPage();
    // 起動時ブリーフィングのタイプライター演出が完了する(sendingがfalseへ確定する)まで待つ。
    // 早すぎるタイミングでdisabled判定すると、演出中にsendingが再びtrueへ倒れる前の
    // 初期レンダー(sending初期値false)を素通りしてしまい、直後のクリックが disabled な
    // ボタンに当たって何も起きない(実際にこの競合でテストが落ちた)。
    await waitFor(() => expect(screen.getByText("今週も順調です。")).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(getComposer(), { target: { value: "採用してください" } });
    fireEvent.click(screen.getByLabelText("送信"));
    return screen.findByRole("button", { name: "画像を新しく生成する" });
  }

  it("生成→完了で候補4枚が描画され、採用でPATCHが呼ばれて二重押しできない", async () => {
    const images = ["https://img/1.png", "https://img/2.png", "https://img/3.png", "https://img/4.png"];
    mockAdoptedThenEndpoints({ generate: () => mockOk({ images }) });

    const generateButton = await sendAndAdopt();
    fireEvent.click(generateButton);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "これにする" }).length).toBe(4));

    const generateCall = vi
      .mocked(authFetch)
      .mock.calls.find(([url]) => String(url).includes("/fal/generate"));
    expect(generateCall).toBeTruthy();
    expect(JSON.parse(String((generateCall![1] as RequestInit).body)).numImages).toBe(4);

    fireEvent.click(screen.getAllByRole("button", { name: "これにする" })[1]!);

    await waitFor(() => expect(screen.getByRole("button", { name: "これに決定" })).toBeTruthy());
    const patchCall = vi
      .mocked(authFetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/admin/avatar/configs/cfg-1"));
    expect(patchCall).toBeTruthy();
    expect((patchCall![1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ image_url: images[1] });

    // 決定後は残りの「これにする」ボタンが押せない(二重採用の防止)
    const remaining = screen.getAllByRole("button", { name: "これにする" });
    for (const btn of remaining) expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("生成が5xxで失敗しても確定し、無限スピナーを残さない", async () => {
    mockAdoptedThenEndpoints({
      generate: () =>
        Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: "画像生成サービスでエラーが発生しました" }) } as Response),
    });

    const generateButton = await sendAndAdopt();
    fireEvent.click(generateButton);

    expect(await screen.findByText("画像生成サービスでエラーが発生しました")).toBeTruthy();
    expect(screen.queryByText("数十秒かかることがあります。このまま他の操作もできます。")).toBeNull();
    expect(await screen.findByRole("button", { name: "もう一度試す" })).toBeTruthy();
  });

  it("ネットワークエラーでも失敗として確定する(汎用の文言)", async () => {
    mockAdoptedThenEndpoints({ generate: () => Promise.reject(new Error("network down")) });

    const generateButton = await sendAndAdopt();
    fireEvent.click(generateButton);

    expect(await screen.findByText("画像を生成できませんでした。少し時間をおいてもう一度お試しください。")).toBeTruthy();
  });

  it("採用のPATCHが失敗しても、まだ採用されていない扱いのままエラーを示す", async () => {
    mockAdoptedThenEndpoints({
      generate: () => mockOk({ images: ["https://img/1.png"] }),
      patch: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "更新に失敗しました" }) } as Response),
    });

    const generateButton = await sendAndAdopt();
    fireEvent.click(generateButton);
    const adoptButton = await screen.findByRole("button", { name: "これにする" });
    fireEvent.click(adoptButton);

    expect(await screen.findByText("更新に失敗しました")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "これに決定" })).toBeNull();
    expect(screen.getByRole("button", { name: "これにする" })).toBeTruthy();
  });
});

// POST /match-voice はテキストの候補(id/title/description/score)のみを返し音声
// プレビューURLを持たない(旧UIウィザードのStudioVoiceSectionも試聴機能を持たない)。
// 計画は「試聴要素の存在」を前提にしていたが、実装を確認するとその基盤が無いため、
// 一覧から選ぶ形に修正し、代わりに「プレビューは提供されていない」旨を明示するテストを書く。
describe("CopilotPreviewPage — アバターの声の選択・採用", () => {
  function mockAdoptedThenVoiceEndpoints(opts: {
    match?: () => Promise<Response>;
    patch?: () => Promise<Response>;
  }) {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      if (String(url).includes("/v1/admin/avatar/match-voice")) {
        return opts.match
          ? opts.match()
          : mockOk({ recommendations: [{ id: "voice-1", title: "Haruka Voice", description: "明るく親しみやすい声", score: 0.92 }] });
      }
      if (String(url).includes("/v1/admin/avatar/configs/")) {
        return opts.patch ? opts.patch() : mockOk({ id: "cfg-1" });
      }
      if (String(url).includes("/v1/admin/agent/chat")) {
        agentCalls += 1;
        if (agentCalls === 1) return mockOk({ reply: "今週も順調です。", actions: [] });
        return mockOk({
          reply: "採用しました。",
          actions: [
            {
              tool: "adopt_avatar_preset",
              result: "アバター「Haruka」を採用しました。まだ公開はされていません。",
              card: { kind: "avatar_adopted", configId: "cfg-1", name: "Haruka", imageUrl: null, description: "とても丁寧な性格です。" },
            },
          ],
        });
      }
      return mockOk({});
    });
  }

  async function sendAndFindVoiceButton() {
    renderPage();
    await waitFor(() => expect(screen.getByText("今週も順調です。")).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(getComposer(), { target: { value: "採用してください" } });
    fireEvent.click(screen.getByLabelText("送信"));
    return screen.findByRole("button", { name: "声を探す" });
  }

  it("候補が描画され、音声プレビューが無い旨が明示される(試聴URLを持たないため)", async () => {
    mockAdoptedThenVoiceEndpoints({});

    const voiceButton = await sendAndFindVoiceButton();
    fireEvent.click(voiceButton);

    expect(await screen.findByText("Haruka Voice")).toBeTruthy();
    expect(screen.getByText("明るく親しみやすい声")).toBeTruthy();
    expect(screen.getByText("92%")).toBeTruthy();
    expect(screen.getByText("音声のプレビューは提供されていません。名前と説明を参考にお選びください。")).toBeTruthy();
    expect(document.querySelector("audio")).toBeNull();

    const matchCall = vi.mocked(authFetch).mock.calls.find(([url]) => String(url).includes("/match-voice"));
    expect(matchCall).toBeTruthy();
    // 声の説明を新たに尋ねず、採用済みの性格・話し方の説明をそのまま検索クエリにする
    expect(JSON.parse(String((matchCall![1] as RequestInit).body))).toEqual({ description: "とても丁寧な性格です。" });
  });

  it("採用でPATCHが呼ばれ、二重押しできない", async () => {
    mockAdoptedThenVoiceEndpoints({});

    const voiceButton = await sendAndFindVoiceButton();
    fireEvent.click(voiceButton);

    const adoptButton = await screen.findByRole("button", { name: "この声にする" });
    fireEvent.click(adoptButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "これに決定" })).toBeTruthy());
    const patchCall = vi
      .mocked(authFetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/admin/avatar/configs/cfg-1"));
    expect(patchCall).toBeTruthy();
    expect((patchCall![1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ voice_id: "voice-1" });
    expect((screen.getByRole("button", { name: "これに決定" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("候補が0件でも失敗として確定する(無限スピナーを残さない)", async () => {
    mockAdoptedThenVoiceEndpoints({ match: () => mockOk({ recommendations: [] }) });

    const voiceButton = await sendAndFindVoiceButton();
    fireEvent.click(voiceButton);

    expect(await screen.findByText("合う声が見つかりませんでした。もう一度お試しください。")).toBeTruthy();
    expect(screen.queryByText("少し時間がかかることがあります。このまま他の操作もできます。")).toBeNull();
    expect(await screen.findByRole("button", { name: "もう一度試す" })).toBeTruthy();
  });

  it("検索が5xxで失敗しても確定する", async () => {
    mockAdoptedThenVoiceEndpoints({
      match: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "声マッチングに失敗しました" }) } as Response),
    });

    const voiceButton = await sendAndFindVoiceButton();
    fireEvent.click(voiceButton);

    expect(await screen.findByText("声マッチングに失敗しました")).toBeTruthy();
  });

  it("採用のPATCHが失敗しても、まだ採用されていない扱いのままエラーを示す", async () => {
    mockAdoptedThenVoiceEndpoints({
      patch: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "更新に失敗しました" }) } as Response),
    });

    const voiceButton = await sendAndFindVoiceButton();
    fireEvent.click(voiceButton);
    const adoptButton = await screen.findByRole("button", { name: "この声にする" });
    fireEvent.click(adoptButton);

    expect(await screen.findByText("更新に失敗しました")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "これに決定" })).toBeNull();
    expect(screen.getByRole("button", { name: "この声にする" })).toBeTruthy();
  });
});

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

// 「対応中の会話」(J1: 今すぐ対応が要る)と「会話の履歴」(J2点検/J3照会)は緊急性の軸が
// 違うため別カテゴリーに分けた。会話の履歴は1回の定型質問ではなく、点検/照会どちらを
// したいかをチップで選ばせる(反復探索に耐えないという課題への対応)。
describe("CopilotPreviewPage — 対応中の会話カテゴリーと会話の履歴カテゴリー(点検/照会分岐)", () => {
  function mockAgentSequential(replies: unknown[]) {
    vi.mocked(authFetch).mockReset();
    let agentCalls = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/my-tenant")) {
        return mockOk({ onboarding_completed_at: "2026-01-01T00:00:00Z" });
      }
      if (isUnreadFeedbackUrl(url)) return mockNoFeedbackReplies();
      const reply = replies[agentCalls] ?? replies[replies.length - 1];
      agentCalls += 1;
      return mockOk(reply);
    });
  }

  function chatBodies() {
    return vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
  }

  it("「対応中の会話」は会話の履歴とは別の定型文を即送信する", async () => {
    mockAgentSequential([
      { reply: "今週も順調です。", actions: [] },
      { reply: "対応中の会話が2件あります。", actions: [] },
    ]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /対応中の会話/ }));

    await waitFor(() => expect(chatBodies().length).toBe(2));
    expect(chatBodies()[1]?.["message"]).toBe("対応中のエスカレーションの状況を教えて");
  });

  it("「会話の履歴」を押すと即送信せず、点検/照会のチップを提示する", async () => {
    mockAgentSequential([{ reply: "今週も順調です。", actions: [] }]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /会話の履歴/ }));

    expect(await screen.findByRole("button", { name: "最近の会話を点検する" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "特定の会話を探す" })).toBeTruthy();
    // チップを出しただけでは実APIを追加で叩かない(ブリーフィングの1本のみ)
    expect(chatBodies().length).toBe(1);
  });

  it("「最近の会話を点検する」チップは点検用の定型文を送る", async () => {
    mockAgentSequential([
      { reply: "今週も順調です。", actions: [] },
      { reply: "問題は見当たりませんでした。", actions: [] },
    ]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /会話の履歴/ }));
    fireEvent.click(await screen.findByRole("button", { name: "最近の会話を点検する" }));

    await waitFor(() => expect(chatBodies().length).toBe(2));
    expect(chatBodies()[1]?.["message"]).toBe(
      "直近の会話を点検して、対応品質に問題がありそうな会話があれば教えて",
    );
    // 選んだ後はもう一方のチップも使用済みになり再表示されない
    expect(screen.queryByRole("button", { name: "特定の会話を探す" })).toBeNull();
  });

  it("「特定の会話を探す」チップは照会用の定型文を送る", async () => {
    mockAgentSequential([
      { reply: "今週も順調です。", actions: [] },
      { reply: "いつ頃の会話か、キーワードなどを教えてください。", actions: [] },
    ]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /会話の履歴/ }));
    fireEvent.click(await screen.findByRole("button", { name: "特定の会話を探す" }));

    await waitFor(() => expect(chatBodies().length).toBe(2));
    expect(chatBodies()[1]?.["message"]).toBe("特定の会話を探したい");
  });

  it("会話の履歴のチップ提示中は他のカテゴリーへ切り替えられない", async () => {
    mockAgentSequential([{ reply: "今週も順調です。", actions: [] }]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /会話の履歴/ }));
    await screen.findByRole("button", { name: "最近の会話を点検する" });

    expect((screen.getByRole("button", { name: /知識データ/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /対応中の会話/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("会話の履歴を連打してもチップメッセージが積み上がらない", async () => {
    mockAgentSequential([{ reply: "今週も順調です。", actions: [] }]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /会話の履歴/ }));
    await screen.findByRole("button", { name: "最近の会話を点検する" });
    fireEvent.click(screen.getByRole("button", { name: /会話の履歴/ }));

    expect(screen.getAllByRole("button", { name: "最近の会話を点検する" }).length).toBe(1);
  });

  it("7カテゴリー全てがレールに表示される", async () => {
    mockAgentSequential([{ reply: "今週も順調です。", actions: [] }]);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    for (const label of ["アシスタント", "今週のまとめ", "対応中の会話", "会話の履歴", "知識データ", "指示ルール", "アバター"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
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
    // バッジはカテゴリーボタンの中に出る(独立した要素ではない)。
    // escalationsバッジは「対応中の会話」カテゴリーに付く(「会話の履歴」からは移した)。
    expect(screen.getByRole("button", { name: /知識データ/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /対応中の会話/ }).textContent).toContain("2");
  });

  it("「会話の履歴」カテゴリーにはescalationsバッジが付かない", async () => {
    mockBadges({
      gaps: { count: 0 },
      escalations: { escalations: [{ id: "e1" }, { id: "e2" }] },
    });
    renderPage();

    await screen.findByLabelText("対応中の会話 2件");
    expect(screen.getByRole("button", { name: /会話の履歴/ }).textContent).not.toContain("2");
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

  // GID: weeklySummary カードは複数フィールドが null になり得る構造(部分失敗を反映するため)。
  // sessionStorage への JSON.stringify → 復元後の描画という往復で、null を含むネストが
  // 壊れずに残ること、かつ復元されたカードは(取得した日と同じでない限り)鮮度が古いと
  // 表示されることを確認する。
  it("weeklySummaryカードを含む会話を復元しても、null混じりのフィールドが壊れず描画される", async () => {
    vi.mocked(restoreChatSession).mockReturnValue({
      sessionId: "restored-session-id",
      messages: [
        { id: 201, role: "me", text: "今週の状況を教えて" },
        {
          id: 202,
          role: "ai",
          card: {
            kind: "weeklySummary",
            asOf: "2020-01-01T00:00:00.000Z",
            sessions: { total: 12, changePct: null, prevTotal: 0 },
            avgScore: null,
            conversions: null,
            faq: { total: 3, published: 3, lastUpdated: null },
            pendingTuningRules: null,
            gaps: null,
          },
        },
      ],
      history: [],
    });

    renderPage();

    expect(await screen.findByText("12件")).toBeTruthy();
    // ラベルと値は別divなので、それぞれ別のテキストノードとして検証する
    expect(screen.getByText("FAQ")).toBeTruthy();
    expect(screen.getByText("3件（公開3件）")).toBeTruthy();
    // avgScore/conversions/pendingTuningRules/gaps が null のため、それらの欄は描画されない
    expect(screen.queryByText(/\/100/)).toBeNull();
    expect(screen.queryByText("承認待ちの指示ルール")).toBeNull();
    // 復元された古いasOfにより、鮮度の注記が出る
    expect(screen.getByText(/別の日に取得した内容です/)).toBeTruthy();
  });

  // GID: restoreChatSession/saveChatSession はこのファイルでモック化されているため、
  // 実際のテナント一致検証ロジックは chatSessionStore.test.ts で検証済み。ここでは
  // ページ側が正しい tenantId を引数として渡していること(配線)だけを確認する。
  it("復元・保存の呼び出しに現在のscopedTenantIdを渡す(別テナントの会話を誤って復元しないための前提)", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      return mockOk({ reply: "今週も順調です。", actions: [] });
    });

    renderPage({ ...SUPER_ADMIN_IN_PREVIEW, previewTenantId: "tenant-scope-check" });

    await waitFor(() => expect(vi.mocked(restoreChatSession)).toHaveBeenCalledWith(
      CHAT_SESSION_SURFACE_FULLSCREEN,
      "tenant-scope-check",
    ));
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(vi.mocked(saveChatSession)).toHaveBeenCalledWith(
      CHAT_SESSION_SURFACE_FULLSCREEN,
      expect.objectContaining({ tenantId: "tenant-scope-check" }),
    ));
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

  // GID: 起動時ブリーフィング(BOOTSTRAP_PROMPT)と左レール「今週のまとめ」クリックは
  // 同一ツール(get_weekly_briefing)に着地する前提(「必ず再取得する」で統一、重複は
  // 許容する設計)。起動時は「ログインしたところです。」という挨拶が前置されるが、
  // 実際に状況を尋ねる依頼文の核("今週の状況を教えてください。要点と次にやるべき
  // ことを最大3つまで、簡潔に教えてください。")は完全一致でなければならない。
  // この2箇所は別々の文字列リテラルとして存在するため、片方だけ表現を直すと
  // 定義が黙って割れる。核の一致を固定してその再発を防ぐ。
  it("起動時ブリーフィングと「今週のまとめ」クリックは同一の依頼文の核を送る", async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /今週のまとめ/ }));
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    const chatBodies = vi
      .mocked(authFetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/admin/agent/chat"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

    expect(chatBodies.length).toBeGreaterThanOrEqual(2);
    const [bootstrapMessage, categoryClickMessage] = chatBodies.map((b) => String(b.message));
    const core = "今週の状況を教えてください。要点と次にやるべきことを最大3つまで、簡潔に教えてください。";
    expect(categoryClickMessage).toBe(core);
    expect(bootstrapMessage.endsWith(core)).toBe(true);
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

// GID: super_adminがプレビュー中に別テナントへ切り替えても、bootstrapped(useRef)が
// needsTenantSelectionのみをキーにしており previewMode のままでは再評価されないため、
// 会話スレッド(weeklySummaryカードを含む)が前テナントのまま残っていた。修正の回帰テスト。
describe("CopilotPreviewPage — テナント切替時の会話リセット", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockNavigate.mockReset();
  });

  it("previewMode中に別テナントへ切り替えると、会話がリセットされ新テナントのブリーフィングが取り直される", async () => {
    let currentTenant = "tenant-a";
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (String(url).includes("/v1/admin/agent/chat")) {
        return mockOk({ reply: `${currentTenant}の状況です。`, actions: [] });
      }
      return mockOk({});
    });

    const { rerender } = renderPage({ ...SUPER_ADMIN_IN_PREVIEW, previewTenantId: "tenant-a" });
    await waitFor(() => expect(screen.getByText("tenant-aの状況です。")).toBeTruthy());

    const callsBeforeSwitch = vi.mocked(authFetch).mock.calls.filter(([url]) =>
      String(url).includes("/v1/admin/agent/chat"),
    ).length;

    // 別テナントへ切替(previewTenantIdのみ変化。previewMode/isSuperAdminは維持)
    currentTenant = "tenant-b";
    vi.mocked(useAuth).mockReturnValue(
      baseAuth({ ...SUPER_ADMIN_IN_PREVIEW, previewTenantId: "tenant-b" }),
    );
    rerender(
      <MemoryRouter>
        <CopilotPreviewPage />
      </MemoryRouter>,
    );

    // 新テナントのブリーフィングが自動的に取り直される(手動操作不要)
    await waitFor(() => expect(screen.getByText("tenant-bの状況です。")).toBeTruthy());
    // 前テナントの応答は会話から消えている(リセットされた証拠)
    expect(screen.queryByText("tenant-aの状況です。")).toBeNull();

    const callsAfterSwitch = vi.mocked(authFetch).mock.calls.filter(([url]) =>
      String(url).includes("/v1/admin/agent/chat"),
    ).length;
    expect(callsAfterSwitch).toBeGreaterThan(callsBeforeSwitch);
  });

  it("同じテナントのままの再レンダーでは会話をリセットしない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      return mockOk({ reply: "今週も順調です。", actions: [] });
    });

    const { rerender } = renderPage(SUPER_ADMIN_IN_PREVIEW);
    await waitFor(() => expect(screen.getByText("今週も順調です。")).toBeTruthy());

    const callsBefore = vi.mocked(authFetch).mock.calls.length;

    // previewTenantIdが変わらない通常の再レンダー(例: 他stateの更新に伴う再描画)
    vi.mocked(useAuth).mockReturnValue(baseAuth(SUPER_ADMIN_IN_PREVIEW));
    rerender(
      <MemoryRouter>
        <CopilotPreviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("今週も順調です。")).toBeTruthy();
    expect(vi.mocked(authFetch).mock.calls.length).toBe(callsBefore);
  });

  // GID: 連続テナント切替のレース。1回目の切替(tenant-b)の応答待ち中に2回目の切替
  // (tenant-c)が発生すると、修正前は(a) sendReal の sending ガードにより2回目の
  // 再取得が無言でドロップされ、(b) 後から届いた1回目の応答が2回目の会話に紛れ込んで
  // 表示されていた。世代カウンタ(requestEpochRef)による回帰テスト。
  it("切替の応答待ち中にさらに切替が発生しても、古い応答は表示されず新しい切替が必ず反映される", async () => {
    let resolveTenantB: (v: Response) => void = () => {};
    let chatCallCount = 0;

    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (isBadgeUrl(url)) return mockEmptyBadges();
      if (!String(url).includes("/v1/admin/agent/chat")) return mockOk({});
      chatCallCount += 1;
      if (chatCallCount === 1) {
        // 起動時ブリーフィング(tenant-a)
        return mockOk({ reply: "tenant-aの状況です。", actions: [] });
      }
      if (chatCallCount === 2) {
        // tenant-b への切替: 応答が遅延する(手動で解決するまで保留)
        return new Promise<Response>((resolve) => { resolveTenantB = resolve; });
      }
      // tenant-c への切替: 即座に解決する
      return mockOk({ reply: "tenant-cの状況です。", actions: [] });
    });

    const { rerender } = renderPage({ ...SUPER_ADMIN_IN_PREVIEW, previewTenantId: "tenant-a" });
    await waitFor(() => expect(screen.getByText("tenant-aの状況です。")).toBeTruthy());

    // tenant-b へ切替(応答は遅延したまま)
    vi.mocked(useAuth).mockReturnValue(baseAuth({ ...SUPER_ADMIN_IN_PREVIEW, previewTenantId: "tenant-b" }));
    rerender(<MemoryRouter><CopilotPreviewPage /></MemoryRouter>);
    await waitFor(() => expect(chatCallCount).toBe(2));

    // tenant-b の応答が届く前に、さらに tenant-c へ切替
    vi.mocked(useAuth).mockReturnValue(baseAuth({ ...SUPER_ADMIN_IN_PREVIEW, previewTenantId: "tenant-c" }));
    rerender(<MemoryRouter><CopilotPreviewPage /></MemoryRouter>);
    await waitFor(() => expect(chatCallCount).toBe(3));

    // tenant-c の応答が表示される(sending guardに阻まれず必ず発火する)
    await waitFor(() => expect(screen.getByText("tenant-cの状況です。")).toBeTruthy());
    // 送信可能状態(sending=false)に戻っている
    await waitFor(() => expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false));

    // 遅延していた tenant-b の応答が今さら届いても、画面には一切反映されない
    resolveTenantB({ ok: true, status: 200, json: () => Promise.resolve({ reply: "tenant-bの状況です。", actions: [] }) } as unknown as Response);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("tenant-bの状況です。")).toBeNull();
    expect(screen.getByText("tenant-cの状況です。")).toBeTruthy();
    // 送信可能状態も壊れていない(遅れてきたtenant-bの完了処理がsendingを誤って書き換えていない)
    expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(false);
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

  // GID 1217040818410419: 書籍/PDF取り込みはR2C運用限定になったため、投入が実際に始まる系の
  // テストは(previewMode中の)super_adminで行う。client_adminの拒否は専用describeで検証する。
  it("PDFを落とすと旧UIと同じ既存エンドポイントへ送信が始まる(新APIを作らない)", async () => {
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    const xhr = MockXHR.instances[0]!;
    expect(xhr.open).toHaveBeenCalledWith(
      "POST",
      "http://localhost:3100/v1/admin/knowledge/book-pdf?tenant=tenant-preview",
    );
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
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

    dropFiles([makeFile("メモ.txt", "text/plain")]);

    expect(await screen.findByText("PDFを受け取れませんでした")).toBeTruthy();
    expect(screen.getByText("PDFファイル（またはPDFをまとめたZIPファイル）を送ってください。")).toBeTruthy();
    expect(MockXHR.instances.length).toBe(0);
  });

  it("上限を超えるPDFは通信する前に断る", async () => {
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

    dropFiles([makeFile("大きい資料.pdf", "application/pdf", 11 * 1024 * 1024)]);

    expect(await screen.findByText("PDFは1ファイル10MBまでです。分割してから送ってみてください。")).toBeTruthy();
    expect(MockXHR.instances.length).toBe(0);
  });

  it("通信に失敗してもチャットは壊れず、そのまま次のメッセージを送れる", async () => {
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

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
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0]!.fireLoad(401, { error: "unauthorized" });

    expect(
      await screen.findByText("ログインの有効期限が切れたようです。もう一度ログインしてからお試しください。"),
    ).toBeTruthy();
    expect(screen.queryByText(/unauthorized/)).toBeNull();
  });

  it("成功すると成功カードが出て、他の書き込み操作と同じく実操作の件数に加算される", async () => {
    await readyPage(SUPER_ADMIN_IN_PREVIEW);
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
    await readyPage(SUPER_ADMIN_IN_PREVIEW);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(screen.getByLabelText("PDFを添付")).toBeTruthy();
    fireEvent.change(input, { target: { files: [makeFile("料金表.pdf", "application/pdf")] } });

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    expect(await screen.findByText("PDFを受け取っています")).toBeTruthy();
  });
});

// GID 1217040818410419: 「書籍/PDFはR2C運用限定」の実装反映。テナント(client_admin)からの
// D&D/添付ボタンからの受付を役割で条件化する。previewMode中のsuper_adminは従来通り成功すること
// は上のdescribe(SUPER_ADMIN_IN_PREVIEW を使う各テスト)で既に固定済み。
describe("CopilotPreviewPage — PDF取り込みのR2C運用限定ガード(client_admin)", () => {
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

  it("client_adminがPDFを落としても通信せず、優しい日本語で断る", async () => {
    await readyPage();

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);

    expect(await screen.findByText("PDFを受け取れませんでした")).toBeTruthy();
    expect(
      screen.getByText("この機能は現在ご利用いただけません。内容を文章で教えていただければ、代わりに登録いたします。"),
    ).toBeTruthy();
    expect(MockXHR.instances.length).toBe(0);
    // 専門用語(ステータスコード/権限/MIME等)や、他の場所で誤ってblocked計測に載る文言を出さない
    expect(screen.queryByText(/403|権限|MIME/)).toBeNull();
    expect(screen.queryByText(/確認が必要です|確認をスキップできません/)).toBeNull();
  });

  it("client_adminが📎ボタンから選んでも同様に断る", async () => {
    await readyPage();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile("料金表.pdf", "application/pdf")] } });

    expect(await screen.findByText("PDFを受け取れませんでした")).toBeTruthy();
    expect(MockXHR.instances.length).toBe(0);
  });

  it("断られても会話は壊れず、そのまま次のメッセージを送れる", async () => {
    await readyPage();

    dropFiles([makeFile("料金表.pdf", "application/pdf")]);
    await screen.findByText("PDFを受け取れませんでした");

    fireEvent.change(getComposer(), { target: { value: "営業時間を教えて" } });
    fireEvent.click(screen.getByLabelText("送信"));
    expect(await screen.findByText("営業時間を教えて")).toBeTruthy();
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
