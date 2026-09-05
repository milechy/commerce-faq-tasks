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
