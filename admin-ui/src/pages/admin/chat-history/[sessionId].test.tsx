// GID 1217808301732050: 会話詳細ページのJudge欄が「未評価」「取得失敗」を
// 区別せずどちらも同じ表示になっていた不具合の回帰テスト。
// 併せて、評価取得が単一のエンドポイント（現行の /v1/admin/evaluations/:sessionId）
// のみを叩くこと（第2の廃止エンドポイントを叩かないこと）も検証する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
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
    expect(screen.queryByText(/取得に失敗しました/)).toBeNull();
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
    expect(screen.queryByText(/取得に失敗しました/)).toBeNull();
  });

  it("取得失敗(500): 「未評価」ではなく「取得に失敗しました」と表示する", async () => {
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
      expect(screen.getByText(/取得に失敗しました/)).toBeTruthy();
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
