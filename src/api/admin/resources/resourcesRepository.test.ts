// src/api/admin/resources/resourcesRepository.test.ts
//
// SQL の WHERE 句にしか表現できないテナント分離を固定する
// (wpProvisionRepository.test.ts と同じ流儀: 発行された SQL 文字列とバインド変数を検証する)。

const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockSupabaseAdmin: { current: unknown } = { current: null };
jest.mock("../../../auth/supabaseClient", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.current;
  },
}));

import {
  getResource,
  upsertResource,
  deleteResource,
  setPublished,
  uploadResourcePdfToStorage,
  getResourcePublicUrl,
} from "./resourcesRepository";

function makeDb(response: { rows?: any[]; rowCount?: number } = {}) {
  const query = jest.fn().mockResolvedValue({
    rows: response.rows ?? [],
    rowCount: response.rowCount ?? (response.rows?.length ?? 0),
  });
  return { db: { query } as any, query };
}

/** 発行された SQL を空白正規化して1行にする(改行・インデントの差を無視するため)。 */
function sqlOf(query: jest.Mock, callIndex = 0): string {
  return String(query.mock.calls[callIndex][0]).replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  mockSupabaseAdmin.current = null;
  mockUpload.mockReset();
  mockGetPublicUrl.mockReset();
});

describe("getResource", () => {
  it("tenant_id で絞り込む（他テナントの行を返さない）", async () => {
    const { db, query } = makeDb({ rows: [] });
    await getResource(db, "tenant-a");

    expect(sqlOf(query)).toContain("WHERE tenant_id = $1");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a"]);
  });

  it("行が無ければ null を返す（不存在は null、存在するが空は別の型で扱う契約）", async () => {
    const { db } = makeDb({ rows: [] });
    const result = await getResource(db, "tenant-a");
    expect(result).toBeNull();
  });

  it("自テナントの行のみ返す", async () => {
    const row = { id: "r1", tenant_id: "tenant-a", title: "資料A" };
    const { db } = makeDb({ rows: [row] });
    const result = await getResource(db, "tenant-a");
    expect(result).toEqual(row);
  });
});

describe("upsertResource", () => {
  it("tenant_id の UNIQUE 制約で ON CONFLICT DO UPDATE する（1テナント1件固定）", async () => {
    const { db, query } = makeDb({ rows: [{ id: "r1", tenant_id: "tenant-a" }] });
    await upsertResource(db, {
      id: "r1",
      tenantId: "tenant-a",
      title: "資料A",
      description: null,
      storagePath: "tenant-a/r1.pdf",
      externalUrl: null,
      fileType: "pdf",
      moderationStatus: "approved",
      moderationReason: null,
      rightsConfirmed: true,
    });

    const sql = sqlOf(query);
    expect(sql).toContain("INSERT INTO tenant_resources");
    expect(sql).toContain("ON CONFLICT (tenant_id) DO UPDATE SET");
    // 再アップロードのたびに is_published は false に戻る（確認前の内容を公開しない）
    expect(sql).toContain("is_published = false");
  });

  it("他テナントのidを渡しても、そのテナントの行としてしか保存されない（IDORにならない）", async () => {
    const { db, query } = makeDb({ rows: [{ id: "r1", tenant_id: "tenant-b" }] });
    await upsertResource(db, {
      id: "r1",
      tenantId: "tenant-b",
      title: "資料B",
      fileType: "external_url",
      externalUrl: "https://example.com/whitepaper",
      moderationStatus: "pending",
      rightsConfirmed: true,
    });

    expect(query.mock.calls[0][1]).toEqual([
      "r1",
      "tenant-b",
      "資料B",
      null,
      null,
      "https://example.com/whitepaper",
      "external_url",
      "pending",
      null,
      true,
    ]);
  });
});

describe("deleteResource", () => {
  it("tenant_id で絞り込んで削除する", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    const result = await deleteResource(db, "tenant-a");

    expect(sqlOf(query)).toContain("DELETE FROM tenant_resources WHERE tenant_id = $1");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a"]);
    expect(result).toBe(true);
  });

  it("元々存在しなければ false を返す", async () => {
    const { db } = makeDb({ rowCount: 0 });
    const result = await deleteResource(db, "tenant-a");
    expect(result).toBe(false);
  });
});

describe("setPublished", () => {
  it("tenant_id で絞り込んで is_published を更新する", async () => {
    const { db, query } = makeDb({ rows: [{ id: "r1", tenant_id: "tenant-a", is_published: true }] });
    await setPublished(db, "tenant-a", true);

    expect(sqlOf(query)).toContain("UPDATE tenant_resources SET is_published = $2 WHERE tenant_id = $1");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a", true]);
  });

  // TOCTOU対策(routes.test.tsの「setPublishedがnullを返した場合」テストと対): 公開(true)への
  // 更新は、この1文のSQL自体がmoderation_status != 'rejected'をWHERE条件に含むことで
  // アトミックに保証される。routes.ts側の事前getResourceチェックだけに頼ると、チェックと
  // この更新の間に別リクエストがrejectedへ変えた場合に却下済み資料が公開されてしまう。
  it("公開(true)へのUPDATEのSQLはmoderation_status != 'rejected'をWHERE条件に含む(TOCTOU対策)", async () => {
    const { db, query } = makeDb({ rows: [{ id: "r1", tenant_id: "tenant-a", is_published: true }] });
    await setPublished(db, "tenant-a", true);

    const sql = sqlOf(query);
    expect(sql).toContain("moderation_status != 'rejected'");
  });

  it("公開(true)への更新時、moderation_statusが既にrejectedならDB側で0行にマッチしnullを返す", async () => {
    // 実際のPostgresでは WHERE 条件不一致で0行返る。ここではその応答を模擬する。
    const { db } = makeDb({ rows: [], rowCount: 0 });
    const result = await setPublished(db, "tenant-a", true);

    expect(result).toBeNull();
  });

  it("非公開化(false)はmoderation_statusに関わらず常に許可する(WHERE条件が$2=falseで無条件通過)", async () => {
    const { db, query } = makeDb({ rows: [{ id: "r1", tenant_id: "tenant-a", is_published: false }] });
    const result = await setPublished(db, "tenant-a", false);

    expect(result).not.toBeNull();
    expect(query.mock.calls[0][1]).toEqual(["tenant-a", false]);
  });
});

describe("uploadResourcePdfToStorage", () => {
  it("supabaseAdmin 未初期化なら null を返す（アップロード自体は失敗させない呼び出し元の設計を壊さない）", async () => {
    mockSupabaseAdmin.current = null;
    const result = await uploadResourcePdfToStorage(Buffer.from("pdf"), "tenant-a", "r1");
    expect(result).toBeNull();
  });

  it("tenant-resources バケットの {tenantId}/{resourceId}.pdf に保存する", async () => {
    mockUpload.mockResolvedValue({ error: null });
    mockSupabaseAdmin.current = {
      storage: { from: () => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }) },
    };

    const result = await uploadResourcePdfToStorage(Buffer.from("pdf"), "tenant-a", "r1");

    expect(mockUpload).toHaveBeenCalledWith(
      "tenant-a/r1.pdf",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/pdf" })
    );
    expect(result).toBe("tenant-a/r1.pdf");
  });

  it("アップロード失敗時は null を返す", async () => {
    mockUpload.mockResolvedValue({ error: { message: "boom" } });
    mockSupabaseAdmin.current = {
      storage: { from: () => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }) },
    };

    const result = await uploadResourcePdfToStorage(Buffer.from("pdf"), "tenant-a", "r1");
    expect(result).toBeNull();
  });
});

describe("getResourcePublicUrl", () => {
  it("supabaseAdmin 未初期化なら null を返す", () => {
    mockSupabaseAdmin.current = null;
    expect(getResourcePublicUrl("tenant-a/r1.pdf")).toBeNull();
  });

  it("公開URLを返す", () => {
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: "https://cdn.example.com/tenant-a/r1.pdf" } });
    mockSupabaseAdmin.current = {
      storage: { from: () => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }) },
    };

    expect(getResourcePublicUrl("tenant-a/r1.pdf")).toBe("https://cdn.example.com/tenant-a/r1.pdf");
  });
});
