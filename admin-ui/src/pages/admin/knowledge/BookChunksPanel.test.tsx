// admin-ui/src/pages/admin/knowledge/BookChunksPanel.test.tsx
// T7: チャンク編集の反映状態(覚え直しています/覚えました/失敗)・保存前の影響範囲提示・
// 取り消し導線の回帰テスト。専門用語(チャンク/ベクトル/埋め込み/テナント等)を
// 画面に出さない方針(.claude/rules 参照)もあわせて検証する。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BookChunksPanel from "./BookChunksPanel";

vi.mock("../../../components/knowledge/shared", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
}));

import { fetchWithAuth } from "../../../components/knowledge/shared";

const mockFetch = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

const okRes = (data: unknown, status = 200): Response =>
  ({ ok: true, status, json: () => Promise.resolve(data) } as unknown as Response);
const errRes = (status: number, error = "エラー"): Response =>
  ({ ok: false, status, json: () => Promise.resolve({ error }) } as unknown as Response);

function baseChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    text: "本文プレビュー",
    text_restricted: false,
    metadata: {
      source: "book",
      book_id: 1,
      page_number: 3,
      principle: "アンカリング効果",
      situation: "旧状況",
      example: "旧例",
      contraindication: "旧禁忌",
      ...overrides,
    },
    is_structured: true,
  };
}

function mockChunksAndDetail(chunks: unknown[], detail: Record<string, unknown> = {}) {
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/chunks")) {
      return Promise.resolve(okRes({ chunks, total: chunks.length }));
    }
    if (method === "GET") {
      return Promise.resolve(okRes(detail));
    }
    // PUT はテストごとに個別上書きする
    return Promise.resolve(okRes({ id: 1, metadata: {}, embedding_updated: false }));
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("BookChunksPanel — 反映状態の表示", () => {
  it("embedding_status='done' のチャンクは読み込み直後から「AIが覚えました」を表示する(リロード耐性)", async () => {
    mockChunksAndDetail([baseChunk({ embedding_status: "done" })]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText(/AIが覚えました/)).toBeTruthy();
  });

  it("embedding_status='pending' のチャンクは読み込み直後から「AIが覚え直しています」を表示する(保存直後のリロードでも同じ表現)", async () => {
    mockChunksAndDetail([baseChunk({ embedding_status: "pending" })]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText(/AIが覚え直しています/)).toBeTruthy();
  });

  it("embedding_status='failed' のチャンクは失敗を無言で消さず表示する", async () => {
    mockChunksAndDetail([baseChunk({ embedding_status: "failed" })]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText(/AIが覚えるのに失敗しました/)).toBeTruthy();
  });

  it("embedding_status が無いチャンクは反映バッジを出さない(対象外スキーマ)", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    await screen.findByText("編集");
    expect(screen.queryByText(/AIが覚え/)).not.toBeTruthy();
  });
});

describe("BookChunksPanel — 保存前の影響範囲提示", () => {
  // bookTenantId は「書籍自身の tenant_id」(閲覧者のテナントではない)。
  // 閲覧者との取り違え自体は BookUploadsSection.bookTenant.test.tsx で
  // 配線ごと検証する(このファイルはコンポーネント単体のロジックのみ検証)。
  it("書籍が global テナント所属では「本を使っている全部の会社」に影響する旨を表示する", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="global" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    expect(await screen.findByText(/全部の会社の回答が変わります/)).toBeTruthy();
  });

  it("書籍がテナント固有所属では自社内のみに影響する旨を表示し、「テナント」という語は画面に出さない", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    expect(await screen.findByText(/あなたの会社の中だけで有効です/)).toBeTruthy();
    expect(screen.queryByText(/テナント/)).not.toBeTruthy();
  });
});

describe("BookChunksPanel — 保存フロー", () => {
  it("保存に成功すると「保存しました」を表示し編集を終了する", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    const textarea = (await screen.findAllByRole("textbox"))[1]!; // 状況フィールド
    fireEvent.change(textarea, { target: { value: "新状況" } });

    mockFetch.mockImplementationOnce((url: string, init?: { method?: string }) => {
      expect(init?.method).toBe("PUT");
      expect(url).toContain("/chunks/1");
      return Promise.resolve(okRes({ id: 1, metadata: { embedding_status: "done" }, embedding_updated: true }));
    });
    // 保存後の再読み込み
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({ chunks: [baseChunk({ embedding_status: "done" })] })));
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({})));

    fireEvent.click(screen.getByText("保存"));
    expect(await screen.findByText("保存しました")).toBeTruthy();
  });

  it("埋め込みに失敗しても保存自体は成功として扱い、区別して通知する", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    const textarea = (await screen.findAllByRole("textbox"))[1]!;
    fireEvent.change(textarea, { target: { value: "新状況" } });

    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(okRes({ id: 1, metadata: { embedding_status: "failed" }, embedding_updated: false }))
    );
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({ chunks: [baseChunk({ embedding_status: "failed" })] })));
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({})));

    fireEvent.click(screen.getByText("保存"));
    expect(await screen.findByText(/内容は保存できましたが、AIが覚えるのに失敗しました/)).toBeTruthy();
  });

  it("通信断(fetch例外)では「保存できませんでした」と表示する", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    const textarea = (await screen.findAllByRole("textbox"))[1]!;
    fireEvent.change(textarea, { target: { value: "新状況" } });

    mockFetch.mockImplementationOnce(() => Promise.reject(new Error("network down")));

    fireEvent.click(screen.getByText("保存"));
    expect(await screen.findByText("保存できませんでした")).toBeTruthy();
  });

  it("反映中の409応答は専門用語を出さない文言で伝える", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    const textarea = (await screen.findAllByRole("textbox"))[1]!;
    fireEvent.change(textarea, { target: { value: "新状況" } });

    mockFetch.mockImplementationOnce(() => Promise.resolve(errRes(409, "他の編集が反映処理中です")));

    fireEvent.click(screen.getByText("保存"));
    expect(await screen.findByText(/AIが今ちょうど覚えている最中です/)).toBeTruthy();
    expect(screen.queryByText(/反映処理中/)).not.toBeTruthy();
  });
});

describe("BookChunksPanel — 取り消し", () => {
  it("編集履歴があるチャンクには「元に戻す」ボタンが出る", async () => {
    mockChunksAndDetail([
      baseChunk({
        edit_history: [{ at: "2026-08-29T00:00:00Z", by: "u1", changes: { situation: { from: "旧状況", to: "新状況" } } }],
      }),
    ]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText(/元に戻す/)).toBeTruthy();
  });

  it("編集履歴が無いチャンクには「元に戻す」ボタンが出ない", async () => {
    mockChunksAndDetail([baseChunk()]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    await screen.findByText("編集");
    expect(screen.queryByText(/元に戻す/)).not.toBeTruthy();
  });

  it("「元に戻す」は履歴の変更前の値でPUTし直し、成功を通知する", async () => {
    mockChunksAndDetail([
      baseChunk({
        edit_history: [{ at: "2026-08-29T00:00:00Z", by: "u1", changes: { situation: { from: "旧状況", to: "新状況" } } }],
      }),
    ]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    const undoBtn = await screen.findByText(/元に戻す/);

    mockFetch.mockImplementationOnce((_url: string, init?: { method?: string; body?: string }) => {
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body.situation).toBe("旧状況");
      return Promise.resolve(okRes({ id: 1, metadata: { embedding_status: "done" } }));
    });
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({ chunks: [baseChunk({ embedding_status: "done" })] })));
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({})));

    fireEvent.click(undoBtn);
    expect(await screen.findByText("直前の変更を取り消しました")).toBeTruthy();
  });
});
