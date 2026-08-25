// GID 1217808301732050: 会話詳細ページのJudge欄が「未評価」「取得失敗」を
// 区別せずどちらも同じ表示になっていた不具合の回帰テスト。
// 併せて、評価取得が単一のエンドポイント（現行の /v1/admin/evaluations/:sessionId）
// のみを叩くこと（第2の廃止エンドポイントを叩かないこと）も検証する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import ChatHistorySessionPage from "./[sessionId]";
import { useAuth } from "../../../auth/useAuth";
import { authFetch } from "../../../lib/api";
import { createAuthMock } from "../../../test/authMock";

vi.mock("../../../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ t: (k: string) => k, lang: "ja" }),
}));

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const SUPER_ADMIN = createAuthMock({
  user: { id: "1", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
  isSuperAdmin: true,
});

const EVALUATION = {
  id: 1,
  overall_score: 85,
  score: 85,
  evaluated_at: "2026-01-01T00:00:00Z",
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/chat-history/sess-1"]}>
      <Routes>
        <Route path="/admin/chat-history/:sessionId" element={<ChatHistorySessionPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatHistorySessionPage — Judge欄「未評価」/「取得失敗」の区別", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN);
    vi.mocked(authFetch).mockReset();
  });

  it("評価あり: スコア入りで描画される", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        return Promise.resolve(jsonResponse(200, { evaluations: [EVALUATION], total: 1 }) as unknown as Response);
      }
      if (url.includes("/messages")) {
        return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
      }
      return Promise.resolve(jsonResponse(200, {}) as unknown as Response);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/総合スコア 85\/100/)).toBeTruthy();
    });
    expect(screen.queryByText("未評価")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("評価なし(200+空配列): 「未評価」と表示し、失敗扱いにしない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        return Promise.resolve(jsonResponse(200, { evaluations: [], total: 0 }) as unknown as Response);
      }
      if (url.includes("/messages")) {
        return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
      }
      return Promise.resolve(jsonResponse(200, {}) as unknown as Response);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("未評価")).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("取得失敗(500): 「未評価」ではなく取得失敗のバナー(role=alert)を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        return Promise.resolve(jsonResponse(500, { error: "評価データの取得に失敗しました" }) as unknown as Response);
      }
      if (url.includes("/messages")) {
        return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
      }
      return Promise.resolve(jsonResponse(200, {}) as unknown as Response);
    });

    renderPage();

    await waitFor(() => {
      // 共通の LoadErrorBanner(role="alert" + 再試行ボタン)で出す
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/読み込めませんでした/)).toBeTruthy();
    });
    expect(screen.queryByText("未評価")).toBeNull();
  });

  it("評価取得は単一のエンドポイントのみを叩く（第2の呼び出し先を作らない）", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        return Promise.resolve(jsonResponse(200, { evaluations: [], total: 0 }) as unknown as Response);
      }
      if (url.includes("/messages")) {
        return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
      }
      return Promise.resolve(jsonResponse(200, {}) as unknown as Response);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("未評価")).toBeTruthy();
    });

    const evaluationCalls = vi
      .mocked(authFetch)
      .mock.calls.map(([url]) => url as string)
      .filter((url) => url.includes("/evaluations/"));
    expect(evaluationCalls).toEqual([
      "http://localhost:3100/v1/admin/evaluations/sess-1",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// コードレビュー(2026-08-25)で見つかった実バグの回帰テスト。
// catch が setEvaluation(null) を呼んでいなかったため、セッションを切り替えて
// 次の取得が reject すると「前の会話のスコアが別の会話の画面に残る」状態だった。
// 取得失敗の表示も出ないため、古い数字が正しい値として読まれてしまう。
// このPRが実装した「未評価 vs 取得失敗」の区別そのものを無効化する不具合。
// ───────────────────────────────────────────────────────────────────────────
describe("ChatHistorySessionPage — 取得失敗時に前のセッションのスコアを残さない", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN);
    vi.mocked(authFetch).mockReset();
  });

  it("authFetchがreject(ネットワーク断・セッション期限切れ)しても、古いスコアが残らない", async () => {
    // 同一のReactツリーのままURLだけを切り替える(unmountすると state が
    // 作り直されてしまい、この不具合＝stateの持ち越しを再現できない)。
    let call = 0;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        call += 1;
        if (call === 1) {
          return Promise.resolve(jsonResponse(200, { evaluations: [EVALUATION], total: 1 }) as unknown as Response);
        }
        return Promise.reject(new Error("__AUTH_REQUIRED__"));
      }
      return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
    });

    // MemoryRouter の initialEntries に2件入れ、navigate で2件目へ遷移する。
    // Routes/Route は同じなので ChatHistorySessionPage インスタンスは再利用され、
    // sessionId だけが変わる = 実際のユーザー操作と同じ経路。
    const Nav = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/admin/chat-history/sess-2")}>go</button>;
    };
    render(
      <MemoryRouter initialEntries={["/admin/chat-history/sess-1"]}>
        <Nav />
        <Routes>
          <Route path="/admin/chat-history/:sessionId" element={<ChatHistorySessionPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/総合スコア 85\/100/)).toBeTruthy());

    fireEvent.click(screen.getByText("go"));
    // waitFor は「いずれ条件を満たす」まで待つため、"遷移直後に古い値が残る"
    // という不具合を見逃す。fetch が reject し終えるまで待ってから1回だけ判定する。
    await new Promise((r) => setTimeout(r, 300));

    // 前セッションのスコアが残っていないこと(ここが本丸)
    expect(screen.queryByText(/総合スコア 85\/100/)).toBeNull();
    // かつ、取得に失敗したことが表示されていること
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("取得失敗時は再試行導線を出す（リロードしか手が無い状態を残さない）", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        return Promise.reject(new Error("network"));
      }
      return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
    });

    renderPage();

    // LoadErrorBanner は role="alert" と再試行ボタンを持つ
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: /common\.retry|再試行/ })).toBeTruthy();
  });

  it("取得失敗のバナーはハードコード色を使わない（ライトテーマで判読不能にしない）", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/v1/admin/evaluations/")) {
        return Promise.reject(new Error("network"));
      }
      return Promise.resolve(jsonResponse(200, { messages: [] }) as unknown as Response);
    });

    renderPage();

    const alert = await waitFor(() => screen.getByRole("alert"));
    const style = alert.getAttribute("style") ?? "";
    // LoadErrorBanner が使う --destructive-* トークンであること
    expect(style).toContain("--destructive");
    // 旧実装のハードコード色(LoadErrorBannerが名指しで警告している配色)でないこと
    expect(style).not.toContain("248");
  });
});
