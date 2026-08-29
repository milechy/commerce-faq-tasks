// src/api/admin/knowledge/bookPdfRoutes.test.ts
// Phase44: 書籍PDFアップロードAPI テスト

import express from "express";
import request from "supertest";
import { registerBookPdfRoutes } from "./bookPdfRoutes";

// supabaseAdmin をモック
jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn().mockReturnValue({
        upload: jest.fn().mockResolvedValue({ error: null }),
        remove: jest.fn().mockResolvedValue({ error: null }),
      }),
    },
  },
}));

// logger をモック（console spy から pino logger spy に移行）
jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

// pipelineQueue をモック（重要）:
// 本テストはルートの責務のみを検証する。実 pipelineQueue.enqueue を走らせると、
// 全クエリが canned 値を返すモック db と DB-backed queue (#227) が組み合わさり、
// バックグラウンドの非同期処理が無限ループ化 → jest ヒープ OOM (exit 134) を起こす
// (Gate 1 赤化の根本原因)。enqueue を no-op 化して副作用を遮断する。
jest.mock("../../../lib/book-pipeline/pipelineQueue", () => ({
  pipelineQueue: { enqueue: jest.fn().mockResolvedValue(undefined) },
}));

// T6: チャンク編集時の再埋め込みを個別に制御するため embedText をモックする
// (NODE_ENV=test のデフォルト挙動はランダムベクトルで常に成功するため、
// 障害系のテストには使えない)。
jest.mock("../../../agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue(Array.from({ length: 5 }, () => 0.1)),
}));

import { supabaseAdmin } from "../../../auth/supabaseClient";
import { logger } from "../../../lib/logger";
import { embedText } from "../../../agent/llm/openaiEmbeddingClient";

// ── テスト用 Express アプリ生成 ───────────────────────────────────────────
function makeApp(opts: {
  dbRows?: Record<string, unknown>[];
  dbError?: Error;
  role?: string;
  tenantId?: string | null;
  userId?: string;
}) {
  const { role = "client_admin", tenantId = "tenant-a", userId = "user-1" } = opts;

  const app = express();
  app.use(express.json());

  // 認証ミドルウェア: req.user をセット（テスト用バイパス）
  const noopAuth = (req: any, _res: any, next: any) => {
    req.user = { id: userId, role, tenantId, email: "test@example.com" };
    next();
  };
  const noopRole = (req: any, res: any, next: any) => {
    const u = req.user;
    if (!u || !["super_admin", "client_admin"].includes(u.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
  const noopTenant = (_req: any, _res: any, next: any) => next();

  // DB モック
  const db: any = {
    query: jest.fn().mockImplementation(() => {
      if (opts.dbError) return Promise.reject(opts.dbError);
      return Promise.resolve({
        rows: opts.dbRows ?? [],
        rowCount: (opts.dbRows ?? []).length,
      });
    }),
  };

  registerBookPdfRoutes(app, db, noopAuth, noopRole, noopTenant);
  return { app, db };
}

// 最小PDFバッファ（マジックバイト %PDF）
const PDF_BUFFER = Buffer.from("%PDF-1.4 test content");

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.KNOWLEDGE_ENCRYPTION_KEY;

  // supabaseAdmin.storage.from() を毎回リセット
  (supabaseAdmin!.storage.from as jest.Mock).mockReturnValue({
    upload: jest.fn().mockResolvedValue({ error: null }),
    remove: jest.fn().mockResolvedValue({ error: null }),
  });
});

// ─── POST テスト ────────────────────────────────────────────────────────────

describe("POST /v1/admin/knowledge/book-pdf", () => {
  // GID 1217040818410419: 書籍/PDF投入はR2C運用限定になったため、投入経路の検証(1〜4, 9, 9b)は
  // super_admin で行う。client_admin側のガード自体は専用describe「R2C運用限定ガード」で検証する。
  it("1. 正常アップロード → 201 + { id, title, status: 'uploaded' }", async () => {
    const now = new Date().toISOString();
    const { app } = makeApp({
      role: "super_admin",
      dbRows: [{ id: 1, title: "テスト書籍", status: "uploaded", created_at: now }],
    });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, title: "テスト書籍", status: "uploaded" });
  });

  it("2. 非PDFファイル → 400 + PDFエラーメッセージ", async () => {
    const { app } = makeApp({ role: "super_admin" });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", Buffer.from("not a pdf"), { filename: "test.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("PDFまたはZIP");
  });

  it("3. 50MB超過 → 413", async () => {
    const { app } = makeApp({ role: "super_admin" });
    const bigBuffer = Buffer.alloc(51 * 1024 * 1024, "a");

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "大きな書籍")
      .attach("file", bigBuffer, { filename: "big.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain("50MB");
  });

  it("4. titleなし → 400", async () => {
    const { app } = makeApp({ role: "super_admin" });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("タイトル");
  });

  it("5. 認証なし → 401", async () => {
    const app = express();
    app.use(express.json());
    // 認証で401を返すミドルウェア
    const authReject = (_req: any, res: any) => res.status(401).json({ error: "Unauthorized" });
    const db: any = { query: jest.fn() };
    registerBookPdfRoutes(app, db, authReject as any, (_r, _s, n) => n(), (_r, _s, n) => n());

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
  });

  it("6. super_adminが?tenant=で対象テナントを指定 → そのテナントIDで保存される", async () => {
    // GID 1217040818410419 以降、POST自体がsuper_admin限定になったため、この経路の主体も
    // super_adminにした。resolveUploadTenantId のsuper_admin分岐(query指定)を検証する。
    const now = new Date().toISOString();
    const { app, db } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbRows: [{ id: 2, title: "書籍", status: "uploaded", created_at: now }],
    });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf?tenant=tenant-b")
      .field("title", "書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const insertCall = (db.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO book_uploads")
    );
    expect(insertCall[1][0]).toBe("tenant-b");
  });
});

// GID 1217040818410419: 「書籍/PDFはR2C運用限定」の実装反映。UI側の制限だけでは直叩きで
// 破られるため、投入系エンドポイントのサーバー側ガードをここで固定する。
describe("POST /v1/admin/knowledge/book-pdf — R2C運用限定ガード", () => {
  it("client_admin JWT → 403（テナントからの投入は不可）", async () => {
    const { app } = makeApp({ role: "client_admin" });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
    // 専門用語(ステータスコード/権限/MIME等)を出さない、優しい日本語であること
    expect(res.body.error).not.toMatch(/403|権限|MIME/);
  });

  it("super_admin JWT → 従来通り201で成功する（previewMode相当の回帰防止）", async () => {
    const now = new Date().toISOString();
    const { app } = makeApp({
      role: "super_admin",
      dbRows: [{ id: 3, title: "テスト書籍", status: "uploaded", created_at: now }],
    });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
  });

  // ガードは `user?.role === "super_admin"` の厳密等価判定のみで安全側(拒否)に倒れる設計。
  // JWTのroleクレームが欠落/破損した場合も、誤って通過しない(fail-closed)ことを固定する。
  it.each([
    ["null", null],
    ["空文字列", ""],
    ["大文字違い(Super_Admin)", "Super_Admin"],
  ])("roleが%s → 403（super_adminと誤認しない）", async (_label, role) => {
    const { app } = makeApp({ role: role as unknown as string });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
  });
});

describe("POST /v1/admin/knowledge/book-pdf/:id/process — R2C運用限定ガード", () => {
  it("client_admin JWT → 403（構造化パイプラインの起動もR2C運用限定）", async () => {
    const { app } = makeApp({
      role: "client_admin",
      dbRows: [{ id: 1, tenant_id: "tenant-a", status: "uploaded" }],
    });

    const res = await request(app).post("/v1/admin/knowledge/book-pdf/1/process");

    expect(res.status).toBe(403);
    expect(res.body.error).not.toMatch(/403|権限|MIME/);
  });

  it("super_admin JWT → 従来通り202で処理を開始する", async () => {
    const { app } = makeApp({
      role: "super_admin",
      dbRows: [{ id: 1, tenant_id: "tenant-a", status: "uploaded" }],
    });

    const res = await request(app).post("/v1/admin/knowledge/book-pdf/1/process");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, bookId: 1 });
  });

  it.each([
    ["null", null],
    ["空文字列", ""],
    ["大文字違い(Super_Admin)", "Super_Admin"],
  ])("roleが%s → 403（super_adminと誤認しない）", async (_label, role) => {
    const { app } = makeApp({
      role: role as unknown as string,
      dbRows: [{ id: 1, tenant_id: "tenant-a", status: "uploaded" }],
    });

    const res = await request(app).post("/v1/admin/knowledge/book-pdf/1/process");

    expect(res.status).toBe(403);
  });
});

// ─── GET 一覧テスト ─────────────────────────────────────────────────────────

describe("GET /v1/admin/knowledge/book-pdf", () => {
  it("7. 書籍一覧 → 200 + { books, total }", async () => {
    const now = new Date().toISOString();
    const { app } = makeApp({
      dbRows: [
        { id: 1, tenant_id: "tenant-a", title: "書籍1", original_filename: "a.pdf", status: "uploaded", page_count: null, chunk_count: 0, file_size_bytes: 1024, created_at: now },
        { id: 2, tenant_id: "tenant-a", title: "書籍2", original_filename: "b.pdf", status: "embedded", page_count: 10, chunk_count: 20, file_size_bytes: 2048, created_at: now },
      ],
    });

    const res = await request(app).get("/v1/admin/knowledge/book-pdf");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.books).toHaveLength(2);
    // storage_path が含まれていないこと
    for (const book of res.body.books) {
      expect(book).not.toHaveProperty("storage_path");
    }
  });
});

// ─── DELETE テスト ──────────────────────────────────────────────────────────

describe("DELETE /v1/admin/knowledge/book-pdf/:id", () => {
  it("8. 削除 → Storage + DB + faq_embeddings 削除", async () => {
    const storageMock = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      remove: jest.fn().mockResolvedValue({ error: null }),
    };
    (supabaseAdmin!.storage.from as jest.Mock).mockReturnValue(storageMock);

    const db: any = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT id, tenant_id, storage_path")) {
          return Promise.resolve({
            rows: [{ id: 1, tenant_id: "tenant-a", storage_path: "tenant-a/uuid.pdf.enc" }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    const app = express();
    const noopAuth = (req: any, _res: any, next: any) => {
      req.user = { id: "u1", role: "client_admin", tenantId: "tenant-a", email: "" };
      next();
    };
    registerBookPdfRoutes(app, db, noopAuth, (_r, _s, n) => n(), (_r, _s, n) => n());

    const res = await request(app).delete("/v1/admin/knowledge/book-pdf/1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: 1 });

    // Storage の remove が呼ばれたか
    expect(storageMock.remove).toHaveBeenCalledWith(["tenant-a/uuid.pdf.enc"]);

    // faq_embeddings の削除クエリが呼ばれたか
    const embedDeleteCall = (db.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("DELETE FROM faq_embeddings")
    );
    expect(embedDeleteCall).toBeTruthy();
    expect(embedDeleteCall[1][0]).toBe(1);

    // book_uploads の削除クエリが呼ばれたか
    const bookDeleteCall = (db.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("DELETE FROM book_uploads")
    );
    expect(bookDeleteCall).toBeTruthy();
  });

  it("8b. ナレッジ配線是正P9: faq_embeddings削除と同時にESドキュメントも削除する(以前は残っていた)", async () => {
    const db: any = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT id, tenant_id, storage_path")) {
          return Promise.resolve({
            rows: [{ id: 1, tenant_id: "tenant-a", storage_path: "tenant-a/uuid.pdf.enc" }],
            rowCount: 1,
          });
        }
        if (sql.includes("chunk_index")) {
          return Promise.resolve({ rows: [{ chunk_index: 0 }, { chunk_index: 1 }], rowCount: 2 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    const origEsUrl = process.env.ES_URL;
    process.env.ES_URL = "http://es.test:9200";
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url: unknown, init?: { method?: string }) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return { ok: true, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const app = express();
      const noopAuth = (req: any, _res: any, next: any) => {
        req.user = { id: "u1", role: "client_admin", tenantId: "tenant-a", email: "" };
        next();
      };
      registerBookPdfRoutes(app, db, noopAuth, (_r, _s, n) => n(), (_r, _s, n) => n());

      const res = await request(app).delete("/v1/admin/knowledge/book-pdf/1");

      expect(res.status).toBe(200);
      const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
      expect(deleteCalls).toHaveLength(2);
      expect(deleteCalls.map((c) => c.url).sort()).toEqual([
        expect.stringContaining("book_1_chunk_0"),
        expect.stringContaining("book_1_chunk_1"),
      ].sort());
    } finally {
      global.fetch = originalFetch;
      if (origEsUrl !== undefined) process.env.ES_URL = origEsUrl; else delete process.env.ES_URL;
    }
  });
});

// ─── PUT /chunks/:chunkId テスト(T6: 再埋め込み + 編集履歴) ────────────────

describe("PUT /v1/admin/knowledge/book-pdf/chunks/:chunkId", () => {
  /**
   * チャンク編集のDBモック。SELECT/CAS-UPDATE/embedding確定UPDATE/失敗時UPDATEの
   * 4種類のクエリ形を SQL 文字列で判別する。
   */
  function makeChunkDb(chunkRow: {
    id: number;
    metadata: Record<string, unknown>;
    is_excluded_from_search: boolean;
    tenant_id: string;
  } | null) {
    const calls: { sql: string; params: unknown[] }[] = [];
    // Postgres の `metadata || $1::jsonb` を模して、UPDATEのたびに累積させる
    // (実DBは毎回同じ行を上書きするため、途中UPDATEの結果を次のUPDATEが引き継ぐ)。
    let currentMetadata = chunkRow ? { ...chunkRow.metadata } : {};
    const db: any = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });

        if (sql.includes("JOIN book_uploads bu")) {
          return chunkRow
            ? Promise.resolve({ rows: [{ ...chunkRow, metadata: currentMetadata }], rowCount: 1 })
            : Promise.resolve({ rows: [], rowCount: 0 });
        }

        if (sql.includes("COALESCE(metadata->>'embedding_status'")) {
          const meta = currentMetadata as Record<string, unknown>;
          const staleCutoff = params[2] as string;
          const updatedAt = meta["embedding_updated_at"] as string | undefined;
          const stillFreshlyPending =
            meta["embedding_status"] === "pending" &&
            (updatedAt == null ? false : new Date(updatedAt) >= new Date(staleCutoff));
          if (stillFreshlyPending) {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          const patch = JSON.parse(params[0] as string);
          currentMetadata = { ...currentMetadata, ...patch };
          return Promise.resolve({
            rows: [{ id: chunkRow!.id, metadata: currentMetadata }],
            rowCount: 1,
          });
        }

        if (sql.includes("embedding = $1::vector")) {
          const patch = JSON.parse(params[1] as string);
          currentMetadata = { ...currentMetadata, ...patch };
          return Promise.resolve({
            rows: [{ id: chunkRow!.id, metadata: currentMetadata }],
            rowCount: 1,
          });
        }

        // 失敗時フォールバックUPDATE(embedding_status: 'failed')
        const patch = JSON.parse(params[0] as string);
        currentMetadata = { ...currentMetadata, ...patch };
        return Promise.resolve({
          rows: [{ id: chunkRow!.id, metadata: currentMetadata }],
          rowCount: 1,
        });
      }),
    };
    return { db, calls };
  }

  function makeChunkApp(
    chunkRow: { id: number; metadata: Record<string, unknown>; is_excluded_from_search: boolean; tenant_id: string } | null,
    opts: { role?: string; tenantId?: string | null; userId?: string } = {}
  ) {
    const { role = "client_admin", tenantId = "tenant-a", userId = "user-1" } = opts;
    const { db, calls } = makeChunkDb(chunkRow);
    const app = express();
    app.use(express.json());
    const noopAuth = (req: any, _res: any, next: any) => {
      req.user = { id: userId, role, tenantId, email: "" };
      next();
    };
    registerBookPdfRoutes(app, db, noopAuth, (_r: any, _s: any, n: any) => n(), (_r: any, _s: any, n: any) => n());
    return { app, db, calls };
  }

  beforeEach(() => {
    (embedText as jest.Mock).mockReset().mockResolvedValue(Array.from({ length: 5 }, () => 0.1));
    delete process.env.ES_URL;
  });

  it("psychology_book スキーマのフィールド編集で再埋め込みが行われ、embedding_status='done' になる", async () => {
    const chunkRow = {
      id: 10,
      metadata: {
        source: "book",
        book_id: 1,
        chunk_index: 2,
        principle: "アンカリング効果",
        situation: "旧・状況",
        example: "旧・例",
        contraindication: "旧・禁忌",
      },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app, calls } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/10")
      .send({ situation: "新・状況" });

    expect(res.status).toBe(200);
    expect(res.body.embedding_updated).toBe(true);
    expect(res.body.metadata.embedding_status).toBe("done");
    expect(res.body.metadata.embedding_updated_at).toBeDefined();
    expect(res.body.metadata.edit_history).toHaveLength(1);
    expect(res.body.metadata.edit_history[0].changes).toEqual({
      situation: { from: "旧・状況", to: "新・状況" },
    });

    expect(embedText).toHaveBeenCalledTimes(1);
    const [searchText] = (embedText as jest.Mock).mock.calls[0];
    expect(searchText).toContain("新・状況");

    // CASのUPDATEが先に embedding_status='pending' を書いていること
    const casCall = calls.find((c) => c.sql.includes("COALESCE(metadata->>'embedding_status'"));
    expect(casCall).toBeDefined();
    expect(JSON.parse(casCall!.params[0] as string).embedding_status).toBe("pending");
  });

  it("sales_manual スキーマ(problem/solution/objection_handling)でも再埋め込みが行われる", async () => {
    const chunkRow = {
      id: 11,
      metadata: {
        source: "book",
        book_id: 2,
        chunk_index: 3,
        target_customer: "中小企業の経営者",
        problem: "商談の主導権を握られる",
        solution: "旧・解決策",
        benefit: "売れる",
        objection_handling: "価格の反論に対処する",
      },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/11")
      .send({ solution: "新・解決策" });

    expect(res.status).toBe(200);
    expect(res.body.embedding_updated).toBe(true);
    const [searchText] = (embedText as jest.Mock).mock.calls[0];
    expect(searchText).toContain("新・解決策");
    expect(searchText).toContain("商談の主導権を握られる");
  });

  it("埋め込みAPI障害時も文言の保存自体は成功する(保存済みと反映済みを別状態で扱う)", async () => {
    (embedText as jest.Mock).mockReset().mockRejectedValue(new Error("OpenAI API down"));
    const chunkRow = {
      id: 12,
      metadata: { source: "book", book_id: 1, chunk_index: 0, principle: "希少性", situation: "旧" },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/12")
      .send({ situation: "新" });

    expect(res.status).toBe(200);
    expect(res.body.embedding_updated).toBe(false);
    expect(res.body.metadata.situation).toBe("新");
    expect(res.body.metadata.embedding_status).toBe("failed");
  });

  it("値が変わらないパッチは再埋め込みも履歴追加もスキップする(連打対策)", async () => {
    const chunkRow = {
      id: 13,
      metadata: { source: "book", book_id: 1, chunk_index: 0, principle: "希少性", situation: "同じ状況" },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app, calls } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/13")
      .send({ situation: "同じ状況" });

    expect(res.status).toBe(200);
    expect(res.body.embedding_updated).toBe(false);
    expect(embedText).not.toHaveBeenCalled();
    // SELECT以外のUPDATE系クエリが発行されていないこと
    const updateCalls = calls.filter((c) => c.sql.includes("UPDATE faq_embeddings"));
    expect(updateCalls).toHaveLength(0);
  });

  it("embedding_status='pending' が新しい間の二重送信は409で弾かれる(連打対策)", async () => {
    const chunkRow = {
      id: 14,
      metadata: {
        source: "book",
        book_id: 1,
        chunk_index: 0,
        principle: "希少性",
        situation: "状況",
        embedding_status: "pending",
        embedding_updated_at: new Date().toISOString(), // たった今 pending になった
      },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/14")
      .send({ situation: "別の状況" });

    expect(res.status).toBe(409);
    expect(embedText).not.toHaveBeenCalled();
  });

  // 2026-08-29 再レビュー: pending 書き込み後にプロセスが落ちると、CASの条件が
  // 「pendingでない」だけだと永久に409を返し続け、運用者のDB直接操作でしか
  // 復帰できなかった。book_pipeline_jobs の checkStuckJobs() と同じ考え方で、
  // 一定時間より古い pending は期限切れとみなして奪えることを確認する。
  it("embedding_status='pending' が古い(CHUNK_STALE_PENDING_MS超)場合は奪って再実行できる", async () => {
    const chunkRow = {
      id: 18,
      metadata: {
        source: "book",
        book_id: 1,
        chunk_index: 0,
        principle: "希少性",
        situation: "状況",
        embedding_status: "pending",
        embedding_updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10分前=期限切れ
      },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/18")
      .send({ situation: "別の状況" });

    expect(res.status).toBe(200);
    expect(res.body.embedding_updated).toBe(true);
    expect(res.body.metadata.embedding_status).toBe("done");
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it("embedding_status='pending' だが embedding_updated_at が無い(異常系)場合も奪って再実行できる", async () => {
    const chunkRow = {
      id: 19,
      metadata: {
        source: "book",
        book_id: 1,
        chunk_index: 0,
        principle: "希少性",
        situation: "状況",
        embedding_status: "pending",
        // embedding_updated_at が無い異常系(このコード以前に作られた行を想定)
      },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/19")
      .send({ situation: "別の状況" });

    expect(res.status).toBe(200);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it("product_catalog等 principleSchemaMap に無いスキーマは保存されるが再埋め込みはしない", async () => {
    const chunkRow = {
      id: 15,
      metadata: {
        source: "book",
        book_id: 3,
        chunk_index: 0,
        product_name: "商品A",
        spec: "旧仕様",
      },
      is_excluded_from_search: false,
      tenant_id: "tenant-a",
    };
    const { app } = makeChunkApp(chunkRow);

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/15")
      .send({ spec: "新仕様" });

    expect(res.status).toBe(200);
    expect(res.body.embedding_updated).toBe(false);
    expect(res.body.metadata.spec).toBe("新仕様");
    expect(res.body.metadata.edit_history).toHaveLength(1);
    expect(embedText).not.toHaveBeenCalled();
  });

  it("client_admin が他テナントのチャンクを編集すると403、履歴にも残らない", async () => {
    const chunkRow = {
      id: 16,
      metadata: { source: "book", book_id: 1, chunk_index: 0, principle: "希少性", situation: "状況" },
      is_excluded_from_search: false,
      tenant_id: "tenant-b", // 別テナント
    };
    const { app, calls } = makeChunkApp(chunkRow, { role: "client_admin", tenantId: "tenant-a" });

    const res = await request(app)
      .put("/v1/admin/knowledge/book-pdf/chunks/16")
      .send({ situation: "改ざん" });

    expect(res.status).toBe(403);
    expect(embedText).not.toHaveBeenCalled();
    const updateCalls = calls.filter((c) => c.sql.includes("UPDATE faq_embeddings"));
    expect(updateCalls).toHaveLength(0);
  });

  it("再埋め込み成功時にES(upsertToEs)へ is_excluded_from_search を維持したまま同期する", async () => {
    process.env.ES_URL = "http://es.test:9200";
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
      return { ok: true, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const chunkRow = {
        id: 17,
        metadata: {
          source: "book",
          book_id: 5,
          chunk_index: 2,
          principle: "希少性",
          situation: "旧状況",
          example: "旧例",
        },
        is_excluded_from_search: true, // 既に検索除外中のチャンク
        tenant_id: "tenant-a",
      };
      const { app } = makeChunkApp(chunkRow);

      const res = await request(app)
        .put("/v1/admin/knowledge/book-pdf/chunks/17")
        .send({ situation: "新状況" });

      expect(res.status).toBe(200);
      const putCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("book_5_chunk_2"));
      expect(putCall).toBeDefined();
      const doc = JSON.parse(putCall!.body!);
      // 既存のフラグを落として黙って巻き戻さない(knowledge.md の既知不具合の再発防止)
      expect(doc.is_excluded_from_search).toBe(true);
      expect(doc.is_published).toBe(true);
    } finally {
      global.fetch = originalFetch;
      delete process.env.ES_URL;
    }
  });
});

// ─── 暗号化フォールバックテスト ─────────────────────────────────────────────

describe("KNOWLEDGE_ENCRYPTION_KEY 暗号化", () => {
  it("9. KNOWLEDGE_ENCRYPTION_KEY 未設定 → 平文保存 + logger.warn", async () => {
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
    const warnMock = logger.warn as jest.MockedFunction<typeof logger.warn>;
    warnMock.mockClear();

    const now = new Date().toISOString();
    const { app, db } = makeApp({
      role: "super_admin",
      dbRows: [{ id: 1, title: "書籍", status: "uploaded", created_at: now }],
    });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("KNOWLEDGE_ENCRYPTION_KEY未設定")
    );

    // encryption_iv が null で保存されているか
    const insertCall = (db.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO book_uploads")
    );
    const params = insertCall[1] as unknown[];
    expect(params[5]).toBeNull(); // encryption_iv = null
  });

  it("9b. KNOWLEDGE_ENCRYPTION_KEY 設定済み → 暗号化保存 + encryption_iv あり", async () => {
    process.env.KNOWLEDGE_ENCRYPTION_KEY = "a".repeat(64);

    const now = new Date().toISOString();
    const { app, db } = makeApp({
      role: "super_admin",
      dbRows: [{ id: 2, title: "書籍", status: "uploaded", created_at: now }],
    });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);

    const insertCall = (db.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO book_uploads")
    );
    const params = insertCall[1] as unknown[];
    // encryption_iv が null でないこと
    expect(params[5]).not.toBeNull();
    // storage_path が .enc で終わること
    expect(params[3]).toMatch(/\.enc$/);

    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
  });
});
