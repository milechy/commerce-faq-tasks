// admin-ui/src/pages/admin/escalations/[sessionId].test.tsx
// エスカレーション詳細: 「本文0件」を赤帯エラーとして出さないこと、
// 「セッション不在(404)」「サーバ障害(500)」は従来どおりエラー表示することを固定する。
// (CLAUDE.md 20: 「存在しない」と「空」を同じ値で表現しない — 対応中の会話253件が
//  全件404だった不具合の回帰テスト)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import EscalationDetailPage from "./[sessionId]";
import { authFetch } from "../../../lib/api";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

// LangProvider は localStorage.getItem に依存し、このテスト環境の Node組み込み
// localStorage（--localstorage-file 未指定時は undefined）で例外になるため、
// 実辞書(ja.ts)をそのまま使う t() を返す薄いモックに置き換える
// (KnowledgeListTab.test.tsx / PdfUploadTab.test.tsx と同じ既存パターン)。
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

function renderPage(sessionId = "sess-uuid-1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/escalations/${sessionId}`]}>
      <Routes>
        <Route path="/admin/escalations/:sessionId" element={<EscalationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("EscalationDetailPage", () => {
  it("本文が3件あれば会話が表示される", async () => {
    vi.mocked(authFetch).mockResolvedValue(
      jsonResponse(200, {
        messages: [
          { id: "m1", role: "user", content: "こんにちは", metadata: {}, created_at: "2026-08-10T00:00:00Z" },
          { id: "m2", role: "assistant", content: "いらっしゃいませ", metadata: {}, created_at: "2026-08-10T00:00:01Z" },
          { id: "m3", role: "operator", content: "担当します", metadata: {}, created_at: "2026-08-10T00:00:02Z" },
        ],
        total: 3,
      }),
    );

    renderPage();

    expect(await screen.findByText("こんにちは")).toBeTruthy();
    expect(screen.queryByText(/失敗しました/)).toBeNull();
    expect(screen.queryByText(/まだお客様の発言がありません/)).toBeNull();
  });

  it("本文0件(200)のとき赤帯エラーを出さず、空状態メッセージを表示する", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

    renderPage();

    expect(await screen.findByText(/まだお客様の発言がありません/)).toBeTruthy();
    expect(screen.queryByText(/失敗しました/)).toBeNull();
  });

  it("本文0件でも返信欄と対応完了ボタンは有効なまま", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

    renderPage();

    await screen.findByText(/まだお客様の発言がありません/);
    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/) as HTMLTextAreaElement;
    const resolveButton = screen.getByRole("button", { name: /対応完了にする/ }) as HTMLButtonElement;
    expect(textarea.disabled).toBe(false);
    expect(resolveButton.disabled).toBe(false);
  });

  it("セッション不在(404)のときはエラー表示される(空状態にしない)", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(404, { error: "セッションが見つかりません" }));

    renderPage("nonexistent");

    expect(await screen.findByText(/失敗しました/)).toBeTruthy();
    expect(screen.queryByText(/まだお客様の発言がありません/)).toBeNull();
  });

  it("サーバ障害(500)のときもエラー表示される", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(500, { error: "取得に失敗しました" }));

    renderPage();

    expect(await screen.findByText(/失敗しました/)).toBeTruthy();
  });

  it("返信送信 → 再取得で operator メッセージが表示され、空状態表示が消える", async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(200, { messages: [], total: 0 })) // 初回ロード: 空
      .mockResolvedValueOnce(jsonResponse(201, { ok: true })) // 返信POST
      .mockResolvedValue(
        jsonResponse(200, {
          messages: [
            { id: "m1", role: "operator", content: "担当します", metadata: {}, created_at: "2026-08-10T00:00:00Z" },
          ],
          total: 1,
        }),
      ); // 再取得

    renderPage();

    await screen.findByText(/まだお客様の発言がありません/);

    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/);
    fireEvent.change(textarea, { target: { value: "担当します" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    expect(await screen.findByText("担当します")).toBeTruthy();
    expect(screen.queryByText(/まだお客様の発言がありません/)).toBeNull();
  });
});
