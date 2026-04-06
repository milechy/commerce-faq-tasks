// tests/phase59/zipUpload.test.ts
// Phase59: ZIP PDFアップロード機能テスト

import express from "express";
import request from "supertest";
import AdmZip from "adm-zip";
import { registerBookPdfRoutes } from "../../src/api/admin/knowledge/bookPdfRoutes";

// ── モック ──────────────────────────────────────────────────────────────────

jest.mock("../../src/auth/supabaseClient", () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn().mockReturnValue({
        upload: jest.fn().mockResolvedValue({ error: null }),
        remove: jest.fn().mockResolvedValue({ error: null }),
      }),
    },
  },
}));

jest.mock("../../src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

jest.mock("../../src/lib/book-pipeline/pipelineQueue", () => ({
  pipelineQueue: { enqueue: jest.fn() },
}));

// ── ヘルパー ────────────────────────────────────────────────────────────────

// 最小限の有効PDFバイト列（ヘッダのみ、実際には無効だがバイトテストに十分）
const MINIMAL_PDF = Buffer.from("%PDF-1.4\n%%EOF\n");

/** n件のPDFが入ったZIPバッファを生成 */
function makeZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const zip = new AdmZip();
  for (const e of entries) {
    zip.addFile(e.name, e.content);
  }
  return zip.toBuffer();
}

/**
 * 任意のエントリ名を持つ raw ZIP バッファを生成（テスト用）
 * AdmZip の addFile() はパスを正規化するため、raw バッファを手動生成する
 */
function makeRawZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDirEntries: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, "utf8");
    const lfhSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const lfhVersion = Buffer.from([0x14, 0x00]);
    const lfhFlags = Buffer.from([0x00, 0x00]);
    const lfhComp = Buffer.from([0x00, 0x00]);
    const lfhTime = Buffer.from([0x00, 0x00]);
    const lfhDate = Buffer.from([0x00, 0x00]);
    const lfhCrc = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const lfhCompSz = Buffer.alloc(4); lfhCompSz.writeUInt32LE(e.content.length);
    const lfhUncompSz = Buffer.alloc(4); lfhUncompSz.writeUInt32LE(e.content.length);
    const lfhNameLen = Buffer.alloc(2); lfhNameLen.writeUInt16LE(nameBytes.length);
    const lfhExtraLen = Buffer.from([0x00, 0x00]);

    const localHeader = Buffer.concat([lfhSig, lfhVersion, lfhFlags, lfhComp, lfhTime, lfhDate, lfhCrc, lfhCompSz, lfhUncompSz, lfhNameLen, lfhExtraLen, nameBytes, e.content]);

    const cdrSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const cdrVM = Buffer.from([0x14, 0x00]);
    const cdrVN = Buffer.from([0x14, 0x00]);
    const cdrFlags = Buffer.from([0x00, 0x00]);
    const cdrComp = Buffer.from([0x00, 0x00]);
    const cdrTime = Buffer.from([0x00, 0x00]);
    const cdrDate = Buffer.from([0x00, 0x00]);
    const cdrCrc = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const cdrCompSz = Buffer.alloc(4); cdrCompSz.writeUInt32LE(e.content.length);
    const cdrUncompSz = Buffer.alloc(4); cdrUncompSz.writeUInt32LE(e.content.length);
    const cdrNameLen = Buffer.alloc(2); cdrNameLen.writeUInt16LE(nameBytes.length);
    const cdrExtraLen = Buffer.from([0x00, 0x00]);
    const cdrCommentLen = Buffer.from([0x00, 0x00]);
    const cdrDiskStart = Buffer.from([0x00, 0x00]);
    const cdrIntAttr = Buffer.from([0x00, 0x00]);
    const cdrExtAttr = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const cdrOffset = Buffer.alloc(4); cdrOffset.writeUInt32LE(offset);

    const cdrEntry = Buffer.concat([cdrSig, cdrVM, cdrVN, cdrFlags, cdrComp, cdrTime, cdrDate, cdrCrc, cdrCompSz, cdrUncompSz, cdrNameLen, cdrExtraLen, cdrCommentLen, cdrDiskStart, cdrIntAttr, cdrExtAttr, cdrOffset, nameBytes]);

    localHeaders.push(localHeader);
    centralDirEntries.push(cdrEntry);
    offset += localHeader.length;
  }

  const localData = Buffer.concat(localHeaders);
  const cdrData = Buffer.concat(centralDirEntries);
  const cdrOffset = localData.length;

  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdZero = Buffer.from([0x00, 0x00]);
  const eocdEntries = Buffer.alloc(2); eocdEntries.writeUInt16LE(entries.length);
  const eocdTotal = Buffer.alloc(2); eocdTotal.writeUInt16LE(entries.length);
  const eocdCdrSz = Buffer.alloc(4); eocdCdrSz.writeUInt32LE(cdrData.length);
  const eocdCdrOff = Buffer.alloc(4); eocdCdrOff.writeUInt32LE(cdrOffset);
  const eocdCommentLen = Buffer.from([0x00, 0x00]);

  const eocd = Buffer.concat([eocdSig, eocdZero, eocdZero, eocdEntries, eocdTotal, eocdCdrSz, eocdCdrOff, eocdCommentLen]);

  return Buffer.concat([localData, cdrData, eocd]);
}

/** テスト用 Express アプリを生成 */
function makeApp(opts: {
  dbRows?: Record<string, unknown>[];
  role?: string;
  tenantId?: string | null;
}) {
  const { role = "client_admin", tenantId = "tenant-test" } = opts;

  const app = express();
  app.use(express.json());

  const noopAuth = (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", role, tenantId, email: "test@example.com" };
    next();
  };
  const noopRole = (_req: any, _res: any, next: any) => next();
  const noopTenant = (_req: any, _res: any, next: any) => next();

  // db モック: INSERT は id=1 を返す
  let insertCallCount = 0;
  const db = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO book_uploads")) {
        insertCallCount++;
        return Promise.resolve({
          rows: [{ id: insertCallCount, title: "test", status: "uploaded", created_at: new Date().toISOString() }],
        });
      }
      if (sql.includes("SELECT id, title, status")) {
        return Promise.resolve({
          rows: [{ id: 1, title: "test", status: "uploaded", created_at: new Date().toISOString() }],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as any;

  registerBookPdfRoutes(app, db, noopAuth, noopRole, noopTenant);
  return { app, db };
}

// ── テスト ──────────────────────────────────────────────────────────────────

describe("ZIP PDFアップロード (Phase59)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. 正常系 ────────────────────────────────────────────────────────────

  it("1. 3つのPDFが入ったZIPをアップロード → 3件のbook_uploadsが作成される", async () => {
    const zipBuf = makeZip([
      { name: "book-a.pdf", content: MINIMAL_PDF },
      { name: "book-b.pdf", content: MINIMAL_PDF },
      { name: "book-c.pdf", content: MINIMAL_PDF },
    ]);

    const { app, db } = makeApp({});
    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", zipBuf, { filename: "books.zip", contentType: "application/zip" });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(3);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.every((r: any) => r.status === "ok")).toBe(true);
    // DB insert が3回呼ばれた
    const insertCalls = (db.query as jest.Mock).mock.calls.filter((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("INSERT INTO book_uploads")
    );
    expect(insertCalls).toHaveLength(3);
  });

  // ── 2. 空のZIP ────────────────────────────────────────────────────────────

  it("2. 空のZIP → 400エラー「ZIPファイル内にPDFが見つかりません」", async () => {
    const zipBuf = makeZip([]);
    const { app } = makeApp({});

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", zipBuf, { filename: "empty.zip", contentType: "application/zip" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("PDFが見つかりません");
  });

  // ── 3. PDFでないファイルのみのZIP ────────────────────────────────────────

  it("3. PDFでないファイルのみのZIP → 400エラー", async () => {
    const zipBuf = makeZip([
      { name: "readme.txt", content: Buffer.from("hello") },
      { name: "data.csv", content: Buffer.from("a,b,c") },
    ]);
    const { app } = makeApp({});

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", zipBuf, { filename: "docs.zip", contentType: "application/zip" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("PDFが見つかりません");
  });

  // ── 4. __MACOSX を含むZIP ────────────────────────────────────────────────

  it("4. __MACOSXディレクトリが含まれるZIP → 除外されてPDFのみ処理", async () => {
    const zip = new AdmZip();
    zip.addFile("book.pdf", MINIMAL_PDF);
    zip.addFile("__MACOSX/._book.pdf", Buffer.from("mac metadata"));
    zip.addFile("__MACOSX/", Buffer.alloc(0)); // ディレクトリ
    const zipBuf = zip.toBuffer();

    const { app, db } = makeApp({});
    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", zipBuf, { filename: "mac-archive.zip", contentType: "application/zip" });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
    expect(res.body.results[0].fileName).toBe("book.pdf");
    const insertCalls = (db.query as jest.Mock).mock.calls.filter((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("INSERT INTO book_uploads")
    );
    expect(insertCalls).toHaveLength(1);
  });

  // ── 5. 50MB超のZIP → multerが413を返す ───────────────────────────────────

  it("5. 50MB超のZIPファイル → 413エラー", async () => {
    // multerのfileSize制限が50MBなので、それを超えるとMULTER LIMIT_FILE_SIZEエラー
    // 実際に50MBのバッファを作るとテストが遅いので、multerが正しく設定されているか型で検証
    // ここでは200MBの内容をもつZIPを直接テストする代わりに、
    // multerの設定値（50MB）が存在していることをコードレビューで確認済みとし、
    // 501バイト以上のバッファで圧縮率が高いZIPを使うテストは省略し、
    // 代わりに501MB相当の大きなZIPを小さくした圧縮バッファで送信する。
    // ※実際のサイズ制限は multer の limits.fileSize = 50 * 1024 * 1024 で設定済み

    // multerがLIMIT_FILE_SIZEを返すことを確認するため、超大型バッファを送信
    // テスト実行時間を考慮して51MBのBufferを直接supertest経由で送信
    const FIFTY_ONE_MB = 51 * 1024 * 1024;
    const bigBuf = Buffer.alloc(FIFTY_ONE_MB, 0x50); // 'P' * 51MB

    const { app } = makeApp({});
    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", bigBuf, { filename: "huge.zip", contentType: "application/zip" });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain("50MB");
  }, 15000);

  // ── 6. 20件超のPDFが入ったZIP ────────────────────────────────────────────

  it("6. 21件のPDFが入ったZIP → 400エラー「PDFの数が多すぎます」", async () => {
    const zip = new AdmZip();
    for (let i = 0; i < 21; i++) {
      zip.addFile(`book-${i + 1}.pdf`, MINIMAL_PDF);
    }
    const zipBuf = zip.toBuffer();

    const { app } = makeApp({});
    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", zipBuf, { filename: "many.zip", contentType: "application/zip" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("20件");
    expect(res.body.error).toContain("多すぎます");
  });

  // ── 7. パストラバーサル ───────────────────────────────────────────────────

  it("7. パストラバーサル（../を含むエントリ） → 400エラー", async () => {
    // AdmZip.addFile() sanitizes '../' on write, so use raw ZIP builder to preserve the path
    const zipBuf = makeRawZip([{ name: "../evil.pdf", content: MINIMAL_PDF }]);

    const { app } = makeApp({});
    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .attach("file", zipBuf, { filename: "traversal.zip", contentType: "application/zip" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("不正なファイルパス");
  });

  // ── 8. 通常PDFアップロードの回帰テスト ───────────────────────────────────

  it("8. 通常のPDFアップロード → 既存動作が壊れていない（回帰テスト）", async () => {
    const { app, db } = makeApp({});

    const res = await request(app)
      .post("/v1/admin/knowledge/book-pdf")
      .field("title", "テスト書籍")
      .attach("file", MINIMAL_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe("uploaded");

    const insertCalls = (db.query as jest.Mock).mock.calls.filter((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("INSERT INTO book_uploads")
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1][1]).toBe("テスト書籍"); // title パラメータ
  });
});
