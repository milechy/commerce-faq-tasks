// ウィジェットを表示しないページの設定 — client_adminによる自己設定
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ExcludedPagesSettings from "./ExcludedPagesSettings";

vi.mock("../../i18n/LangContext", async () => {
  const jaModule = await import("../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string, vars?: Record<string, string | number>) => {
    let text = ja[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    return text;
  };
  return { useLang: () => ({ lang: "ja" as const, setLang: () => {}, t: stableT }) };
});

const authFetchMock = vi.fn();
vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

function jsonRes(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

async function openPanel() {
  render(<ExcludedPagesSettings tenantId="tenant-abc" />);
  fireEvent.click(await screen.findByText("🚫 Widgetを表示しないページの設定"));
}

describe("ExcludedPagesSettings", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("既存のexcluded_page_patternsを読み込んで一覧表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/cart"] }));
    await openPanel();

    await waitFor(() => expect(screen.getByText("/cart")).toBeTruthy());
  });

  it("0件のときは警告ではなく中立な『すべてのページで表示』の説明を表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: [] }));
    await openPanel();

    await waitFor(() =>
      expect(screen.getByText("現在、すべてのページでWidgetが表示されます")).toBeTruthy()
    );
  });

  it("先頭スラッシュ付きパスを追加すると PATCH /v1/admin/my-tenant が呼ばれ、確認ダイアログは出ない", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: [] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/cart"] }));
    const confirmMock = vi.fn();
    vi.stubGlobal("confirm", confirmMock);
    await openPanel();

    const input = await screen.findByPlaceholderText("/cart");
    fireEvent.change(input, { target: { value: "/cart" } });
    fireEvent.click(screen.getByText("追加"));

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(call?.[0]).toBe("http://localhost:3100/v1/admin/my-tenant");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ excluded_page_patterns: ["/cart"] }) });
    });
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("/cart")).toBeTruthy());
  });

  it("フルURLを貼るとpathnameに正規化して追加する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: [] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/cart"] }));
    await openPanel();

    const input = await screen.findByPlaceholderText("/cart");
    fireEvent.change(input, { target: { value: "https://shop.example.com/cart" } });
    fireEvent.click(screen.getByText("追加"));

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ excluded_page_patterns: ["/cart"] }) });
    });
  });

  it("先頭スラッシュの無いパスはPATCHを呼ばずエラー表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: [] }));
    await openPanel();

    const input = await screen.findByPlaceholderText("/cart");
    fireEvent.change(input, { target: { value: "cart" } });
    fireEvent.click(screen.getByText("追加"));

    expect(await screen.findByText("パスは / から始めてください（例: /cart, /products/*, /blog/**）")).toBeTruthy();
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("重複するパスはPATCHを呼ばずエラー表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/cart"] }));
    await openPanel();

    await screen.findByText("/cart");
    const input = screen.getByPlaceholderText("/cart");
    fireEvent.change(input, { target: { value: "/cart" } });
    fireEvent.click(screen.getByText("追加"));

    expect(await screen.findByText("既に登録されています")).toBeTruthy();
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("削除ボタンで対象パスを除いた配列をPATCHし、確認ダイアログは出ない", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/cart", "/checkout/**"] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/checkout/**"] }));
    const confirmMock = vi.fn();
    vi.stubGlobal("confirm", confirmMock);
    await openPanel();

    await screen.findByText("/cart");
    fireEvent.click(screen.getByLabelText("remove /cart"));

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ excluded_page_patterns: ["/checkout/**"] }) });
    });
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("/cart")).toBeNull());
  });

  it("保存失敗時は元の一覧にロールバックしてエラートーストを出す", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ excluded_page_patterns: ["/cart"] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ error: "server_error" }, false));
    await openPanel();

    await screen.findByText("/cart");
    const input = screen.getByPlaceholderText("/cart");
    fireEvent.change(input, { target: { value: "/checkout" } });
    fireEvent.click(screen.getByText("追加"));

    await waitFor(() => expect(screen.getByText("❌ 保存に失敗しました。もう一度お試しください。")).toBeTruthy());
    // ロールバックにより追加前の状態(/checkoutが無い)に戻る
    expect(screen.queryByText("/checkout")).toBeNull();
  });
});
