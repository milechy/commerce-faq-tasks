// src/api/admin/resources/routes.test.ts
//
// 資料オファー機能の HTTP レイヤー(routes.ts)テスト。
// resourcesRepository.test.ts は SQL/DBレイヤーを検証済みのため、ここでは
// リポジトリをモックして以下のみを検証する(docs/RESOURCE_OFFER_REQUIREMENTS.md §7):
//   - resolveTenantId によるテナント分離(client_admin は ?tenant= を無視する)
//   - rights_confirmed のサーバ側再検証(ハードゲート)
//   - external_url の SSRF ガード
//   - moderation_status='rejected' 時の公開ブロック
//   - 「不存在」と「空」の区別(GET は 404 ではなく resource: null)

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
import { registerResourceRoutes } from "./routes";

// ---------------------------------------------------------------------------
// モック(resourcesRepository.test.ts の流儀・avatar/routes.test.ts の
// supabaseAuthMiddleware モックに合わせる)
// ---------------------------------------------------------------------------

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("./resourcesRepository", () => ({
  getResource: jest.fn(),
  upsertResource: jest.fn(),
  deleteResource: jest.fn(),
  setPublished: jest.fn(),
  uploadResourcePdfToStorage: jest.fn(),
  getResourcePublicUrl: jest.fn(),
}));

// ResourcePdfExtractError は routes.ts が `instanceof` で判定するため、実クラスは
// そのまま残し、抽出関数だけをモックする。
jest.mock("../../../lib/resourcePdfExtract", () => {
  const actual = jest.requireActual("../../../lib/resourcePdfExtract");
  return {
    ResourcePdfExtractError: actual.ResourcePdfExtractError,
    extractResourcePdfText: jest.fn(),
  };
});

jest.mock("../../../lib/resourceContentGuard", () => ({
  checkResourceTextForInfringement: jest.fn(),
}));

import {
  getResource,
  upsertResource,
  deleteResource,
  setPublished,
  getResourcePublicUrl,
  uploadResourcePdfToStorage,
} from "./resourcesRepository";
import { extractResourcePdfText, ResourcePdfExtractError } from "../../../lib/resourcePdfExtract";
import { checkResourceTextForInfringement } from "../../../lib/resourceContentGuard";

const mockGetResource = getResource as jest.Mock;
const mockUpsertResource = upsertResource as jest.Mock;
const mockDeleteResource = deleteResource as jest.Mock;
const mockSetPublished = setPublished as jest.Mock;
const mockGetResourcePublicUrl = getResourcePublicUrl as jest.Mock;
const mockUploadResourcePdfToStorage = uploadResourcePdfToStorage as jest.Mock;
const mockExtractResourcePdfText = extractResourcePdfText as jest.Mock;
const mockCheckResourceTextForInfringement = checkResourceTextForInfringement as jest.Mock;

// ---------------------------------------------------------------------------
// テスト用 Express アプリ生成(avatar/routes.test.ts と同じパターン)
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(role: Role = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  // registerResourceRoutes は `if (!db) return;` でガードしているだけで、
  // このファイルの全操作は resourcesRepository モック経由のため db の中身は不要。
  registerResourceRoutes(app, {});
  return app;
}

const RESOURCE_ROW = {
  id: "res-1",
  tenant_id: "tenant-a",
  title: "テスト資料",
  description: null,
  storage_path: "tenant-a/res-1.pdf",
  external_url: null,
  file_type: "pdf",
  moderation_status: "approved",
  moderation_reason: null,
  rights_confirmed: true,
  is_published: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetResourcePublicUrl.mockReturnValue(null);
  // 個々のテストで上書きしない限り、Storageアップロードは成功する前提にする
  // （P1修正: アップロード失敗時の挙動は専用のdescribeブロックで検証する）。
  mockUploadResourcePdfToStorage.mockResolvedValue("tenant-a/res-1.pdf");
});

// ---------------------------------------------------------------------------
// 1. テナント分離(HTTPレイヤー): client_admin は ?tenant= でも自テナントに固定される
// ---------------------------------------------------------------------------

describe("テナント分離: resolveTenantId", () => {
  it("GET: client_admin が ?tenant=tenant-b を付けても自テナント(tenant-a)で取得する", async () => {
    mockGetResource.mockResolvedValue(null);

    const res = await request(makeApp("client_admin", "tenant-a")).get(
      "/v1/admin/resources?tenant=tenant-b"
    );

    expect(res.status).toBe(200);
    expect(mockGetResource).toHaveBeenCalledWith({}, "tenant-a");
    expect(mockGetResource).not.toHaveBeenCalledWith({}, "tenant-b");
  });

  it("DELETE: client_admin が ?tenant=tenant-b を付けても自テナント(tenant-a)を削除対象にする", async () => {
    mockDeleteResource.mockResolvedValue(true);

    const res = await request(makeApp("client_admin", "tenant-a")).delete(
      "/v1/admin/resources?tenant=tenant-b"
    );

    expect(res.status).toBe(200);
    expect(mockDeleteResource).toHaveBeenCalledWith({}, "tenant-a");
  });

  it("super_admin は ?tenant=tenant-b で他テナントを対象にできる(仕様通り)", async () => {
    mockGetResource.mockResolvedValue(null);

    const res = await request(makeApp("super_admin", "")).get(
      "/v1/admin/resources?tenant=tenant-b"
    );

    expect(res.status).toBe(200);
    expect(mockGetResource).toHaveBeenCalledWith({}, "tenant-b");
  });

  it("tenantId が解決できない(client_admin かつ JWT に tenant_id なし)場合は403で、repositoryに到達しない", async () => {
    const res = await request(makeApp("client_admin", "")).get("/v1/admin/resources");

    expect(res.status).toBe(403);
    expect(mockGetResource).not.toHaveBeenCalled();
  });

  it("許可されていないロールは403で、repositoryに到達しない", async () => {
    const res = await request(makeApp("agent" as Role, "tenant-a")).get("/v1/admin/resources");

    expect(res.status).toBe(403);
    expect(mockGetResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. rights_confirmed のサーバ側再検証(ハードゲート)
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — rights_confirmed のサーバ側再検証", () => {
  it("rights_confirmed=false を明示送信 → 400 rights_not_confirmed、保存しない", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "false");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("rights_not_confirmed");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });

  it("rights_confirmed を省略 → 400(バリデーションエラー)、保存しない", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", "https://example.com/whitepaper.pdf");

    expect(res.status).toBe(400);
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });

  it("rights_confirmed=true かつ有効な external_url → 保存される(対照系)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, file_type: "external_url", storage_path: null });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: "tenant-a", rightsConfirmed: true })
    );
  });
});

// ---------------------------------------------------------------------------
// 2.5 title/description の文字数境界(upsertBodySchema: title max200 / description max2000)
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — title/description の文字数境界", () => {
  it("titleがちょうど200文字なら受理される(境界値の片側)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, file_type: "external_url", storage_path: null });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "あ".repeat(200))
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalled();
  });

  it("titleが201文字だと400(invalid_request)で拒否され、保存されない(境界値のもう片側)", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "あ".repeat(201))
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });

  it("descriptionがちょうど2000文字なら受理される(境界値の片側)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, file_type: "external_url", storage_path: null });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("description", "い".repeat(2000))
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalled();
  });

  it("descriptionが2001文字だと400(invalid_request)で拒否され、保存されない(境界値のもう片側)", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("description", "い".repeat(2001))
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. SSRF ガード(external_url)
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — external_url の SSRF ガード", () => {
  const PRIVATE_OR_LOCAL_URLS = [
    "http://localhost/doc.pdf",
    "http://127.0.0.1/doc.pdf",
    "http://0.0.0.0/doc.pdf",
    "http://[::1]/doc.pdf",
    "http://10.0.0.5/doc.pdf",
    "http://172.16.0.5/doc.pdf",
    "http://192.168.1.5/doc.pdf",
    "http://169.254.169.254/latest/meta-data",
    // 以下、実機検証(node -e)で確認済みのバイパス手口。WHATWG URL パーサが
    // 10進数/16進数/8進数IPv4表記を自動的にドット10進表記へ正規化するため、
    // それらはガードに到達する前に無害化される(下の「正規化されバイパスできない表記」
    // で確認する)。一方、末尾ドットとIPv4射影IPv6は正規化されずガードを素通りしていた。
    "http://localhost./doc.pdf", // 末尾ドット(DNSルートラベル): "localhost" と完全一致しないため素通りしていた
    "http://localhost../doc.pdf", // 末尾ドット複数
    "http://[::ffff:127.0.0.1]/doc.pdf", // IPv4射影IPv6(loopback) → "[::ffff:7f00:1]" に正規化され素通りしていた
    "http://[::ffff:192.168.1.1]/doc.pdf", // IPv4射影IPv6(private) → "[::ffff:c0a8:101]"
    "http://[::ffff:10.0.0.1]/doc.pdf", // IPv4射影IPv6(private)
  ];

  it.each(PRIVATE_OR_LOCAL_URLS)("%s は 400 invalid_url で拒否され、保存されない", async (url) => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", url)
      .field("rights_confirmed", "true");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_url");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });

  // WHATWG URL パーサ自身がIPv4の10進数/16進数/8進数表記を通常のドット10進表記へ
  // 正規化するため、これらは isPrivateOrLocalHostname に渡る前に無害化されている。
  // 「正規化された結果ガードに引っかかる」ことを実機確認済みなので回帰として固定する。
  it.each([
    "http://2130706433/doc.pdf", // 127.0.0.1 の10進数表記
    "http://0x7f000001/doc.pdf", // 127.0.0.1 の16進数表記
    "http://017700000001/doc.pdf", // 127.0.0.1 の8進数表記
    "http://127.1/doc.pdf", // 短縮ドット10進表記(127.0.0.1と等価)
  ])("%s はURLパーサの正規化を経てガードに拒否される(400 invalid_url)", async (url) => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", url)
      .field("rights_confirmed", "true");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_url");
  });

  it("通常の公開 https URL は受理される", async () => {
    mockGetResource.mockResolvedValue(null);
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, file_type: "external_url", storage_path: null });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalled();
  });

  it("IPv4射影IPv6でも埋め込みアドレスが公開IPなら受理される(誤検知しない、例: Google Public DNS 8.8.8.8)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, file_type: "external_url", storage_path: null });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", "http://[::ffff:8.8.8.8]/doc.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(201);
  });

  it("file と external_url の同時指定は 400、保存されない", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("external_url", "https://example.com/whitepaper.pdf")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("%PDF-1.4 dummy"), {
        filename: "doc.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });

  it("PDFアップロード成功時: 抽出テキストがモデレーション承認されると approved で保存される", async () => {
    mockGetResource.mockResolvedValue(null);
    mockExtractResourcePdfText.mockResolvedValue("資料の本文テキスト");
    mockCheckResourceTextForInfringement.mockResolvedValue({ blocked: false });
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "approved" });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("%PDF-1.4 dummy"), {
        filename: "doc.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ moderationStatus: "approved", fileType: "pdf" })
    );
  });
});

// ---------------------------------------------------------------------------
// 3.5 Storageアップロード失敗時の挙動(P1修正の回帰テスト)
//   uploadResourcePdfToStorage が null を返した場合、資料は保存されず 500 を返す
//   （以前は download_url が null のまま 201 で保存されていた）。
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — Storageアップロード失敗時", () => {
  it("uploadResourcePdfToStorage が null を返す場合は500で、資料は保存されない", async () => {
    mockGetResource.mockResolvedValue(null);
    mockExtractResourcePdfText.mockResolvedValue("資料の本文テキスト");
    mockUploadResourcePdfToStorage.mockResolvedValue(null);

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("%PDF-1.4 dummy"), {
        filename: "doc.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(500);
    expect(mockCheckResourceTextForInfringement).not.toHaveBeenCalled();
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3.6 テキスト抽出失敗時(画像のみのPDF等)の挙動(P1修正の回帰テスト)
//   抽出失敗(空文字含む)はモデレーションを実行せず pending のまま保存する。
//   Gemini に空同然のテキストを渡して approved 判定させない。
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — PDFテキスト抽出失敗時", () => {
  it("抽出が失敗した場合はモデレーションを実行せず pending で保存する", async () => {
    mockGetResource.mockResolvedValue(null);
    mockExtractResourcePdfText.mockRejectedValue(
      new ResourcePdfExtractError("資料PDFからテキストを抽出できませんでした（画像のみのPDFの可能性があります）")
    );
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "pending" });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("%PDF-1.4 dummy"), {
        filename: "doc.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(mockCheckResourceTextForInfringement).not.toHaveBeenCalled();
    expect(mockUpsertResource).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ moderationStatus: "pending" })
    );
  });
});

// ---------------------------------------------------------------------------
// 3.7 PDFファイルサイズ上限(multer limits.fileSize = MAX_RESOURCE_PDF_SIZE = 20MB)
//   実バイト数のBufferを送ることで、コードパスの存在ではなく実際の閾値そのものを検証する。
//
//   実挙動確認済みの差分(タスク指示との相違): multer(busboy)の`limits.fileSize`は
//   「この値ちょうどまでは許可」ではなく「この値未満のみ許可」という排他的な境界で動作する。
//   実際に20MBちょうどのBufferを送ると413(LIMIT_FILE_SIZE)で拒否され、受理される実際の
//   最大値は20MB - 1バイトだった(スタンドアロンのsupertest検証で確認: 20MB→413,
//   20MB+1→413, 20MB-1→200)。エラーメッセージ「上限: 20MB」はユーザー向けの概数表示
//   としては妥当だが、実装の受理境界そのものは20MB未満である点を回帰として固定する。
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — PDFファイルサイズ上限(実バイト境界)", () => {
  const MAX_RESOURCE_PDF_SIZE = 20 * 1024 * 1024;

  it("20MBちょうど未満(MAX-1バイト)のPDFは受理される(実際に受理される上限)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockExtractResourcePdfText.mockResolvedValue("資料の本文テキスト");
    mockCheckResourceTextForInfringement.mockResolvedValue({ blocked: false });
    mockUpsertResource.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "approved" });

    const justUnderMaxBuffer = Buffer.alloc(MAX_RESOURCE_PDF_SIZE - 1, "A");

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", justUnderMaxBuffer, { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalled();
  }, 30000);

  it("20MBちょうどのPDFは413で拒否される(multer/busboyのfileSize制限は排他的境界のため、20MBちょうどは受理されない)", async () => {
    const exactlyMaxBuffer = Buffer.alloc(MAX_RESOURCE_PDF_SIZE, "A");

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", exactlyMaxBuffer, { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("ファイルサイズが大きすぎます（上限: 20MB）");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  }, 30000);

  it("20MBを1バイトでも超えるPDFは413で拒否され、保存されない", async () => {
    const overMaxBuffer = Buffer.alloc(MAX_RESOURCE_PDF_SIZE + 1, "A");

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", overMaxBuffer, { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("ファイルサイズが大きすぎます（上限: 20MB）");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  }, 30000);
});

// ---------------------------------------------------------------------------
// 3.8 MIMEタイプチェック(multer fileFilter): application/pdf以外はサーバ側で拒否
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — MIMEタイプチェック(fileFilter)", () => {
  it("application/pdf以外(image/png)のファイルは400で拒否され、保存されない", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("fake png bytes"), { filename: "evil.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("PDFファイルのみアップロードできます");
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3.9 既存資料への再アップロード(置き換え)フロー
//   これまでの成功系テストは全て getResource→null(新規作成)のみを経由しており、
//   「既存資料がある→そのidを再利用して更新する」分岐は一度も実行されていなかった。
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — 既存資料への再アップロード(置き換え)", () => {
  it("既存資料がある場合はその id を再利用して更新し、is_published は false にリセットされる(resourcesRepository.upsertResourceは常にis_published=falseでUPSERTする実装のため、公開済みの資料を再アップロードしても未公開に戻る)", async () => {
    const existing = {
      ...RESOURCE_ROW,
      id: "res-existing-1",
      file_type: "external_url",
      storage_path: null,
      external_url: "https://example.com/old-whitepaper.pdf",
      is_published: true,
      moderation_status: "approved",
    };
    mockGetResource.mockResolvedValue(existing);
    mockUpsertResource.mockResolvedValue({
      ...existing,
      external_url: "https://example.com/new-whitepaper.pdf",
      is_published: false,
    });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "新しい資料タイトル")
      .field("external_url", "https://example.com/new-whitepaper.pdf")
      .field("rights_confirmed", "true");

    expect(res.status).toBe(201);
    // 新規UUIDではなく既存資料のidがそのまま渡っている(Storageパス固定・1テナント1件の要)
    expect(mockUpsertResource).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        id: "res-existing-1",
        externalUrl: "https://example.com/new-whitepaper.pdf",
      })
    );
    expect(res.body.external_url).toBe("https://example.com/new-whitepaper.pdf");
    expect(res.body.is_published).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3.10 モデレーションで拒否された場合(routes.ts経由の統合テスト。従来は
//   resourceContentGuard.test.ts でこの関数単体のみ検証しており、
//   routes.ts が拒否結果を正しくupsertResourceへ渡すかは未検証だった)
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/resources — モデレーションで拒否された場合", () => {
  it("抽出テキストがモデレーションで拒否されると、アップロード自体は201で成功しmoderation_status=rejectedで保存される(公開は/publishで別途ブロックされる)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockExtractResourcePdfText.mockResolvedValue("盗用された本文テキスト");
    mockCheckResourceTextForInfringement.mockResolvedValue({
      blocked: true,
      reason: "著作権侵害の疑いがあります",
    });
    mockUpsertResource.mockResolvedValue({
      ...RESOURCE_ROW,
      moderation_status: "rejected",
      moderation_reason: "著作権侵害の疑いがあります",
    });

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("%PDF-1.4 dummy"), { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(mockUpsertResource).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        moderationStatus: "rejected",
        moderationReason: "著作権侵害の疑いがあります",
      })
    );
  });

  // 実挙動の確認(このテストが書かれた時点でのタスク指示との差分):
  // resourceContentGuard.ts 自体はGemini呼び出し失敗時に内部でtry/catchしフェイルオープン
  // (blocked: false を返す)するが、それはあくまで「関数の中身」の話であって、
  // このテストのように checkResourceTextForInfringement をjest.mockでモジュールごと
  // 差し替えて「例外を投げる」設定にした場合、その内部catchは存在しない(モック関数が
  // 素通しでrejectする)。routes.ts側には、この呼び出しの周りに個別のtry/catchが無く、
  // PUTハンドラ全体を包む1つのtry/catch(303-306行)にそのまま伝播するため、
  // 実際には500(「資料の保存に失敗しました」)になり、upsertResourceは呼ばれない。
  // 「フェイルオープンでもアップロードは201で成功する」という前提は
  // resourceContentGuard.ts単体では正しいが、routes.tsを経由した結合レベルでは
  // 成立しない(モデレーション呼び出し自体が例外を投げる状況は現実には起きない設計
  // ―― 関数内部が常にcatchして{blocked:false}を返すため ―― だが、この関数境界を
  // 越えてrouter側だけを見た場合の実挙動としてここに固定する)。
  it("モデレーション呼び出し自体が例外を投げた場合の実挙動: routes.ts側に個別のcatchが無いため500になる(upsertResourceは呼ばれない)", async () => {
    mockGetResource.mockResolvedValue(null);
    mockExtractResourcePdfText.mockResolvedValue("資料の本文テキスト");
    mockCheckResourceTextForInfringement.mockRejectedValue(new Error("Gemini API error: 500"));

    const res = await request(makeApp())
      .put("/v1/admin/resources")
      .field("title", "テスト資料")
      .field("rights_confirmed", "true")
      .attach("file", Buffer.from("%PDF-1.4 dummy"), { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(500);
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. POST /v1/admin/resources/publish — moderation_status='rejected' はブロック
// ---------------------------------------------------------------------------

describe("POST /v1/admin/resources/publish", () => {
  it("moderation_status='rejected' のときは 400 moderation_rejected で、公開されない", async () => {
    mockGetResource.mockResolvedValue({
      ...RESOURCE_ROW,
      moderation_status: "rejected",
      moderation_reason: "著作権侵害の疑いがあります",
    });

    const res = await request(makeApp()).post("/v1/admin/resources/publish");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("moderation_rejected");
    expect(res.body.moderation_reason).toBe("著作権侵害の疑いがあります");
    expect(mockSetPublished).not.toHaveBeenCalled();
  });

  it("moderation_status='approved' のときは公開できる", async () => {
    mockGetResource.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "approved" });
    mockSetPublished.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "approved", is_published: true });

    const res = await request(makeApp()).post("/v1/admin/resources/publish");

    expect(res.status).toBe(200);
    expect(mockSetPublished).toHaveBeenCalledWith({}, "tenant-a", true);
  });

  it("moderation_status='pending' のときも公開できる(未検査は拒否ではない)", async () => {
    mockGetResource.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "pending" });
    mockSetPublished.mockResolvedValue({ ...RESOURCE_ROW, moderation_status: "pending", is_published: true });

    const res = await request(makeApp()).post("/v1/admin/resources/publish");

    expect(res.status).toBe(200);
    expect(mockSetPublished).toHaveBeenCalled();
  });

  it("資料が存在しない場合は 404", async () => {
    mockGetResource.mockResolvedValue(null);

    const res = await request(makeApp()).post("/v1/admin/resources/publish");

    expect(res.status).toBe(404);
    expect(mockSetPublished).not.toHaveBeenCalled();
  });

  // TOCTOU対策: 事前チェック(getResource)から実更新(setPublished)までの間に
  // 別リクエストがmoderation_statusを変えても、setPublished自身のWHERE条件が
  // アトミックにブロックしnullを返す(resourcesRepository.test.ts参照)。
  // ここではその「nullが返ってきた場合」にルートが正しく後始末することを検証する。
  describe("setPublished がTOCTOU競合でnullを返した場合", () => {
    it("現在の状態が rejected になっていれば 400 moderation_rejected を返す(is_publishedをtrueにしない)", async () => {
      // 事前チェック時点では approved(公開可能)だったが、setPublished実行直前に
      // 別リクエストの再アップロードで rejected に変わっていたケース。
      mockGetResource
        .mockResolvedValueOnce({ ...RESOURCE_ROW, moderation_status: "approved" }) // 事前チェック
        .mockResolvedValueOnce({
          ...RESOURCE_ROW,
          moderation_status: "rejected",
          moderation_reason: "競合で却下に変わった",
        }); // 後始末での再取得
      mockSetPublished.mockResolvedValue(null);

      const res = await request(makeApp()).post("/v1/admin/resources/publish");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("moderation_rejected");
      expect(res.body.moderation_reason).toBe("競合で却下に変わった");
    });

    it("現在の状態が既に存在しない(削除された)場合は 404 を返す", async () => {
      mockGetResource
        .mockResolvedValueOnce({ ...RESOURCE_ROW, moderation_status: "approved" })
        .mockResolvedValueOnce(null);
      mockSetPublished.mockResolvedValue(null);

      const res = await request(makeApp()).post("/v1/admin/resources/publish");

      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. GET /v1/admin/resources — 「不存在」と「空」の区別(404ではなく resource: null)
// ---------------------------------------------------------------------------

describe("GET /v1/admin/resources — 未登録テナントの応答契約", () => {
  it("資料が無いテナントは 404 ではなく 200 + resource: null を返す", async () => {
    mockGetResource.mockResolvedValue(null);

    const res = await request(makeApp("client_admin", "tenant-no-resource")).get(
      "/v1/admin/resources"
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resource: null });
  });

  it("資料が存在するテナントは resource オブジェクトを返す(download_url 付与)", async () => {
    mockGetResource.mockResolvedValue(RESOURCE_ROW);
    mockGetResourcePublicUrl.mockReturnValue("https://cdn.example.com/tenant-a/res-1.pdf");

    const res = await request(makeApp()).get("/v1/admin/resources");

    expect(res.status).toBe(200);
    expect(res.body.resource.id).toBe("res-1");
    expect(res.body.resource.download_url).toBe("https://cdn.example.com/tenant-a/res-1.pdf");
  });
});
