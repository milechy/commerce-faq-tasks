// 禁止事項21(CLAUDE.md): 500を「テナントが見つかりませんでした」と誤表示しない回帰テスト。
// このページ独自の authFetch(supabase由来のトークン + 生fetch)と、
// ApiKeysTab.fetchApiKeys が使う lib/api の authFetch の両方をモックする必要がある。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Route, Routes } from "react-router-dom";
import TenantDetailPage from "./[id]";

const mockGetSession = vi.fn();

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      refreshSession: () => Promise.resolve({ data: { session: null } }),
    },
  },
}));

vi.mock("../../../auth/useAuth", () => ({
  useAuth: () => ({ enterPreview: vi.fn(), isSuperAdmin: true }),
}));

const mockApiKeysAuthFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  authFetch: (...args: unknown[]) => mockApiKeysAuthFetch(...args),
  API_BASE: "http://localhost:3100",
}));

// LangProvider は localStorage.getItem に依存し、このテスト環境の Node組み込み
// localStorage（--localstorage-file 未指定時は undefined）で例外になるため、
// 実辞書(ja.ts)をそのまま使う t() を返す薄いモックに置き換える
// (KnowledgeListTab.test.tsx / PdfUploadTab.test.tsx / escalations/[sessionId].test.tsx
//  と同じ既存パターン。このファイルは元々 <LangProvider> を直接使っていたため、
//  この環境では全ケースが localStorage 例外でマウント時に落ちていた)。
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
  const stableValue = { lang: "ja" as const, setLang: () => {}, t: stableT };
  return {
    useLang: () => stableValue,
  };
});

const okSession = { data: { session: { access_token: "test-token" } } };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function renderPage(tenantId = "carnation") {
  return render(
    <MemoryRouter initialEntries={[`/admin/tenants/${tenantId}`]}>
      <Routes>
        <Route path="/admin/tenants/:id" element={<TenantDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TenantDetailPage — エラー意味論(500 vs 404 vs 401)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetSession.mockReset().mockResolvedValue(okSession);
    mockApiKeysAuthFetch.mockReset().mockResolvedValue(jsonResponse(200, { keys: [] }));
  });

  it("200のとき: タブが描画される", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "carnation", name: "carnation", plan: "starter", is_active: true,
        allowed_origins: [], billing_enabled: false, billing_free_from: null,
        billing_free_until: null, features: { avatar: false, voice: false, rag: true },
        lemonslice_agent_id: null, conversion_types: [],
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("⚙️ 設定")).toBeTruthy());
    expect(screen.queryByText(/テナントが見つかりませんでした/)).toBeNull();
    expect(screen.queryByText(/読み込みに失敗しました/)).toBeNull();
  });

  it("404のとき: 「テナントが見つかりませんでした」を表示し、再試行ボタンは出さない", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not_found" }));

    renderPage();

    // ヘッダーのタイトルと本文の空状態の両方に出るため getAllByText で許容する
    await waitFor(() => expect(screen.getAllByText(/テナントが見つかりませんでした/).length).toBeGreaterThan(0));
    expect(screen.queryByText("やり直す")).toBeNull();
  });

  it("500のとき: 「テナントが見つかりませんでした」を表示せず、読み込み失敗+再試行ボタンを出す", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, { error: "取得に失敗しました" }));

    renderPage();

    await waitFor(() => expect(screen.getAllByText(/読み込みに失敗しました/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/テナントが見つかりませんでした/)).toBeNull();
    expect(screen.getByText("やり直す")).toBeTruthy();
  });

  it("500の後に再試行ボタンを押すと再取得し、成功すればタブが描画される", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "取得に失敗しました" }))
      .mockResolvedValue(
        jsonResponse(200, {
          id: "carnation", name: "carnation", plan: "starter", is_active: true,
          allowed_origins: [], billing_enabled: false, billing_free_from: null,
          billing_free_until: null, features: { avatar: false, voice: false, rag: true },
          lemonslice_agent_id: null, conversion_types: [],
        }),
      );
    global.fetch = fetchMock;

    renderPage();

    await waitFor(() => expect(screen.getByText("やり直す")).toBeTruthy());
    screen.getByText("やり直す").click();

    await waitFor(() => expect(screen.getByText("⚙️ 設定")).toBeTruthy());
  });

  // イレギュラー操作: 「やり直す」の連打で、in-flightの古いレスポンスが後から
  // 新しい状態を上書きしないか(handleRetryLoad は reloadKey をインクリメントする
  // だけで、AbortController等による古いリクエストの無効化は行っていない)。
  // 検証の結果: loading=true の間は再試行ボタン自体がロード中表示に置き換わり
  // 画面から消えるため、ユーザー操作としての「連打」はそもそも起こせない
  // (直前のリクエストが確定するまで次のクリックが物理的にできない)。
  // したがって setState の実行順に依存する競合は実際には発生しない。
  // この「loadingがボタンを隠すことによる暗黙のガード」が壊れていないことを固定する。
  it("読み込み中は「やり直す」ボタンが画面から消え、二重にクリックできない", async () => {
    let resolveFirst: ((r: Response) => void) | null = null;
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(jsonResponse(500, { error: "取得に失敗しました" }));
      }
      // 1回目の「やり直す」: 解決を止めて loading 中の画面を観測する
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("やり直す")).toBeTruthy());

    screen.getByText("やり直す").click();

    // loading 中は再試行ボタンが消え、ロード中の表示に置き換わる
    await waitFor(() => expect(screen.queryByText("やり直す")).toBeNull());
    expect(screen.getByText(/読み込んでいます/)).toBeTruthy();

    resolveFirst?.(
      jsonResponse(200, {
        id: "carnation", name: "carnation", plan: "starter", is_active: true,
        allowed_origins: [], billing_enabled: false, billing_free_from: null,
        billing_free_until: null, features: { avatar: false, voice: false, rag: true },
        lemonslice_agent_id: null, conversion_types: [],
      }),
    );
    await waitFor(() => expect(screen.getByText("⚙️ 設定")).toBeTruthy());
    expect(global.fetch).toHaveBeenCalledTimes(2); // 初回 + やり直す1回のみ
  });

  it("401(未ログイン)のとき: 既存どおり /login へ遷移する(挙動を変えない)", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    global.fetch = vi.fn();

    render(
      <MemoryRouter initialEntries={["/admin/tenants/carnation"]}>
        <Routes>
          <Route path="/admin/tenants/:id" element={<TenantDetailPage />} />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("login-page")).toBeTruthy());
  });
});
