// admin-ui/src/pages/admin/escalations/[sessionId].test.tsx
// エスカレーション詳細: 「本文0件」を赤帯エラーとして出さないこと、
// 「セッション不在(404)」「サーバ障害(500)」は従来どおりエラー表示することを固定する。
// (CLAUDE.md 20: 「存在しない」と「空」を同じ値で表現しない — 対応中の会話253件が
//  全件404だった不具合の回帰テスト)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  // CLAUDE.md 禁止事項2: IME/Enter判定を手書きしない。この重複は過去に
  // 13日間の実バグを産んでいる。返信先はエンドユーザー(お客様)であり、
  // 変換途中の文字列が送信されると取り消せない。
  it("IME変換中のEnterでは送信されない(変換確定のEnterを誤送信しない)", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

    renderPage();
    await screen.findByText(/まだお客様の発言がありません/);

    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "へんかんちゅう" } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    // 送信APIが叩かれていないこと(初回ロードの1回だけ)
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });

  it("IME変換確定後のEnterでは送信される", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

    renderPage();
    await screen.findByText(/まだお客様の発言がありません/);

    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "担当します" } });
    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    // 初回ロード(1回) + 返信POST(1回)
    await vi.waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2));
  });

  it("Shift+Enterでは送信されず改行として扱われる(既存挙動を維持)", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

    renderPage();
    await screen.findByText(/まだお客様の発言がありません/);

    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "1行目" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });

  // ── イレギュラー操作: 連打・多重送信 ──────────────────────────────────
  it("「対応完了にする」を連打しても対応完了リクエストは1回しか送られない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).endsWith("/resolve-escalation")) {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      return Promise.resolve(jsonResponse(200, { messages: [], total: 0 }));
    });

    renderPage();
    await screen.findByText(/まだお客様の発言がありません/);

    const resolveButton = screen.getByRole("button", { name: /対応完了にする/ });
    fireEvent.click(resolveButton);
    fireEvent.click(resolveButton); // 連打
    fireEvent.click(resolveButton);

    await waitFor(() => {
      const resolveCalls = vi
        .mocked(authFetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/resolve-escalation"));
      expect(resolveCalls.length).toBe(1);
    });
  });

  it("送信ボタンを連打しても、送信中は2件目の返信が送られない", async () => {
    let replyCalls = 0;
    let resolveReplyPromise: (() => void) | null = null;
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).endsWith("/reply")) {
        replyCalls += 1;
        // 1件目の返信POSTを人為的に「送信中」のまま止め、連打の窓を作る
        return new Promise((resolve) => {
          resolveReplyPromise = () => resolve(jsonResponse(201, { ok: true }));
        });
      }
      return Promise.resolve(jsonResponse(200, { messages: [], total: 0 }));
    });

    renderPage();
    await screen.findByText(/まだお客様の発言がありません/);

    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/);
    fireEvent.change(textarea, { target: { value: "少々お待ちください" } });
    const sendButton = screen.getByRole("button", { name: "送信" });
    fireEvent.click(sendButton);
    // 送信中はボタンが無効化され、連打しても2件目のPOSTが飛ばない
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    await waitFor(() => expect(replyCalls).toBe(1));
    resolveReplyPromise?.();
  });

  // ── イレギュラー操作: 空白のみの入力 ────────────────────────────────
  it("空白のみの返信は送信ボタンが無効のままで、送信されない", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

    renderPage();
    await screen.findByText(/まだお客様の発言がありません/);

    const textarea = screen.getByPlaceholderText(/お客様への返信を入力してください/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });

    const sendButton = screen.getByRole("button", { name: "送信" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.click(sendButton);
    // 初回ロードの1回のみ(送信POSTは飛んでいない)
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });

  // ── イレギュラー操作: 画面離脱後にポーリングが続かない ──────────────
  describe("ポーリングのライフサイクル", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("画面を離れる(アンマウント)と、以降の5秒ポーリングは発火しない", async () => {
      vi.useFakeTimers();
      vi.mocked(authFetch).mockResolvedValue(jsonResponse(200, { messages: [], total: 0 }));

      const { unmount } = renderPage();
      await vi.waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1));

      unmount();

      await vi.advanceTimersByTimeAsync(20_000); // 5秒間隔を4回分進める
      expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1); // 増えていない
    });

    it("画面を開いたままだと、5秒ごとに新着メッセージを自動取得して表示する(ユーザー操作なし)", async () => {
      vi.useFakeTimers();
      vi.mocked(authFetch)
        .mockResolvedValueOnce(jsonResponse(200, { messages: [], total: 0 })) // 初回
        .mockResolvedValueOnce(
          jsonResponse(200, {
            messages: [
              { id: "m1", role: "user", content: "追加で質問です", metadata: {}, created_at: "2026-08-10T00:00:00Z" },
            ],
            total: 1,
          }),
        ); // 1回目のポーリングで新着

      renderPage();
      await vi.waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(5_000);

      await vi.waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2));
      expect(screen.getByText("追加で質問です")).toBeTruthy();
    });
  });

  // ── ネットワーク例外(非ok応答ではなく fetch 自体が reject するケース) ──
  it("fetch自体が例外を投げても(オフライン等)、生の例外メッセージを出さず同じ案内文になる", async () => {
    vi.mocked(authFetch).mockRejectedValue(new TypeError("Failed to fetch"));

    renderPage();

    const errorBanner = await screen.findByText(/失敗しました/);
    expect(errorBanner.textContent).not.toMatch(/TypeError|Failed to fetch/);
  });
});
