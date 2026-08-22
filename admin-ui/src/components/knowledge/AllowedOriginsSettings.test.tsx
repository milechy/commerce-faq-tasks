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
});
