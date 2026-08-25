// Phase: KnowledgeListTab の /faq 移行・検索・一括操作の回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import KnowledgeListTab from "./KnowledgeListTab";
import { useAuth } from "../../auth/useAuth";
import { createAuthMock } from "../../test/authMock";

vi.mock("../../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

// LangProvider は localStorage.getItem に依存し、このテスト環境の Node組み込み
// localStorage（--localstorage-file 未指定時は undefined）で例外になるため、
// 実辞書(ja.ts)をそのまま使う t() を返す薄いモックに置き換える。
// t は本番の LangContext と同様に安定した参照でなければならない
// （毎レンダー新規関数だと fetchItems の useCallback 依存が壊れ、無限re-fetchになる）
vi.mock("../../i18n/LangContext", async () => {
  const jaModule = await import("../../i18n/ja");
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

// useNavigate() は毎レンダー同じ関数参照を返す必要がある
// （不安定だと fetchItems の useCallback 依存が壊れ、無限re-fetchになる）
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return { ...actual, fetchWithAuth: vi.fn() };
});

import { fetchWithAuth } from "./shared";

const CLIENT_ADMIN = createAuthMock({
  user: { id: "1", email: "owner@example.com", role: "client_admin", tenantId: "tenant-abc", tenantName: "テスト店舗" },
  isClientAdmin: true,
});

const ITEM_A = {
  id: 1,
  tenant_id: "tenant-abc",
  question: "送料はいくらですか",
  answer: "全国一律550円です",
  category: "pricing",
  tags: [],
  is_published: true,
  created_at: "2026-07-01T00:00:00Z",
};

const ITEM_B = {
  id: 2,
  tenant_id: "tenant-abc",
  question: "営業時間を教えてください",
  answer: "10時から19時までです",
  category: "store_info",
  tags: [],
  is_published: false,
  created_at: "2026-07-02T00:00:00Z",
};

function mockList(items: typeof ITEM_A[], total?: number) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items, total: total ?? items.length }),
  } as Response);
}

function renderTab() {
  return render(<KnowledgeListTab tenantId="tenant-abc" />);
}

describe("KnowledgeListTab", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(CLIENT_ADMIN);
    vi.mocked(fetchWithAuth).mockReset();
  });

  it("マウント時に /v1/admin/knowledge/faq へ既定パラメータでリクエストする", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_A, ITEM_B]));
    renderTab();

    await waitFor(() => {
      expect(vi.mocked(fetchWithAuth)).toHaveBeenCalled();
    });
    const [url] = vi.mocked(fetchWithAuth).mock.calls[0];
    expect(url).toContain("http://localhost:3100/v1/admin/knowledge/faq?");
    expect(url).toContain("tenant=tenant-abc");
    expect(url).toContain("limit=20");
    expect(url).toContain("offset=0");
    expect(url).toContain("sort=created_at");
    expect(url).toContain("order=desc");
  });

  it("検索入力から一定時間後に search パラメータ付きで再取得する", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_A]));
    renderTab();

    await waitFor(() => expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText(/探したい言葉/);
    fireEvent.change(input, { target: { value: "送料" } });

    await waitFor(
      () => {
        const lastCall = vi.mocked(fetchWithAuth).mock.calls.at(-1);
        expect(lastCall?.[0]).toContain("search=%E9%80%81%E6%96%99");
      },
      { timeout: 2000 }
    );
  });

  it("チェックボックス選択 → 「AIが答えないようにする」で bulk-publish(false) を呼ぶ", async () => {
    vi.mocked(fetchWithAuth)
      .mockReturnValueOnce(mockList([ITEM_A, ITEM_B]))
      .mockReturnValueOnce(Promise.resolve({ ok: true, json: () => Promise.resolve({ updated: 1 }) } as Response))
      .mockReturnValue(mockList([ITEM_B]));

    renderTab();
    await waitFor(() => screen.getByText(/送料はいくらですか/));

    const checkboxes = screen.getAllByRole("checkbox");
    // 先頭は「全選択」チェックボックス。以降が各行
    fireEvent.click(checkboxes[1]);

    const bulkBtn = await screen.findByText(/1件をAIが答えないようにする/);
    fireEvent.click(bulkBtn);

    await waitFor(() => {
      const call = vi.mocked(fetchWithAuth).mock.calls.find(([url]) =>
        String(url).includes("/v1/admin/knowledge/faq/bulk-publish")
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        method: "PATCH",
        body: JSON.stringify({ ids: [1], is_published: false }),
      });
    });
  });

  it("削除ボタンは1回目でクリック確認状態になり、2回目で bulk 削除を呼ぶ", async () => {
    vi.mocked(fetchWithAuth)
      .mockReturnValueOnce(mockList([ITEM_A]))
      .mockReturnValueOnce(Promise.resolve({ ok: true, json: () => Promise.resolve({ deleted: 1, failed: 0 }) } as Response))
      .mockReturnValue(mockList([]));

    renderTab();
    await waitFor(() => screen.getByText(/送料はいくらですか/));

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    const deleteBtn = await screen.findByText(/1件を削除する/);
    fireEvent.click(deleteBtn);
    expect(await screen.findByText("本当に削除しますか？")).toBeTruthy();

    // bulk delete API はまだ呼ばれていない
    expect(
      vi.mocked(fetchWithAuth).mock.calls.some(([url]) => String(url).includes("/faq/bulk") && !String(url).includes("bulk-publish"))
    ).toBe(false);

    fireEvent.click(screen.getByText("本当に削除しますか？"));

    await waitFor(() => {
      const call = vi.mocked(fetchWithAuth).mock.calls.find(
        ([url, opts]) => String(url).includes("/v1/admin/knowledge/faq/bulk?") && (opts as RequestInit)?.method === "DELETE"
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({ body: JSON.stringify({ ids: [1] }) });
    });
  });

  it("公開中/非公開バッジがAI回答文言で表示される", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_A, ITEM_B]));
    renderTab();

    await waitFor(() => screen.getByText(/送料はいくらですか/));
    expect(screen.getByText("🤖 AIが回答中")).toBeTruthy();
    expect(screen.getByText("⏸️ AIは回答しません")).toBeTruthy();
  });

  it("カテゴリチップは実データが空でも既定9カテゴリ分表示される", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([]));
    renderTab();

    await waitFor(() => {
      expect(vi.mocked(fetchWithAuth)).toHaveBeenCalled();
    });
    // CATEGORY_LABEL_MAP の inventory ラベル
    expect(await screen.findByText("在庫・車両情報")).toBeTruthy();
  });

  // LAUNCH: Widget許可ドメイン設定パネル（client_admin専用、super_adminは既存のSettingsTabで管理）
  it("client_adminにはWidget許可ドメイン設定パネルが表示される", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([]));
    renderTab();

    await waitFor(() => screen.getByText("🔒 Widgetの許可ドメイン設定"));
  });

  it("super_adminにはWidget許可ドメイン設定パネルが表示されない（/admin/tenants/:idのSettingsTabで管理するため）", async () => {
    vi.mocked(useAuth).mockReturnValue(createAuthMock({
      user: { id: "1", email: "admin@example.com", role: "super_admin", tenantId: "tenant-abc", tenantName: "テスト店舗" },
      isSuperAdmin: true,
    }));
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([]));
    renderTab();

    await waitFor(() => {
      expect(vi.mocked(fetchWithAuth)).toHaveBeenCalled();
    });
    expect(screen.queryByText("🔒 Widgetの許可ドメイン設定")).toBeNull();
  });
});

// E2: 全店舗共通(global)の知識をテナントに読み取り専用で見せる。
// テナントの回答は「自店 + global」の合算で作られるのに、一覧が自店分だけだと
// 自分の答えを作っている知識の半分が確認できない(要件 Rg)。
const ITEM_GLOBAL = {
  id: 99,
  tenant_id: "global",
  question: "配送の一般的な流れは",
  answer: "ご注文後、順次発送いたします",
  category: "shipping",
  tags: [],
  is_published: true,
  created_at: "2026-06-01T00:00:00Z",
};

describe("KnowledgeListTab — 全店舗共通の知識", () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
    mockNavigate.mockReset();
  });

  it("一覧に表示され、出所が分かる", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_A, ITEM_GLOBAL]));
    renderTab();

    expect(await screen.findByText("Q: 配送の一般的な流れは")).toBeTruthy();
    expect(screen.getByText("全店舗共通")).toBeTruthy();
    // 自店の知識には出所バッジを付けない
    expect(screen.getAllByText("全店舗共通")).toHaveLength(1);
  });

  it("編集・削除・公開切替のボタンを出さず、理由を書く(押せない操作を並べない)", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_GLOBAL]));
    renderTab();

    await screen.findByText("Q: 配送の一般的な流れは");
    expect(screen.queryByRole("button", { name: "✏️ 編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "AIが答えないようにする" })).toBeNull();
    expect(screen.getByText(/R2Cが全店舗向けに用意した知識です/)).toBeTruthy();
  });

  it("一括操作の選択対象にしない(チェックボックスを出さない)", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_A, ITEM_GLOBAL]));
    renderTab();

    await screen.findByText("Q: 配送の一般的な流れは");
    // 自店1件ぶんだけ(全選択用を除く)
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeLessThan(3);
  });

  it("自店の知識には従来どおり編集・削除が出る(既存挙動を壊さない)", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockList([ITEM_A]));
    renderTab();

    await screen.findByText("Q: 送料はいくらですか");
    expect(screen.getByRole("button", { name: "✏️ 編集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "削除" })).toBeTruthy();
  });
});
