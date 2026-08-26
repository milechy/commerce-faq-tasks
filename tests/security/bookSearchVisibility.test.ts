// tests/security/bookSearchVisibility.test.ts
//
// PATCH /v1/admin/knowledge/book-pdf/:id/search-visibility
//
// tenant_id='global' の書籍チャンクはフラグ無しに全テナントの回答へ引かれる
// (src/search/pgvectorSearch.ts:62)。加えて書籍チャンクは metadata.faq_id を
// 持たない設計のため faq_docs 側の可視性ゲートを構造的にバイパスする
// (src/search/pgvector.ts:68-80)。投入内容に問題が見つかったとき、従来は
// DELETE(Storage ごと消える不可逆操作)しか手が無かった。可逆に止められることを固定する。

import type { Express } from "express";
import type { Pool } from "pg";
import { registerBookPdfRoutes } from "../../src/api/admin/knowledge/bookPdfRoutes";

const mockSetExcludedInEs = jest.fn();
jest.mock("../../src/lib/book-pipeline/embedAndStore", () => ({
  deleteBookChunkFromEs: jest.fn(),
  setBookChunkExcludedInEs: (...args: unknown[]) => mockSetExcludedInEs(...args),
}));

jest.mock("../../src/auth/supabaseClient", () => ({ supabaseAdmin: null }));

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

/** ルート登録だけを捕まえ、ハンドラを直接呼ぶ(supertest のフレークを避ける)。 */
function captureHandler(db: Pool): Handler {
  let handler: Handler | undefined;
  const app = {
    post: () => {},
    get: () => {},
    put: () => {},
    delete: () => {},
    patch: (path: string, ..._rest: unknown[]) => {
      if (path.endsWith("/search-visibility")) {
        handler = _rest[_rest.length - 1] as Handler;
      }
    },
  } as unknown as Express;

  const pass = (_r: unknown, _s: unknown, next: () => void) => next();
  registerBookPdfRoutes(app, db, pass, pass, pass);
  if (!handler) throw new Error("search-visibility route was not registered");
  return handler;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const SUPER_ADMIN = { role: "super_admin", tenantId: "r2c" };

function mockDb(bookRow: Record<string, unknown> | null, chunkIndexes: number[] = [0, 1]) {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM book_uploads")) {
      return Promise.resolve({ rows: bookRow ? [bookRow] : [], rowCount: bookRow ? 1 : 0 });
    }
    if (sql.includes("UPDATE faq_embeddings")) {
      return Promise.resolve({
        rows: chunkIndexes.map((chunk_index) => ({ chunk_index })),
        rowCount: chunkIndexes.length,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query } as unknown as Pool;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["ES_URL"] = "http://es.test";
});

afterEach(() => {
  delete process.env["ES_URL"];
});

describe("書籍を削除せずに検索から外せる", () => {
  it("global書籍を除外に切り替えると pgvector と ES の両方を揃える", async () => {
    const db = mockDb({ id: 7, tenant_id: "global" });
    const handler = captureHandler(db);
    const res = mockRes();

    await handler({ params: { id: "7" }, body: { excluded: true }, user: SUPER_ADMIN }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 7, excluded: true, chunks: 2 });

    // pgvector 側: 書籍チャンクに唯一効くフラグを立てる
    const update = (db.query as jest.Mock).mock.calls
      .map((c) => c[0] as string)
      .find((sql) => sql.includes("UPDATE faq_embeddings"));
    expect(update).toContain("is_excluded_from_search");
    expect(update).toContain("metadata->>'book_id'");

    // ES 側: 揃えないと BM25 経由で引け続ける
    expect(mockSetExcludedInEs).toHaveBeenCalledTimes(2);
    expect(mockSetExcludedInEs).toHaveBeenCalledWith(
      "http://es.test",
      "global",
      "book_7_chunk_0",
      true,
    );
  });

  it("除外を解除できる(可逆)", async () => {
    const db = mockDb({ id: 7, tenant_id: "global" }, [0]);
    const handler = captureHandler(db);
    const res = mockRes();

    await handler({ params: { id: "7" }, body: { excluded: false }, user: SUPER_ADMIN }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ excluded: false });
    expect(mockSetExcludedInEs).toHaveBeenCalledWith(
      "http://es.test",
      "global",
      "book_7_chunk_0",
      false,
    );
  });

  it("他テナントの書籍は操作できない", async () => {
    const db = mockDb({ id: 7, tenant_id: "tenant-a" });
    const handler = captureHandler(db);
    const res = mockRes();

    await handler(
      { params: { id: "7" }, body: { excluded: true }, user: { role: "client_admin", tenantId: "tenant-b" } },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(mockSetExcludedInEs).not.toHaveBeenCalled();
  });

  it("excluded が boolean でなければ 400", async () => {
    const db = mockDb({ id: 7, tenant_id: "global" });
    const handler = captureHandler(db);
    const res = mockRes();

    await handler({ params: { id: "7" }, body: { excluded: "true" }, user: SUPER_ADMIN }, res);

    expect(res.statusCode).toBe(400);
    expect(mockSetExcludedInEs).not.toHaveBeenCalled();
  });

  it("存在しない書籍は 404", async () => {
    const db = mockDb(null);
    const handler = captureHandler(db);
    const res = mockRes();

    await handler({ params: { id: "99" }, body: { excluded: true }, user: SUPER_ADMIN }, res);

    expect(res.statusCode).toBe(404);
  });
});
