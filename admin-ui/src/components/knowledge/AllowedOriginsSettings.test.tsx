// LAUNCH: AllowedOriginsSettings — client_adminによるWidget許可ドメインの追加・削除
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AllowedOriginsSettings from "./AllowedOriginsSettings";

vi.mock("../../i18n/LangContext", async () => {
  const jaModule = await import("../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string) => ja[key] ?? key;
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
  render(<AllowedOriginsSettings tenantId="tenant-abc" />);
  fireEvent.click(await screen.findByText("🔒 Widgetの許可ドメイン設定"));
}

describe("AllowedOriginsSettings", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("既存のallowed_originsを読み込んで一覧表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: ["https://shop.example.com"] }));
    await openPanel();

    await waitFor(() => expect(screen.getByText("https://shop.example.com")).toBeTruthy());
  });

  it("空配列のときは「登録されていません」を表示する", async () => {
    authFetchMock.mockReturnValueOnce(jsonRes({ allowed_origins: [] }));
    await openPanel();

    await waitFor(() => expect(screen.getByText("許可ドメインが登録されていません")).toBeTruthy());
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
