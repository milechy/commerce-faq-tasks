// admin-ui/src/pages/admin/knowledge-gaps/index.test.tsx
//
// ナレッジ配線是正「admin-ui AI推薦表示」(Asana GID 1217811231498963):
// URL付け替えはP10(#979)で完了済み。ここでは残タスク(AI推薦の表示・
// 承認ボタン・「知識にする」の有効化)を検証する。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import KnowledgeGapsPage from "./index";
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
  user: { id: "1", email: "owner@example.com", role: "client_admin", tenantId: "tenant-abc", tenantName: "テスト店舗" },
  isClientAdmin: true,
});

const GAP_WITH_RECOMMENDATION = {
  id: 1,
  tenant_id: "tenant-abc",
  user_question: "保証期間はどのくらいですか",
  rag_hit_count: 0,
  rag_top_score: 0,
  created_at: "2026-08-24T00:00:00Z",
  recommendation_status: "pending",
  recommended_action: "保証期間についてのFAQを追加する",
  suggested_answer: "保証期間は3ヶ月です",
  detection_source: "no_rag",
  frequency: 2,
};

const GAP_WITHOUT_RECOMMENDATION = {
  id: 2,
  tenant_id: "tenant-abc",
  user_question: "配送業者はどこですか",
  rag_hit_count: 0,
  rag_top_score: 0,
  created_at: "2026-08-24T00:00:00Z",
  recommendation_status: "pending",
  recommended_action: null,
  suggested_answer: null,
  detection_source: "no_rag",
  frequency: 1,
};

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function renderPage() {
  return render(
    <MemoryRouter>
      <KnowledgeGapsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue(CLIENT_ADMIN);
  vi.mocked(authFetch).mockReset();
});

describe("KnowledgeGapsPage — 新API(/v1/admin/knowledge-gaps)を叩く(回帰)", () => {
  it("一覧取得は旧パス(/v1/admin/knowledge/gaps)ではなく新パスを叩く", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockOk({ gaps: [] }));
    renderPage();

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalled();
    });
    const url = String(vi.mocked(authFetch).mock.calls[0]![0]);
    expect(url).toContain("/v1/admin/knowledge-gaps?");
    expect(url).not.toContain("/v1/admin/knowledge/gaps");
  });
});

describe("KnowledgeGapsPage — AI推薦の表示", () => {
  it("推薦がある行には recommended_action がそのまま描画される", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockOk({ gaps: [GAP_WITH_RECOMMENDATION] }));
    renderPage();

    expect(await screen.findByText("保証期間についてのFAQを追加する")).toBeTruthy();
  });

  it("推薦が無い行には「効果あり/なし」ではなく到達条件(生成トリガーの説明)が出る", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockOk({ gaps: [GAP_WITHOUT_RECOMMENDATION] }));
    renderPage();

    expect(await screen.findByText(/まだAIの推薦がありません/)).toBeTruthy();
    expect(screen.queryByText(/効果あり/)).toBeNull();
    expect(screen.queryByText(/効果なし/)).toBeNull();
    // 「生成中」のような進行中を騙る表示も禁止(禁止34: 実際には遅延生成に失敗しうる)
    expect(screen.queryByText(/生成中/)).toBeNull();
  });

  it("推薦が無い行では「知識にする」ボタン自体が出ない(押せる知識化ボタンが無い)", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockOk({ gaps: [GAP_WITHOUT_RECOMMENDATION] }));
    renderPage();

    await waitFor(() => expect(screen.getByText("配送業者はどこですか")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /知識にする/ })).toBeNull();
  });
});

describe("KnowledgeGapsPage — 承認と知識化", () => {
  it("「推薦を承認する」ボタンはPATCH {action:'approve'} を送り、成功後に承認済み表示へ更新される", async () => {
    vi.mocked(authFetch).mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return mockOk({ ok: true });
      return mockOk({ gaps: [GAP_WITH_RECOMMENDATION] });
    });
    renderPage();

    const approveButton = await screen.findByRole("button", { name: "推薦を承認する" });
    fireEvent.click(approveButton);

    await waitFor(() => {
      const patchCall = vi.mocked(authFetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patchCall).toBeTruthy();
      expect(String(patchCall![0])).toBe("http://localhost:3100/v1/admin/knowledge-gaps/1");
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ action: "approve" });
    });

    expect(await screen.findByText("✓ 承認済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "推薦を承認する" })).toBeNull();
  });

  it("承認前は「知識にする」ボタンが無効(押しても何も起きないUIにしない。禁止44)", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockOk({ gaps: [GAP_WITH_RECOMMENDATION] }));
    renderPage();

    const addButton = (await screen.findByRole("button", { name: /知識にする/ })) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(screen.getByText("承認後に「知識にする」が使えます")).toBeTruthy();
  });

  it("承認済みギャップで「知識にする」を押すと POST /add-knowledge が回答案付きで送られ、成功後に一覧から消える", async () => {
    const approvedGap = { ...GAP_WITH_RECOMMENDATION, recommendation_status: "approved" as const };
    vi.mocked(authFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/add-knowledge")) return mockOk({ success: true, faq_doc_id: 999 });
      return mockOk({ gaps: [approvedGap] });
    });
    renderPage();

    const card = (await screen.findByText("保証期間はどのくらいですか")).closest("div")!.parentElement!;
    const addButton = within(card).getByRole("button", { name: "🧠 知識にする" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    fireEvent.click(addButton);

    await waitFor(() => {
      const postCall = vi.mocked(authFetch).mock.calls.find(
        ([url, init]) => (init as RequestInit | undefined)?.method === "POST" && String(url).includes("/add-knowledge"),
      );
      expect(postCall).toBeTruthy();
      expect(String(postCall![0])).toBe("http://localhost:3100/v1/admin/knowledge-gaps/1/add-knowledge");
      expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ answer_text: "保証期間は3ヶ月です" });
    });

    await waitFor(() => {
      expect(screen.queryByText("保証期間はどのくらいですか")).toBeNull();
    });
  });
});
