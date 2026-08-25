// LAUNCH: AllowedOriginsSettings — client_adminによるWidget許可ドメインの追加・削除
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AllowedOriginsSettings from "./AllowedOriginsSettings";

vi.mock("../../i18n/LangContext", async () => {
  const jaModule = await import("../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  // 実装のtranslate()と同じ{var}展開ルールに揃える(tuning/index.test.tsxと同じパターン)。
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

// 「初回登録」「最後の1件を削除」はwindow.confirmで意図確認する(R3)。
// 既定はtrue(確認して進む)にし、キャンセル系のテストだけ個別にfalseへ上書きする。
const confirmMock = vi.fn((_message?: string) => true);

function jsonRes(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

async function openPanel() {
  render(<AllowedOriginsSettings tenantId="tenant-abc" />);
  fireEvent.click(await screen.findByText("🔒 Widgetの許可ドメイン設定"));
}

describe("AllowedOriginsSettings", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
  });

  it("既存のallowed_originsを読み込んで一覧表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://shop.example.com"] }));
    await openPanel();

    await waitFor(() => expect(screen.getByText("https://shop.example.com")).toBeTruthy());
  });

  it("空配列のときは「登録されていません」ではなく「保護なし」の警告として表示する(空欄と保護なしを同じ見た目にしない)", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    await openPanel();

    await waitFor(() =>
      expect(screen.getByText("⚠️ 保護なし：現在すべてのドメインからこのWidgetにアクセスできます")).toBeTruthy()
    );
    expect(
      screen.getByText("ドメインを1件以上登録すると、登録したドメイン以外からのアクセスを拒否するようになります。")
    ).toBeTruthy();
    // 警告状態はstatusロールを持つ専用ブロックとして描画され、中立な空リスト表示と区別される
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("https://始まりのURLを追加すると PATCH /v1/admin/my-tenant が呼ばれる", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://new-shop.example.com"] }));
    await openPanel();

    const input = await screen.findByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "https://new-shop.example.com" } });
    fireEvent.click(screen.getByText("追加"));

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(call?.[0]).toBe("http://localhost:3100/v1/admin/my-tenant");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ allowed_origins: ["https://new-shop.example.com"] }) });
    });
    await waitFor(() => expect(screen.getByText("https://new-shop.example.com")).toBeTruthy());
  });

  it("初回登録(0件→1件)では、正規化後の値と『ここに無いドメインは弾かれる』ことを提示する確認ダイアログを出す", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://new-shop.example.com"] }));
    await openPanel();

    // 末尾スラッシュ付きで入力しても、確認ダイアログとPATCH送信値は正規化後(末尾スラッシュなし)になる
    const input = await screen.findByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "https://new-shop.example.com/" } });
    fireEvent.click(screen.getByText("追加"));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toContain("https://new-shop.example.com");
    expect(confirmMock.mock.calls[0][0]).not.toContain("https://new-shop.example.com/");

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ allowed_origins: ["https://new-shop.example.com"] }) });
    });
  });

  it("初回登録の確認ダイアログでキャンセルするとPATCHを呼ばない", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    confirmMock.mockReturnValue(false);
    await openPanel();

    const input = await screen.findByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "https://new-shop.example.com" } });
    fireEvent.click(screen.getByText("追加"));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    // 追加されなかった(一覧は空のまま=警告状態が残る)
    expect(
      await screen.findByText("⚠️ 保護なし：現在すべてのドメインからこのWidgetにアクセスできます")
    ).toBeTruthy();
  });

  it("2件目以降の追加(既に保護あり)では確認ダイアログを出さない", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com"] }));
    authFetchMock.mockReturnValueOnce(
      jsonRes({ allowed_origins: ["https://a.example.com", "https://b.example.com"] })
    );
    await openPanel();

    await screen.findByText("https://a.example.com");
    const input = screen.getByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "https://b.example.com" } });
    fireEvent.click(screen.getByText("追加"));

    await waitFor(() => expect(screen.getByText("https://b.example.com")).toBeTruthy());
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("http://始まりのURLはPATCHを呼ばずエラー表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    await openPanel();

    const input = await screen.findByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "http://insecure.example.com" } });
    fireEvent.click(screen.getByText("追加"));

    expect(await screen.findByText("URLはhttps://で始まる必要があります")).toBeTruthy();
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("ワイルドカードを含むURLはPATCHを呼ばずエラー表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    await openPanel();

    const input = await screen.findByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "https://*.example.com" } });
    fireEvent.click(screen.getByText("追加"));

    expect(await screen.findByText("このフォームからはワイルドカード（*）を含むドメインは登録できません")).toBeTruthy();
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("削除ボタンで対象ドメインを除いた配列をPATCHする", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com", "https://b.example.com"] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://b.example.com"] }));
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://a.example.com"));

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ allowed_origins: ["https://b.example.com"] }) });
    });
    await waitFor(() => expect(screen.queryByText("https://a.example.com")).toBeNull());
  });

  it("最後の1件を削除しようとすると『無制限になる』ことを提示する確認ダイアログを出してからPATCHする", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com"] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://a.example.com"));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toContain("削除してもよろしいですか");

    await waitFor(() => {
      const call = authFetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ allowed_origins: [] }) });
    });
    // 削除後は「保護なし」の警告状態に戻る
    await waitFor(() =>
      expect(screen.getByText("⚠️ 保護なし：現在すべてのドメインからこのWidgetにアクセスできます")).toBeTruthy()
    );
  });

  it("最後の1件を削除する確認ダイアログでキャンセルするとPATCHを呼ばず一覧が残る", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com"] }));
    confirmMock.mockReturnValue(false);
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://a.example.com"));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    expect(screen.getByText("https://a.example.com")).toBeTruthy();
  });

  it("複数件残っているうちの1件を削除するときは確認ダイアログを出さない", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com", "https://b.example.com"] }));
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://b.example.com"] }));
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://a.example.com"));

    await waitFor(() => expect(screen.queryByText("https://a.example.com")).toBeNull());
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("PATCH失敗時は元の一覧にロールバックしエラートーストを表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com"] }));
    authFetchMock.mockReturnValueOnce(jsonRes({}, false));
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://a.example.com"));

    await waitFor(() => expect(screen.getByText("❌ 保存に失敗しました。もう一度お試しください。")).toBeTruthy());
    expect(screen.getByText("https://a.example.com")).toBeTruthy();
  });

  it("通信エラー（fetch自体が例外）でもロールバックしエラートーストを表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://a.example.com"] }));
    authFetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://a.example.com"));

    await waitFor(() => expect(screen.getByText("❌ 保存に失敗しました。もう一度お試しください。")).toBeTruthy());
    expect(screen.getByText("https://a.example.com")).toBeTruthy();
  });

  it("既に登録済みのoriginを再度追加しようとするとPATCHを呼ばずエラー表示する（重複追加防止）", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://dup.example.com"] }));
    await openPanel();

    await screen.findByText("https://dup.example.com");
    const input = screen.getByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "https://dup.example.com" } });
    fireEvent.click(screen.getByText("追加"));

    expect(await screen.findByText("既に登録されています")).toBeTruthy();
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("空白のみの入力では追加ボタンがdisabledのままPATCHを呼ばない", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    await openPanel();

    const input = await screen.findByPlaceholderText("https://shop.example.com");
    fireEvent.change(input, { target: { value: "   " } });

    const addButton = screen.getByText("追加").closest("button") as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(authFetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("tenantIdが'global'のときは初期フェッチ自体を呼ばず何も描画しない", () => {
    const { container } = render(<AllowedOriginsSettings tenantId="global" />);
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("保存中（saving=true）は残っている項目の削除ボタン・追加ボタンとも disabled になり、連打しても2重にPATCHされない", async () => {
    // 削除対象自身のボタンは楽観的更新で即座にDOMから消えるため、
    // 「消えずに残る別のorigin」の削除ボタンで saving フラグの効果を確認する。
    authFetchMock.mockReturnValueOnce(
      jsonRes({ allowed_origins: ["https://a.example.com", "https://b.example.com"] })
    );
    let resolvePatch: (value: unknown) => void = () => {};
    authFetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePatch = resolve;
      })
    );
    await openPanel();

    await screen.findByText("https://a.example.com");
    fireEvent.click(screen.getByLabelText("remove https://b.example.com"));

    // 保存中は残っているaの削除ボタン・追加ボタンとも disabled になる
    const remainingRemoveButton = await screen.findByLabelText(
      "remove https://a.example.com"
    ) as HTMLButtonElement;
    await waitFor(() => expect(remainingRemoveButton.disabled).toBe(true));
    const addButton = screen.getByText("追加").closest("button") as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    // 保存中の連打はReact側で無視される(ボタンdisabled)ため、PATCH呼び出しは1回のまま
    fireEvent.click(remainingRemoveButton);
    expect(
      authFetchMock.mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH").length
    ).toBe(1);

    resolvePatch(jsonRes({ allowed_origins: ["https://a.example.com"] }));
    await waitFor(() => expect(remainingRemoveButton.disabled).toBe(false));
  });
});
