// 承認迂回の封鎖(要件 C1 / CLAUDE.md 禁止29・45)の回帰テスト。
//
// 旧UI /admin/tuning は TuningRule 型に source/status を持たず、AIの提案(status='pending')が
// 「ただの無効ルール」として描画されていた。そこの is_active トグルを押すと
// PUT /v1/admin/tuning-rules/:id が {is_active:true} だけを送り、
// **status が pending のまま本番の応答方針に載る**。その経路を塞いだことを固定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TuningPage from "./index";
import { useAuth } from "../../../auth/useAuth";
import { createAuthMock } from "../../../test/authMock";
import { authFetch } from "../../../lib/api";

vi.mock("../../../auth/useAuth", () => ({ useAuth: vi.fn() }));

vi.mock("../../../i18n/LangContext", async () => {
  const jaModule = await import("../../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string, vars?: Record<string, string | number>) => {
    let text = ja[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    return text;
  };
  const stableValue = { lang: "ja" as const, setLang: () => {}, t: stableT };
  return { useLang: () => stableValue };
});

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const PENDING = {
  id: 1, tenant_id: "tenant-a", trigger_pattern: "保証", expected_behavior: "2年と答える",
  priority: 50, is_active: false, created_by: "judge", created_at: "2026-08-01T00:00:00Z",
  source: "judge", status: "pending", evidence: "会話 #123 で保証期間を答えられなかった",
};
const MANUAL_ACTIVE = {
  id: 2, tenant_id: "tenant-a", trigger_pattern: "返品", expected_behavior: "丁寧に案内",
  priority: 50, is_active: true, created_by: "user", created_at: "2026-08-01T00:00:00Z",
  source: "manual", status: null, evidence: null,
};

function mockList(rules: unknown[]) {
  vi.mocked(authFetch).mockImplementation((url: string) => {
    if (String(url).includes("/v1/admin/tuning-rules?")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rules }) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
}

function renderPage() {
  vi.mocked(useAuth).mockReturnValue(
    createAuthMock({
      isClientAdmin: true,
      user: { id: "1", email: "a@example.com", role: "client_admin", tenantId: "tenant-a", tenantName: "A" },
    }),
  );
  return render(<MemoryRouter><TuningPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  mockNavigate.mockReset();
});

describe("AI提案(status=pending)の承認迂回を塞ぐ", () => {
  it("提案には is_active トグルを描画しない(押すと status が pending のまま本番に載るため)", async () => {
    mockList([PENDING]);
    renderPage();

    await waitFor(() => expect(screen.getByText("保証")).toBeTruthy());
    expect(screen.queryByText(/⬜/)).toBeNull();
    expect(screen.queryByText(/✅/)).toBeNull();
    expect(screen.getByText("承認する")).toBeTruthy();
    expect(screen.getByText("却下する")).toBeTruthy();
  });

  it("提案には出所と根拠を必ず出す(示さずに承認させない)", async () => {
    mockList([PENDING]);
    renderPage();

    await waitFor(() => expect(screen.getByText(/AIからの提案（会話の評価より）/)).toBeTruthy());
    expect(screen.getByText(/まだ回答には使われていません/)).toBeTruthy();
    expect(screen.getByText(/会話 #123 で保証期間を答えられなかった/)).toBeTruthy();
  });

  it("承認は既存の approve エンドポイントを叩く(承認APIを新設しない・新しいURLを作らない)", async () => {
    mockList([PENDING]);
    renderPage();

    await waitFor(() => expect(screen.getByText("承認する")).toBeTruthy());
    fireEvent.click(screen.getByText("承認する"));

    await waitFor(() => {
      const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain("http://localhost:3100/v1/admin/tuning/1/approve");
    });
    // is_active だけを送る PUT /v1/admin/tuning-rules/:id は使わない
    const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /\/v1\/admin\/tuning-rules\/1$/.test(u))).toBe(false);
  });

  it("却下は reject エンドポイントを叩く", async () => {
    mockList([PENDING]);
    renderPage();

    await waitFor(() => expect(screen.getByText("却下する")).toBeTruthy());
    fireEvent.click(screen.getByText("却下する"));

    await waitFor(() => {
      const urls = vi.mocked(authFetch).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain("http://localhost:3100/v1/admin/tuning/1/reject");
    });
  });

  it("提案でないルールは従来どおりトグルで切り替えられる(既存挙動を壊さない)", async () => {
    mockList([MANUAL_ACTIVE]);
    renderPage();

    await waitFor(() => expect(screen.getByText("返品")).toBeTruthy());
    expect(screen.queryByText("承認する")).toBeNull();
    expect(screen.getByText(/✅/)).toBeTruthy();
  });
});
