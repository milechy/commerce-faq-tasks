// admin-ui/src/pages/admin/author-loop/index.test.tsx
// GID 1217968284736841 (T9): 著者(赤嶺氏)専用画面の回帰テスト。
//  - 会話が0件(判断できる母数未満)のときに嘘の集計を出さないこと
//  - 注入された教えが、その会話に紐づいて画面に出ること
//  - 専門用語(チャンク/ベクトル/埋め込み/原則注入/RAG/テナント等)を画面に出さない方針
//    (.claude/rules/knowledge.md, T9指示の言い換え表)を検証する

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AuthorLoopPage, { MIN_CONVERSATIONS_FOR_REVIEW } from "./index";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

import { authFetch } from "../../../lib/api";

const mockFetch = authFetch as unknown as ReturnType<typeof vi.fn>;

// このプロジェクトのvitest環境(happy-dom)は window.localStorage を提供しないため、
// テスト用に最小限のMap実装で補う(本番のブラウザでは標準のlocalStorageが使われる。
// chatFirstDefault.test.ts と同じ流儀)。
function installFakeLocalStorage() {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
  Object.defineProperty(window, "localStorage", { value: fakeStorage, configurable: true });
}

const okRes = (data: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);

interface SessionFixture {
  id: string;
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
}

function session(id: string, overrides: Partial<SessionFixture> = {}): SessionFixture {
  return {
    id,
    tenant_id: "carnation",
    session_id: id,
    started_at: "2026-08-01T00:00:00Z",
    last_message_at: "2026-08-01T00:00:00Z",
    message_count: 1,
    ...overrides,
  };
}

function injectedAssistantMessage(text: string, principle: string, msgId = 1) {
  return {
    id: msgId,
    role: "assistant",
    content: text,
    created_at: "2026-08-01T00:01:00Z",
    rag_sources: [{ chunk_id: "1", source: "book", score: 0.9, principle, retrieved: true, injected: true }],
  };
}

/** N件の「教えが使われた」だけの空の会話(母数の穴埋め用)を作る。表示内容は検証対象外。 */
function fillerSessions(count: number, startIndex = 0): { session: SessionFixture; messages: unknown[] }[] {
  return Array.from({ length: count }, (_, i) => {
    const idx = startIndex + i;
    return {
      session: session(`filler-${idx}`, { last_message_at: "2026-01-01T00:00:00Z" }),
      messages: [injectedAssistantMessage(`filler回答${idx}`, `filler原理${idx}`)],
    };
  });
}

/** sessions一覧APIとmessages APIをまとめてモックする。 */
function mockConversations(pairs: { session: SessionFixture; messages: unknown[] }[]) {
  mockFetch.mockImplementation((url: string) => {
    const hit = pairs.find((p) => url.includes(`/sessions/${p.session.id}/messages`));
    if (hit) return Promise.resolve(okRes({ messages: hit.messages }));
    if (url.includes("/sessions?")) {
      return Promise.resolve(okRes({ sessions: pairs.map((p) => p.session), total: pairs.length }));
    }
    return Promise.resolve(okRes({}));
  });
}

// 画面に出してはいけない内部語(T9指示の言い換え表)
const FORBIDDEN_WORDS = [
  "チャンク",
  "ベクトル",
  "埋め込み",
  "原則注入",
  "RAG",
  "検索ヒット",
  "CV率",
  "Judgeスコア",
  "Judge スコア",
  "globalスコープ",
  "テナント",
  "閾値",
  "関連度スコア",
];

beforeEach(() => {
  installFakeLocalStorage();
  mockFetch.mockReset();
  mockNavigate.mockReset();
});

describe("AuthorLoopPage", () => {
  it(`判断できる会話数(${MIN_CONVERSATIONS_FOR_REVIEW}件)未満のときは、集計をゼロ埋めせず母数と不足件数を出す`, async () => {
    mockConversations([]);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          `まだ判断できる会話数がありません（現在0件。あと${MIN_CONVERSATIONS_FOR_REVIEW}件で見られます）`,
        ),
      ).toBeTruthy();
    });
  });

  it("注入された教えが、その会話の本文とともに1件ずつ表示される", async () => {
    const target = {
      session: session("session-db-1", { last_message_at: "2026-08-20T00:05:00Z" }),
      messages: [
        { id: 1, role: "user", content: "値引きしてもらえますか？", created_at: "2026-08-20T00:00:00Z" },
        injectedAssistantMessage("今だけの特別価格でご案内しています", "返報性の原理", 2),
      ],
    };
    // last_message_at を古くして並び順を後ろにし、target が最初に出ることを保証する
    mockConversations([target, ...fillerSessions(MIN_CONVERSATIONS_FOR_REVIEW)]);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(screen.getByText(/返報性の原理/)).toBeTruthy();
    });

    // 会話本文(伏せない)が両メッセージとも見える
    expect(screen.getByText("値引きしてもらえますか？")).toBeTruthy();
    expect(screen.getByText("今だけの特別価格でご案内しています")).toBeTruthy();

    // 直せる導線(既存のチャンク編集画面へのリンク)がある
    const fixLink = screen.getByText("この教えを直したい方はこちら");
    expect(fixLink.closest("a")?.getAttribute("href")).toBe("/admin/knowledge/global?tab=pdf");

    // 禁止語が出ていないこと
    const bodyText = document.body.textContent ?? "";
    for (const word of FORBIDDEN_WORDS) {
      expect(bodyText).not.toContain(word);
    }
  });

  it("「はい」を選ぶと次の未確認項目に進み、選んだ項目はlocalStorageに記憶される", async () => {
    const first = {
      session: session("session-a", { tenant_id: "carnation", last_message_at: "2026-08-21T00:00:00Z" }),
      messages: [injectedAssistantMessage("回答A", "希少性の原理")],
    };
    const second = {
      session: session("session-b", { tenant_id: "peony", last_message_at: "2026-08-20T00:00:00Z" }),
      messages: [injectedAssistantMessage("回答B", "一貫性の原理")],
    };
    mockConversations([first, second, ...fillerSessions(MIN_CONVERSATIONS_FOR_REVIEW, 100)]);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(screen.getByText(/希少性の原理/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("はい、この使い方でよい"));

    await waitFor(() => {
      expect(screen.getByText(/一貫性の原理/)).toBeTruthy();
    });

    expect(window.localStorage.getItem("r2c_author_loop_reviewed_v1")).toContain("希少性の原理");
  });

  it("「使われ方が違う（直しに行く）」を押すと、報告するだけで終わらず教えを直す画面に移動する", async () => {
    const target = {
      session: session("session-c", { last_message_at: "2026-08-22T00:00:00Z" }),
      messages: [injectedAssistantMessage("回答C", "権威性の原理")],
    };
    mockConversations([target, ...fillerSessions(MIN_CONVERSATIONS_FOR_REVIEW, 200)]);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(screen.getByText(/権威性の原理/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("使われ方が違う（直しに行く）"));

    expect(mockNavigate).toHaveBeenCalledWith("/admin/knowledge/global?tab=pdf");
  });

  it("たまっている会話を全て確認済みにすると、空欄ではなく「すべて確認済み」の案内が出る", async () => {
    const items = Array.from({ length: MIN_CONVERSATIONS_FOR_REVIEW }, (_, i) => ({
      session: session(`s-all-${i}`, { last_message_at: `2026-08-2${i}T00:00:00Z` }),
      messages: [injectedAssistantMessage(`回答${i}`, `原理${i}`)],
    }));
    mockConversations(items);

    render(<AuthorLoopPage />);

    await screen.findByText("はい、この使い方でよい");
    for (let i = 0; i < MIN_CONVERSATIONS_FOR_REVIEW; i++) {
      fireEvent.click(screen.getByText("はい、この使い方でよい"));
    }

    await waitFor(() => {
      expect(
        screen.getByText("たまっている会話はすべて確認済みです。新しい会話が増えたらまたお知らせします。"),
      ).toBeTruthy();
    });
  });

  it("「あとで」を繰り返し押しても画面が壊れない(未確認が溜まったままでも表示が破綻しない)", async () => {
    const items = [
      { session: session("s-later-a", { last_message_at: "2026-08-25T00:00:00Z" }), messages: [injectedAssistantMessage("回答A", "原理A")] },
      { session: session("s-later-b", { last_message_at: "2026-08-24T00:00:00Z" }), messages: [injectedAssistantMessage("回答B", "原理B")] },
      ...fillerSessions(MIN_CONVERSATIONS_FOR_REVIEW, 300),
    ];
    mockConversations(items);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(screen.getByText(/確認: \d+ \/ \d+件/)).toBeTruthy();
    });

    for (let i = 0; i < 50; i++) {
      fireEvent.click(screen.getByText("あとで"));
    }

    // 50回スキップしても画面は壊れず、引き続き確認カウンタが表示される
    expect(screen.getByText(/確認: \d+ \/ \d+件/)).toBeTruthy();
  });

  it("injected:true でも principle が空文字/未設定の行はレビュー対象に出さない", async () => {
    const target = {
      session: session("s-empty-principle", { last_message_at: "2026-08-26T00:00:00Z" }),
      messages: [
        {
          id: 1,
          role: "assistant",
          content: "空の教え応答",
          created_at: "2026-08-26T00:01:00Z",
          rag_sources: [
            { chunk_id: "e1", source: "book", score: 0.9, injected: true, principle: "" },
            { chunk_id: "e2", source: "book", score: 0.8, injected: true },
          ],
        },
      ],
    };
    mockConversations([target, ...fillerSessions(MIN_CONVERSATIONS_FOR_REVIEW, 400)]);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(screen.getByText(/確認: \d+ \/ \d+件/)).toBeTruthy();
    });
    expect(screen.queryByText("空の教え応答")).not.toBeTruthy();
  });

  it("assistant以外のメッセージや rag_sources が無いセッションが混ざっても落ちない", async () => {
    const noisy = {
      session: session("s-noisy", { last_message_at: "2026-08-27T00:00:00Z" }),
      messages: [
        { id: 1, role: "user", content: "質問", created_at: "2026-08-27T00:00:00Z" },
        { id: 2, role: "operator", content: "スタッフ対応", created_at: "2026-08-27T00:01:00Z" },
        { id: 3, role: "assistant", content: "rag_sourcesなし応答", created_at: "2026-08-27T00:02:00Z" },
      ],
    };
    mockConversations([noisy, ...fillerSessions(MIN_CONVERSATIONS_FOR_REVIEW, 500)]);

    render(<AuthorLoopPage />);

    await waitFor(() => {
      expect(screen.getByText(/確認: \d+ \/ \d+件/)).toBeTruthy();
    });
    expect(screen.queryByText("rag_sourcesなし応答")).not.toBeTruthy();
  });
});
