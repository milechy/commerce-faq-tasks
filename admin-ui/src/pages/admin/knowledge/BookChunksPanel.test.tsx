// admin-ui/src/pages/admin/knowledge/BookChunksPanel.test.tsx
// T7: チャンク編集の反映状態(覚え直しています/覚えました/失敗)・保存前の影響範囲提示・
// 取り消し導線の回帰テスト。専門用語(チャンク/ベクトル/埋め込み/テナント等)を
// 画面に出さない方針(.claude/rules 参照)もあわせて検証する。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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

describe("BookChunksPanel — 2つの画面で同時編集した場合の挙動(現状固定)", () => {
  // このパネルはURLに紐付かない単なるモーダルで、他の編集者がいることをこの画面自身は
  // 知らない。だが保存のたびに「編集を始めた時点で読み込んでいた版」
  // (metadata.content_updated_at)をサーバーに送り返し、サーバー側で既に他の人が
  // 保存済み(=版が進んでいる)なら楽観ロックで409(conflict)として弾かれる。
  // 同じチャンクを2つのブラウザタブで開き、片方が既に保存済みのケースで、
  // 後から保存した側が気づかず上書きすることはなく、画面にもそれと分かる表示が
  // 出ることを固定する。
  it("先に保存した側の変更を、後から保存した側は気づかず上書きせず、409(conflict)として弾かれて画面にも表示される", async () => {
    mockChunksAndDetail([baseChunk()]); // situation: "旧状況", principle: "アンカリング効果", 版なし

    const { container: containerA } = render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    const { container: containerB } = render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );

    // 2つのタブ(=2つのパネルインスタンス)がどちらも同じ内容(版なし)で編集を開始する
    fireEvent.click(await within(containerA).findByText("編集"));
    fireEvent.click(await within(containerB).findByText("編集"));

    // タブA: 状況だけ変更して先に保存する。版なしで読み込んでいるので送信も版なし。
    const situationA = within(containerA).getByPlaceholderText("この知識が適用される状況");
    fireEvent.change(situationA, { target: { value: "新状況A" } });

    const bodiesA: Record<string, unknown>[] = [];
    mockFetch.mockImplementationOnce((_url: string, init?: { method?: string; body?: string }) => {
      expect(init?.method).toBe("PUT");
      bodiesA.push(JSON.parse(init!.body as string));
      // サーバー側も版なしなので通り、新しい版(content_updated_at)が発行される想定。
      return Promise.resolve(
        okRes({
          id: 1,
          metadata: {
            situation: "新状況A",
            embedding_status: "done",
            content_updated_at: "2026-08-30T00:00:00.000Z",
          },
        })
      );
    });
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        okRes({
          chunks: [
            baseChunk({
              situation: "新状況A",
              embedding_status: "done",
              content_updated_at: "2026-08-30T00:00:00.000Z",
            }),
          ],
        })
      )
    );
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({})));

    fireEvent.click(within(containerA).getByText("保存"));
    await within(containerA).findByText("保存しました");
    expect(bodiesA[0]?.situation).toBe("新状況A");
    expect(bodiesA[0]?.expected_content_updated_at).toBe(null); // タブAが読み込んだ時点は版なし

    // タブB: タブAの保存を知らないまま(版なしのまま)、原則だけ変更して保存する
    const principleB = within(containerB).getByPlaceholderText("適用すべき心理学原則");
    fireEvent.change(principleB, { target: { value: "新原則B" } });

    const bodiesB: Record<string, unknown>[] = [];
    mockFetch.mockImplementationOnce((_url: string, init?: { method?: string; body?: string }) => {
      expect(init?.method).toBe("PUT");
      bodiesB.push(JSON.parse(init!.body as string));
      // サーバー側は既にタブAの版に進んでいるため、タブBの版なし(=旧版)送信は
      // 楽観ロックで409(conflict)として弾かれる(実際のサーバー挙動をここで模する)。
      return Promise.resolve({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: "conflict",
            message: "他の人がこのチャンクを更新しました。最新の内容を読み直してから編集してください。",
            metadata: {
              situation: "新状況A",
              principle: "アンカリング効果",
              content_updated_at: "2026-08-30T00:00:00.000Z",
            },
          }),
      } as unknown as Response);
    });
    // 409のあと、画面は裏で一覧を最新化する(編集中の入力欄はそのまま保持し、打ち直しはさせない)
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        okRes({
          chunks: [
            baseChunk({
              situation: "新状況A",
              embedding_status: "done",
              content_updated_at: "2026-08-30T00:00:00.000Z",
            }),
          ],
        })
      )
    );
    mockFetch.mockImplementationOnce(() => Promise.resolve(okRes({})));

    fireEvent.click(within(containerB).getByText("保存"));

    // 画面に「他の人が更新した」ことが分かるメッセージが出る(汎用エラーに丸めない)
    expect(await within(containerB).findByText(/他の人がこの内容を更新しました/)).toBeTruthy();
    expect(within(containerB).queryByText("保存しました")).not.toBeTruthy();

    // タブBが送ったのは自分の(古い)版。実際のサーバーではこれが409で弾かれるため、
    // タブAの変更(situation)がタブBの入力によって黙って上書きされることはない。
    expect(bodiesB[0]?.expected_content_updated_at).toBe(null);
    expect(bodiesB[0]?.principle).toBe("新原則B");

    // 409のあとも入力欄の内容は残る(保存失敗で打ち直しにさせない)
    expect((within(containerB).getByPlaceholderText("適用すべき心理学原則") as HTMLTextAreaElement).value).toBe(
      "新原則B"
    );
  });
});

describe("BookChunksPanel — ブラウザの戻る(再マウント)時の挙動(現状固定)", () => {
  // このモーダルは親コンポーネントのstateだけでopen/closeされ、URL/履歴に紐付かない。
  // そのため「戻る」操作の多くはこのコンポーネント自体のアンマウントを伴う。ここでは
  // それを直接再現し、未保存の下書きが古い内容のまま無言で保存されてしまわないかを確認する。
  it("編集中に離脱(再マウント)すると未保存の下書きは残らず、再度開くと最新のサーバー内容から始まる", async () => {
    mockChunksAndDetail([baseChunk()]); // situation: "旧状況"
    const { unmount } = render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    fireEvent.click(await screen.findByText("編集"));
    const situation = screen.getByPlaceholderText("この知識が適用される状況");
    fireEvent.change(situation, { target: { value: "未保存の下書き" } });

    // ブラウザの戻るに相当する離脱(このパネルはURLに紐付かないため、実態は再マウント)
    unmount();

    // サーバー側では別の変更が既に入っている想定
    mockChunksAndDetail([baseChunk({ situation: "サーバー最新状況" })]);
    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );

    // 未保存の下書きはどこにも残らない(画面上にもPUTにも出ない)
    await screen.findByText("編集"); // 表示モード(編集していない状態)から始まる
    expect(screen.queryByText(/未保存の下書き/)).not.toBeTruthy();
    expect(mockFetch.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === "PUT")).toBe(
      false
    );
  });
});

describe("BookChunksPanel — 反映中(pending)表示の一貫性", () => {
  it("画面を閉じて何度開き直しても、反映中の文言は同じ表現のまま(別の言い回しに変わらない)", async () => {
    mockChunksAndDetail([baseChunk({ embedding_status: "pending" })]);

    const { unmount: unmount1 } = render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText("🧠 AIが覚え直しています…")).toBeTruthy();
    unmount1();

    const { unmount: unmount2 } = render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText("🧠 AIが覚え直しています…")).toBeTruthy();
    unmount2();

    render(
      <BookChunksPanel bookId={1} bookTitle="書籍" bookStatus="embedded" bookTenantId="tenant-a" onClose={() => {}} />
    );
    expect(await screen.findByText("🧠 AIが覚え直しています…")).toBeTruthy();
  });
});
