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

import { supabaseAdmin } from "../../../auth/supabaseClient";
import { logger } from "../../../lib/logger";

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
  it("1. 正常アップロード → 201 + { id, title, status: 'uploaded' }", async () => {
    const now = new Date().toISOString();
    const { app } = makeApp({
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
    const { app } = makeApp({});

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", Buffer.from("not a pdf"), { filename: "test.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("PDFまたはZIP");
  });

  it("3. 50MB超過 → 413", async () => {
    const { app } = makeApp({});
    const bigBuffer = Buffer.alloc(51 * 1024 * 1024, "a");

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "大きな書籍")
      .attach("file", bigBuffer, { filename: "big.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain("50MB");
  });

  it("4. titleなし → 400", async () => {
    const { app } = makeApp({});

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

  it("6. client_adminが他テナント → tenantIdはJWTから取得されるため403にならない（自テナントで保存）", async () => {
    // client_admin は req.user.tenantId を使うため body の tenant_id は無視される
    const now = new Date().toISOString();
    const { app, db } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbRows: [{ id: 2, title: "書籍", status: "uploaded", created_at: now }],
    });

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "書籍")
      .attach("file", PDF_BUFFER, { filename: "test.pdf", contentType: "application/pdf" });

    // tenant_id は JWT から取得 → tenant-a で保存される
    expect(res.status).toBe(201);
    const insertCall = (db.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO book_uploads")
    );
    expect(insertCall[1][0]).toBe("tenant-a");
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
});

// ─── 暗号化フォールバックテスト ─────────────────────────────────────────────

describe("KNOWLEDGE_ENCRYPTION_KEY 暗号化", () => {
  it("9. KNOWLEDGE_ENCRYPTION_KEY 未設定 → 平文保存 + logger.warn", async () => {
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
    const warnMock = logger.warn as jest.MockedFunction<typeof logger.warn>;
    warnMock.mockClear();

    const now = new Date().toISOString();
    const { app, db } = makeApp({
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
