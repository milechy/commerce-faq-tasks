import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "../../../../src/api/admin/tenants/routes";
import { generateApiKey, hashApiKey, maskApiKey, maskApiKeyPrefix } from "../../../../src/api/admin/tenants/apiKeyUtils";

// tenant-context をモック
jest.mock("../../../../src/lib/tenant-context", () => ({
  registerTenant: jest.fn(),
}));

// supabaseClient をモック（招待API用 — テストでは不要）
jest.mock("../../../../src/auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

/**
 * 開発モード用フェイクJWT（署名検証なし）
 * tenantAuth は NODE_ENV=development のとき jwt.decode() のみ実行するため、
 * 署名は任意の文字列で問題ない。
 */
function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({
  sub: "admin-user-id",
  app_metadata: { role: "super_admin" },
});

const CLIENT_ADMIN_TOKEN = makeDevJwt({
  sub: "client-admin-user-id",
  app_metadata: { role: "client_admin", tenant_id: "tenant1" },
});

// role が未設定/不正だが tenant_id claim だけは持つトークン
// (GID 1216273277286371: role検証漏れの再発防止用)
const NO_ROLE_WITH_TENANT_TOKEN = makeDevJwt({
  sub: "no-role-user-id",
  app_metadata: { tenant_id: "tenant1" },
});

describe("Tenant Admin Routes", () => {
  let app: express.Application;
  let mockDb: any;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockDb = {
      query: jest.fn(),
    };

    registerTenantAdminRoutes(app, mockDb);
  });

  describe("GET /v1/admin/tenants", () => {
    it("returns tenant list", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", plan: "starter", is_active: true, created_at: new Date(), updated_at: new Date() }],
      });
      const res = await request(app)
        .get("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.tenants).toHaveLength(1);
    });
  });

  describe("POST /v1/admin/tenants", () => {
    it("creates a tenant", async () => {
      const newTenant = { id: "test-tenant", name: "テストテナント", plan: "starter", is_active: true, created_at: new Date(), updated_at: new Date() };
      mockDb.query.mockResolvedValueOnce({ rows: [newTenant], rowCount: 1 });
      const res = await request(app)
        .post("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ id: "test-tenant", name: "テストテナント", plan: "starter" });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("test-tenant");
    });

    it("rejects invalid tenant id", async () => {
      const res = await request(app)
        .post("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ id: "Invalid ID!", name: "Test" });
      expect(res.status).toBe(400);
    });

    it("returns 409 on duplicate id", async () => {
      mockDb.query.mockRejectedValueOnce({ code: "23505" });
      const res = await request(app)
        .post("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ id: "dup-tenant", name: "重複テナント" });
      expect(res.status).toBe(409);
    });
  });

  describe("POST /v1/admin/tenants/:id/keys", () => {
    it("issues an API key starting with rjc_", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "key-uuid", tenant_id: "t1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null }],
          rowCount: 1,
        });
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(201);
      expect(res.body.api_key).toMatch(/^rjc_/);
      expect(res.body.tenant_id).toBe("t1");
    });
  });

  describe("GET /v1/admin/tenants/:id/keys", () => {
    it("returns masked keys", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "k1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null, last_used_at: null }],
        });
      const res = await request(app)
        .get("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.keys[0].prefix).toMatch(/\*\*\*\*$/);
    });
  });

  describe("GET /v1/admin/my-tenant", () => {
    it("returns tenant info for client_admin", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [] }],
        rowCount: 1,
      });
      const res = await request(app)
        .get("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("tenant1");
    });

    it("rejects a request with tenant_id claim but no admin role (GID 1216273277286371)", async () => {
      const res = await request(app)
        .get("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${NO_ROLE_WITH_TENANT_TOKEN}`);
      expect(res.status).toBe(403);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it("returns faq_question_hint/faq_answer_hint (GID 1216274385106667)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [], faq_question_hint: "例: 保証期間は？", faq_answer_hint: "例: 3年間です" }],
        rowCount: 1,
      });
      const res = await request(app)
        .get("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.faq_question_hint).toBe("例: 保証期間は？");
      expect(res.body.faq_answer_hint).toBe("例: 3年間です");
    });

    it("returns onboarding_industry/onboarding_completed_at (GID 1216274591838389)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [], onboarding_industry: null, onboarding_completed_at: null }],
        rowCount: 1,
      });
      const res = await request(app)
        .get("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.onboarding_industry).toBeNull();
      expect(res.body.onboarding_completed_at).toBeNull();
    });

    // Asana 1217040568432160: オンボーディング4段階(docs/ONBOARDING_FIRST_LOGIN.md §3.1③)
    describe("onboarding_stage", () => {
      it("全段階未到達の新規テナントでは全て false を返す", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: null, onboarding_completed_at: null, onboarding_widget_seen_at: null,
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // faq_docs (knowledge_published)
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions (first_conversation)

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.onboarding_stage).toEqual({
          industryAnswered: false,
          knowledgePublished: false,
          widgetInstalled: false,
          firstConversation: false,
        });
      });

      it("業種回答済み・公開FAQあり・設置検知済み・実会話ありなら全て true を返す", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: "2026-07-01T00:00:00.000Z",
              onboarding_widget_seen_at: "2026-07-02T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }) // faq_docs: 公開FAQあり
          .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }); // chat_sessions: 実会話あり

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.onboarding_stage).toEqual({
          industryAnswered: true,
          knowledgePublished: true,
          widgetInstalled: true,
          firstConversation: true,
        });
      });

      it("faq_docs クエリが失敗しても my-tenant 応答全体は壊れない(フェイルセーフ)", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: null, onboarding_widget_seen_at: null,
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockRejectedValueOnce(new Error("connection lost")) // faq_docs 失敗
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.onboarding_stage.knowledgePublished).toBe(false);
        expect(res.body.onboarding_stage.industryAnswered).toBe(true);
      });
    });
  });

  describe("PATCH /v1/admin/my-tenant", () => {
    it("updates features for client_admin (plan=growth: avatar有効化を許可)", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ plan: "growth" }] }) // GID: avatar/voice の plan ゲート確認クエリ
        .mockResolvedValueOnce({
          rows: [{ id: "tenant1", name: "Test", features: { avatar: true, voice: false, rag: true }, lemonslice_agent_id: null }],
          rowCount: 1,
        });
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ features: { avatar: true, voice: false, rag: true } });
      expect(res.status).toBe(200);
      expect(res.body.features.avatar).toBe(true);
    });

    it("rejects avatar有効化 for client_admin on plan=starter (GID: LP料金表 Growth〜)", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ features: { avatar: true, voice: false, rag: true } });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("plan_upgrade_required");
    });

    it("rejects a request with tenant_id claim but no admin role (GID 1216273277286371)", async () => {
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${NO_ROLE_WITH_TENANT_TOKEN}`)
        .send({ features: { avatar: true, voice: false, rag: true } });
      expect(res.status).toBe(403);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it("updates faq_question_hint/faq_answer_hint for client_admin (GID 1216274385106667)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, faq_question_hint: "例: 保証期間は？", faq_answer_hint: "例: 3年間です" }],
        rowCount: 1,
      });
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ faq_question_hint: "例: 保証期間は？", faq_answer_hint: "例: 3年間です" });
      expect(res.status).toBe(200);
      expect(res.body.faq_question_hint).toBe("例: 保証期間は？");
      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain("faq_question_hint");
      expect(sql).toContain("faq_answer_hint");
    });

    it("sets onboarding_industry and onboarding_completed_at (GID 1216274591838389)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, onboarding_industry: "auto", onboarding_completed_at: new Date() }],
        rowCount: 1,
      });
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ onboarding_industry: "auto" });
      expect(res.status).toBe(200);
      expect(res.body.onboarding_industry).toBe("auto");
      expect(res.body.onboarding_completed_at).toBeTruthy();
      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain("onboarding_industry");
      expect(sql).toContain("onboarding_completed_at = NOW()");
    });

    it("rejects an invalid onboarding_industry value", async () => {
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ onboarding_industry: "not-a-real-industry" });
      expect(res.status).toBe(400);
    });

    it("rejects an empty body with no_fields", async () => {
      const res = await request(app)
        .patch("/v1/admin/my-tenant")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("no_fields");
    });
  });

  // Asana 1217040568430944(P7): super_adminのクライアントビュー(previewMode)からも
  // オンボーディング状態を取得できるようにする(docs/ONBOARDING_FIRST_LOGIN.md 決定D)
  describe("GET /v1/admin/tenants/:id — onboarding_stage", () => {
    it("onboarding_stageを応答に含める", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: "t1", name: "Test", plan: "starter", is_active: true, features: {},
            onboarding_industry: "beauty", onboarding_widget_seen_at: null,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // faq_docs (knowledge_published)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions (first_conversation)

      const res = await request(app)
        .get("/v1/admin/tenants/t1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.onboarding_stage).toEqual({
        industryAnswered: true,
        knowledgePublished: false,
        widgetInstalled: false,
        firstConversation: false,
      });
    });

    it("client_adminからのアクセスは従来どおり403(super_admin専用)", async () => {
      const res = await request(app)
        .get("/v1/admin/tenants/t1")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /v1/admin/tenants/:id", () => {
    it("updates faq_question_hint/faq_answer_hint for super_admin (GID 1216274385106667)", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1", plan: "starter", features: {}, billing_enabled: false, is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true, faq_question_hint: "例: 保証期間は？", faq_answer_hint: "例: 3年間です" }],
          rowCount: 1,
        })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      const res = await request(app)
        .patch("/v1/admin/tenants/t1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ faq_question_hint: "例: 保証期間は？", faq_answer_hint: "例: 3年間です" });
      expect(res.status).toBe(200);
      expect(res.body.faq_question_hint).toBe("例: 保証期間は？");
      expect(res.body.faq_answer_hint).toBe("例: 3年間です");
    });
  });

  describe("DELETE /v1/admin/tenants/:id/keys/:keyId", () => {
    it("deactivates a key", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: "k1", tenant_id: "t1", is_active: false }], rowCount: 1 });
      const res = await request(app)
        .delete("/v1/admin/tenants/t1/keys/k1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("returns 404 for non-existent key", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const res = await request(app)
        .delete("/v1/admin/tenants/t1/keys/no-key")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
    });
  });
});

describe("apiKeyUtils", () => {
  it("generateApiKey starts with rjc_", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^rjc_[a-f0-9]{64}$/);
  });

  it("hashApiKey returns 64 char hex", () => {
    const hash = hashApiKey("rjc_test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maskApiKey masks after 12 chars", () => {
    const masked = maskApiKey("rjc_abcd1234xyz");
    expect(masked).toBe("rjc_abcd1234****");
  });

  it("maskApiKeyPrefix appends ****", () => {
    const masked = maskApiKeyPrefix("rjc_abcd1234");
    expect(masked).toBe("rjc_abcd1234****");
  });
});
