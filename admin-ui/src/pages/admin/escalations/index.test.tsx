// admin-ui/src/pages/admin/escalations/index.test.tsx
// GID 1217808492496192: 対応中の会話一覧から e2e/内部テスト由来を既定で除外する
// source フィルタの回帰テスト。既定リクエストに source パラメータを付けない
// (サーバー既定の 'user' と一致させるため)ことと、「すべて」選択時に
// source=all を送ることを固定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import EscalationsPage from "./index";
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

const CLIENT_ADMIN = createAuthMock({
  user: { id: "1", email: "admin@example.com", role: "client_admin", tenantId: "tenant-a", tenantName: "Tenant A" },
  isClientAdmin: true,
});

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function renderPage() {
  return render(
    <MemoryRouter>
      <EscalationsPage />
    </MemoryRouter>,
  );
}

describe("EscalationsPage — source フィルタ(e2e除外)", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(CLIENT_ADMIN);
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({ escalations: [], total: 0 }));
  });

  it("初回読み込みは source パラメータを付けない(サーバー既定の'user'と一致させるため)", async () => {
    renderPage();

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalled();
    });
    const url = String(vi.mocked(authFetch).mock.calls[0]![0]);
    expect(url).toContain("/v1/admin/chat-history/escalations");
    expect(url).not.toContain("source=");
  });

  it("「すべて（テスト含む）」を選ぶと source=all を付けて再取得する", async () => {
    renderPage();
    await waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1));

    const select = screen.getByDisplayValue("実ユーザーのみ");
    fireEvent.change(select, { target: { value: "all" } });

    await waitFor(() => {
      const lastCall = vi.mocked(authFetch).mock.calls.at(-1);
      expect(String(lastCall![0])).toContain("source=all");
    });
  });

  it("source が 'user' 以外のエスカレーションにバッジを表示する(実ユーザーの会話にはバッジを出さない)", async () => {
    vi.mocked(authFetch).mockImplementation(() =>
      mockOk({
        escalations: [
          {
            id: "s-e2e",
            tenant_id: "tenant-a",
            session_id: "sess-e2e",
            escalated_at: "2026-08-20T00:00:00Z",
            last_message_at: "2026-08-20T00:00:00Z",
            message_count: 2,
            first_message_preview: "営業時間を教えてください",
            source: "e2e",
          },
        ],
        total: 1,
      }),
    );

    renderPage();

    expect(await screen.findByText("e2e")).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ユーザーがやりそうなイレギュラー操作（2026-08-25 テスト強化）
//
// この画面は「対応待ちを見落とさない」ためのもの。運用者は絞り込みを何度も
// 切り替え、通信が遅ければ待たずに次を押す。競合や取りこぼしを突く。
// ───────────────────────────────────────────────────────────────────────────
describe("EscalationsPage — イレギュラーな操作", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(CLIENT_ADMIN);
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({ escalations: [], total: 0 }));
  });

  it("絞り込みを all→user と戻すと、最後のリクエストは source を外した既定に戻る", async () => {
    renderPage();
    await waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1));

    const select = screen.getByDisplayValue("実ユーザーのみ");
    fireEvent.change(select, { target: { value: "all" } });
    await waitFor(() => expect(String(vi.mocked(authFetch).mock.calls.at(-1)![0])).toContain("source=all"));

    fireEvent.change(select, { target: { value: "user" } });
    await waitFor(() => {
      expect(String(vi.mocked(authFetch).mock.calls.at(-1)![0])).not.toContain("source=all");
    });
  });

  it("素早く連続で切り替えても、最終的な表示は最後に選んだ条件になる", async () => {
    renderPage();
    await waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1));

    const select = screen.getByDisplayValue("実ユーザーのみ");
    fireEvent.change(select, { target: { value: "all" } });
    fireEvent.change(select, { target: { value: "user" } });
    fireEvent.change(select, { target: { value: "all" } });

    await waitFor(() => {
      expect(String(vi.mocked(authFetch).mock.calls.at(-1)![0])).toContain("source=all");
    });
    expect((select as HTMLSelectElement).value).toBe("all");
  });

  it("APIが失敗しても画面が落ちず、対応待ちを0件と誤表示しない", async () => {
    vi.mocked(authFetch).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    );
    expect(() => renderPage()).not.toThrow();
    await waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalled());
    // 「対応待ちはありません」と言い切らない(取りこぼしに気付けなくなるため)
    await waitFor(() => {
      expect(screen.queryByText(/0 ?件/)).toBeNull();
    });
  });

  it("source が null(metadata未設定の古いセッション)でもバッジを出さない", async () => {
    vi.mocked(authFetch).mockImplementation(() =>
      mockOk({
        escalations: [
          {
            id: "s-old",
            tenant_id: "tenant-a",
            session_id: "sess-old",
            escalated_at: "2026-01-01T00:00:00Z",
            last_message_at: "2026-01-01T00:00:00Z",
            message_count: 2,
            first_message_preview: "返品したいです",
            source: null,
          },
        ],
        total: 1,
      }),
    );
    renderPage();
    const preview = await waitFor(() => screen.getByText("返品したいです"));
    // 絞り込みセレクトの<option>を拾わないよう、対象の行の中だけを見る
    const row = preview.closest("li,tr,div[role='listitem']") ?? preview.parentElement!;
    expect(row.textContent).not.toMatch(/e2e|テスト由来/i);
  });

  it("source が想定外の値でもバッジ表示だけで画面が壊れない", async () => {
    vi.mocked(authFetch).mockImplementation(() =>
      mockOk({
        escalations: [
          {
            id: "s-x",
            tenant_id: "tenant-a",
            session_id: "sess-x",
            escalated_at: "2026-08-20T00:00:00Z",
            last_message_at: "2026-08-20T00:00:00Z",
            message_count: 2,
            first_message_preview: "こんにちは",
            source: "unknown-future-value",
          },
        ],
        total: 1,
      }),
    );
    expect(() => renderPage()).not.toThrow();
    await waitFor(() => expect(screen.getByText("こんにちは")).toBeTruthy());
  });
})
