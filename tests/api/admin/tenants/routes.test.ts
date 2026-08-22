import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "../../../../src/api/admin/tenants/routes";
import { generateApiKey, hashApiKey, maskApiKey, maskApiKeyPrefix } from "../../../../src/api/admin/tenants/apiKeyUtils";
import {
  registerTenant as mockRegisterTenant,
  setTenantApiKeyExpiry as mockSetTenantApiKeyExpiry,
  revokeTenantApiKeyIfCurrent as mockRevokeTenantApiKeyIfCurrent,
} from "../../../../src/lib/tenant-context";

// tenant-context をモック
jest.mock("../../../../src/lib/tenant-context", () => ({
  registerTenant: jest.fn(),
  updateTenantEnabled: jest.fn(),
  setTenantApiKeyExpiry: jest.fn(),
  revokeTenantApiKeyIfCurrent: jest.fn(),
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

    it("client_admin は403で弾かれ、キーは一切発行されない（権限境界）", async () => {
      const callsBefore = (mockRegisterTenant as jest.Mock).mock.calls.length;
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(403);
      expect((mockRegisterTenant as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it("既存テナントの allowedOrigins / features を固定値で潰さず引き継ぐ（キー再発行でOrigin制限が消える事故の回帰防止）", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: "t1", name: "T1", plan: "growth", is_active: true,
            features: { avatar: true, voice: false, rag: true },
            allowed_origins: ["https://shop.example.com"],
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ id: "key-uuid", tenant_id: "t1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null }],
          rowCount: 1,
        });
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(201);
      const lastCall = (mockRegisterTenant as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastCall.security.allowedOrigins).toEqual(["https://shop.example.com"]);
      expect(lastCall.features).toEqual({ avatar: true, voice: false, rag: true });
    });

    it("DB側の features / allowed_origins が null（未設定）ならデフォルト値にフォールバックする", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true, features: null, allowed_origins: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ id: "key-uuid", tenant_id: "t1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null }],
          rowCount: 1,
        });
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(201);
      const lastCall = (mockRegisterTenant as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastCall.security.allowedOrigins).toEqual([]);
      expect(lastCall.features).toEqual({ avatar: false, voice: false, rag: true });
    });

    it("存在しないテナントIDへのキー発行は404で、in-memory登録は一切行わない", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const callsBefore = (mockRegisterTenant as jest.Mock).mock.calls.length;
      const res = await request(app)
        .post("/v1/admin/tenants/nonexistent/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect((mockRegisterTenant as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it("無効化済み(is_active=false)テナントへのキー発行は403で、in-memory登録は一切行わない", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: "t1", name: "T1", plan: "starter", is_active: false }], rowCount: 1 });
      const callsBefore = (mockRegisterTenant as jest.Mock).mock.calls.length;
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(403);
      expect((mockRegisterTenant as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it("不正な expires_at 文字列は400で拒否され、キーは発行されない", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true }], rowCount: 1 });
      const callsBefore = (mockRegisterTenant as jest.Mock).mock.calls.length;
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ expires_at: "not-a-real-date" });
      expect(res.status).toBe(400);
      expect((mockRegisterTenant as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it("expires_at が空文字列の場合は「無期限」として扱われる（truthy判定の落とし穴）", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "key-uuid", tenant_id: "t1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null }],
          rowCount: 1,
        });
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ expires_at: "" });
      expect(res.status).toBe(201);
      expect((mockSetTenantApiKeyExpiry as jest.Mock).mock.calls.at(-1)?.[1]).toBeNull();
    });

    it("イレギュラー: 過去日時の expires_at を指定しても発行自体は201で成功する（＝発行直後から使えない『死んだキー』が作られる、既知の挙動として固定）", async () => {
      const pastDate = new Date(Date.now() - 86_400_000).toISOString();
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "key-uuid", tenant_id: "t1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: pastDate }],
          rowCount: 1,
        });
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ expires_at: pastDate });
      expect(res.status).toBe(201);
      const passedExpiry = (mockSetTenantApiKeyExpiry as jest.Mock).mock.calls.at(-1)?.[1] as Date;
      expect(passedExpiry.getTime()).toBeLessThan(Date.now());
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
              created_at: "2026-08-01T00:00:00.000Z",
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
          hasDraftFaq: false,
        });
      });

      it("業種回答済み・公開FAQあり・設置検知済み・実会話ありなら全て true を返す", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: "2026-07-01T00:00:00.000Z",
              onboarding_widget_seen_at: "2026-07-02T00:00:00.000Z",
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [{ published_count: "1", draft_count: "0" }], rowCount: 1 }) // faq_docs: 公開FAQあり
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
          hasDraftFaq: false,
        });
      });

      // オンボ 是正A-2: 下書きが公開済みFAQと独立にカウントされること(1クエリ統合の回帰)。
      it("公開済みFAQが無くても下書きがあれば hasDraftFaq が true になる", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: null, onboarding_widget_seen_at: null,
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [{ published_count: "0", draft_count: "3" }], rowCount: 1 }) // faq_docs: 下書きのみ
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.onboarding_stage.hasDraftFaq).toBe(true);
        expect(res.body.onboarding_stage.knowledgePublished).toBe(false);
      });

      // X-16(docs/ONBOARDING_FIRST_LOGIN.md §7.3): テストチャット(/admin/chat-test)由来の
      // セッションを実会話としてカウントしてはならない。Asana 1216970103691946の
      // trafficSource分離に依存する制約を、SQL文レベルで固定する回帰テスト。
      // モックはSQLの中身を見ないため、既存の「rowCountが返ればtrueになる」テストだけでは
      // このフィルタが将来外れても検出できない。
      it("X-16: firstConversationの判定クエリは metadata->>'source' = 'user' で絞り込んでいる(テスト/デモトラフィックの除外)", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_widget_seen_at: "2026-07-02T00:00:00.000Z",
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // faq_docs
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

        await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        const chatSessionsCall = mockDb.query.mock.calls.find(([sql]: [string]) =>
          String(sql).includes("FROM chat_sessions"),
        );
        expect(chatSessionsCall).toBeDefined();
        expect(String(chatSessionsCall[0])).toContain(`metadata->>'source' = 'user'`);
      });

      // オンボ 是正D-2: X-16はchat_sessionsのテナント境界をSQL文字列レベルで固定して
      // いるのに、knowledgePublished判定のis_published条件は未検証で非対称だった
      // (この条件が外れて「下書きでも公開済み扱い」になっても既存テストは全て緑のまま)。
      it("オンボ 是正D-2: knowledgePublished判定クエリは is_published を条件に含む(SQL文字列検証)", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_widget_seen_at: null,
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [{ published_count: "0", draft_count: "0" }], rowCount: 1 }) // faq_docs
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

        await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        const faqDocsCall = mockDb.query.mock.calls.find(([sql]: [string]) =>
          String(sql).includes("FROM faq_docs"),
        );
        expect(faqDocsCall).toBeDefined();
        expect(String(faqDocsCall[0])).toContain("is_published");
        expect(String(faqDocsCall[0])).toContain("tenant_id = $1");
      });

      // X-14(docs/ONBOARDING_FIRST_LOGIN.md §7.3): super_adminの代行(previewMode)でも
      // client_admin本人でも、段階の導出は同じクエリ・同じ判定になる(actorによる分岐が無い)。
      // tenants テーブル自体に actor 列が無いため、代行で設定した状態はテナント本人からも
      // 同じ内容で見える。actor の記録はメトリクス層(P5)の話であり、状態の見え方には影響しない。
      it("X-14: 代行(super_admin)が設定した状態は、テナント本人が見ても同じ onboarding_stage になる", async () => {
        // 代行完了直後を想定: onboarding_industry が既に設定済みの状態を、
        // 本人の client_admin セッションで取得する。
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: "2026-07-01T00:00:00.000Z",
              onboarding_widget_seen_at: null,
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // faq_docs
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        // 代行(super_admin)が完了させたか本人が完了させたかをこのクエリは区別しない —
        // industryAnswered は onboarding_industry の非nullのみで判定するため、
        // 「初めまして」が本人の次回ログインで再生されることはない。
        expect(res.body.onboarding_stage.industryAnswered).toBe(true);
      });

      it("faq_docs クエリが失敗しても my-tenant 応答全体は壊れない(フェイルセーフ)", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: null, onboarding_widget_seen_at: null,
              created_at: "2026-08-01T00:00:00.000Z",
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

      // オンボ 是正D-2: フェイルセーフはfaq_docs失敗のみ検証済みで、chat_sessions失敗が
      // 非対称に未検証だった。
      it("chat_sessions クエリが失敗しても my-tenant 応答全体は壊れない(フェイルセーフ)", async () => {
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: "beauty", onboarding_completed_at: null, onboarding_widget_seen_at: null,
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [{ published_count: "1", draft_count: "0" }], rowCount: 1 }) // faq_docs: 成功
          .mockRejectedValueOnce(new Error("connection lost")); // chat_sessions 失敗

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.onboarding_stage.firstConversation).toBe(false);
        expect(res.body.onboarding_stage.knowledgePublished).toBe(true);
      });

      // オンボ 是正A-1: P6マージ前(4段階モデル導入前)に作られたテナントは
      // onboarding_industry が一律 NULL のため、カットオフが無いと「新規」と
      // 誤判定され新UIに強制着地する(本番影響あり)。created_at がカットオフより
      // 前なら onboarding_stage 自体が null になることを固定する。
      it("カットオフより前に作られた既存テナントは onboarding_stage が null になる(新規誤判定の防止)", async () => {
        // fetchOnboardingStageStatusはカットオフ判定より先にfaq_docs/chat_sessionsを
        // 実行する(deriveOnboardingStage内でカットオフを見て初めてnullを返す)ため、
        // 他のテストと同じ4回分のモックが必要。
        mockDb.query
          .mockResolvedValueOnce({
            rows: [{
              id: "tenant1", name: "Test", features: {}, lemonslice_agent_id: null, conversion_types: [],
              onboarding_industry: null, onboarding_completed_at: null, onboarding_widget_seen_at: null,
              created_at: "2026-01-01T00:00:00.000Z",
            }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // checkHasR2c2
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // faq_docs
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

        const res = await request(app)
          .get("/v1/admin/my-tenant")
          .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.onboarding_stage).toBeNull();
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
            created_at: "2026-08-01T00:00:00.000Z",
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
        hasDraftFaq: false,
      });
    });

    it("client_adminからのアクセスは従来どおり403(super_admin専用)", async () => {
      const res = await request(app)
        .get("/v1/admin/tenants/t1")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(403);
    });

    // オンボ 是正A-1: super_adminの代行(previewMode)経路でも既存テナントの
    // 誤判定を防ぐ。my-tenant側と同じカットオフ判定が :id 経路にも効くこと。
    it("カットオフより前に作られたテナントは onboarding_stage が null になる", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: "t1", name: "Test", plan: "starter", is_active: true, features: {},
            onboarding_industry: null, onboarding_widget_seen_at: null,
            created_at: "2020-01-01T00:00:00.000Z",
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // faq_docs
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // chat_sessions

      const res = await request(app)
        .get("/v1/admin/tenants/t1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.onboarding_stage).toBeNull();
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

    it("失効させたキーのハッシュを revokeTenantApiKeyIfCurrent に正しい (tenantId, keyHash) で渡す（インメモリ即時反映の配線）", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: "k1", tenant_id: "t1", is_active: false, key_hash: "the-real-key-hash" }], rowCount: 1 });
      const res = await request(app)
        .delete("/v1/admin/tenants/t1/keys/k1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(mockRevokeTenantApiKeyIfCurrent).toHaveBeenLastCalledWith("t1", "the-real-key-hash");
    });

    it("client_admin は403で弾かれ、失効処理は一切走らない（権限境界）", async () => {
      const callsBefore = (mockRevokeTenantApiKeyIfCurrent as jest.Mock).mock.calls.length;
      const res = await request(app)
        .delete("/v1/admin/tenants/t1/keys/k1")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(403);
      expect((mockRevokeTenantApiKeyIfCurrent as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it("越境: 他テナントのkeyIdを指定した場合、DBのWHERE tenant_id条件で一致せず404になり、失効処理も走らない", async () => {
      // tenant_id=$2 の条件に一致しないシナリオ = DB側が0件を返す（実クエリのWHERE句がこの防御を担う）
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const callsBefore = (mockRevokeTenantApiKeyIfCurrent as jest.Mock).mock.calls.length;
      const res = await request(app)
        .delete("/v1/admin/tenants/tenant-a/keys/key-belongs-to-tenant-b")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect((mockRevokeTenantApiKeyIfCurrent as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it("イレギュラー: 同じキーを2回連続で失効させても、2回目もエラーにならず200 ok=trueを返す（べき等）", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "k1", tenant_id: "t1", is_active: false, key_hash: "h1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: "k1", tenant_id: "t1", is_active: false, key_hash: "h1" }], rowCount: 1 });
      const res1 = await request(app).delete("/v1/admin/tenants/t1/keys/k1").set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      const res2 = await request(app).delete("/v1/admin/tenants/t1/keys/k1").set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body.ok).toBe(true);
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
