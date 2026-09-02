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

// React error #31 の回帰テスト。evidence は manual/judge = 文字列、hermes = JSONB
// { pattern, rationale, session_ids } の2形式がある。直描画するとオブジェクトの場合に落ちる。
describe("evidence が object(hermes由来)でも一覧が落ちない(React error #31 の回帰)", () => {
  const HERMES_PENDING = {
    id: 3, tenant_id: "tenant-a", trigger_pattern: "送料", expected_behavior: "無料ラインを案内",
    priority: 50, is_active: false, created_by: "hermes", created_at: "2026-08-31T00:00:00Z",
    source: "hermes", status: "pending",
    evidence: {
      pattern: "送料 に関する質問が繰り返された",
      rationale: "3件の会話で送料の案内が一致していなかった",
      session_ids: ["session-abc", "session-def"],
    },
  };

  it("evidence がオブジェクトの提案を含む一覧が描画できる(クラッシュしない)", async () => {
    mockList([HERMES_PENDING]);
    renderPage();

    await waitFor(() => expect(screen.getByText("送料")).toBeTruthy());
    expect(screen.getByText(/送料 に関する質問が繰り返された/)).toBeTruthy();
    expect(screen.getByText(/3件の会話で送料の案内が一致していなかった/)).toBeTruthy();
  });

  it("evidence が文字列の提案も従来通り表示される", async () => {
    mockList([PENDING]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/会話 #123 で保証期間を答えられなかった/)).toBeTruthy(),
    );
  });

  it("evidence が null / 未知の形でも落ちない", async () => {
    const unknownShape = { ...HERMES_PENDING, id: 4, evidence: { unexpected: "future field" } };
    mockList([MANUAL_ACTIVE, { ...HERMES_PENDING, id: 5, evidence: 42 }, unknownShape]);
    renderPage();

    await waitFor(() => expect(screen.getByText("返品")).toBeTruthy());
    expect(screen.getAllByText("送料").length).toBeGreaterThan(0);
  });

  it("session_ids のリンクが正しい URL を指す", async () => {
    mockList([HERMES_PENDING]);
    renderPage();

    await waitFor(() => expect(screen.getByText("session-abc")).toBeTruthy());
    fireEvent.click(screen.getByText("session-abc"));

    expect(mockNavigate).toHaveBeenCalledWith("/admin/chat-history/session-abc");
  });
});
