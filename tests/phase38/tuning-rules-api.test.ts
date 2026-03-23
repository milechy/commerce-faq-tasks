// tests/phase38/tuning-rules-api.test.ts
// Phase38: チューニングルールAPI — モックExpressアプリを使ったユニットテスト

import express from "express";
import request from "supertest";
import { registerTuningRoutes } from "../../src/api/admin/tuning/routes";

jest.mock("../../src/api/admin/tuning/tuningRulesRepository");

import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} from "../../src/api/admin/tuning/tuningRulesRepository";

const mockListRules = listRules as jest.MockedFunction<typeof listRules>;
const mockCreateRule = createRule as jest.MockedFunction<typeof createRule>;
const mockUpdateRule = updateRule as jest.MockedFunction<typeof updateRule>;
const mockDeleteRule = deleteRule as jest.MockedFunction<typeof deleteRule>;

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({
  app_metadata: { role: "super_admin", tenant_id: "demo-tenant" },
});

const RULE_FIXTURE = {
  id: 1,
  tenant_id: "demo-tenant",
  trigger_pattern: "テスト,test-trigger",
  expected_behavior: "テスト用の期待動作",
  priority: 50,
  is_active: true,
  created_by: "admin@example.com",
  source_message_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("Tuning Rules API", () => {
  let app: express.Application;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerTuningRoutes(app);
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/tuning-rules
  // -------------------------------------------------------------------------
  describe("GET /v1/admin/tuning-rules", () => {
    it("returns 200 and rules array", async () => {
      mockListRules.mockResolvedValueOnce([RULE_FIXTURE] as any);

      const res = await request(app)
        .get("/v1/admin/tuning-rules")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rules)).toBe(true);
    });

    it("returns 401 without auth token", async () => {
      const res = await request(app).get("/v1/admin/tuning-rules");
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/tuning-rules
  // -------------------------------------------------------------------------
  describe("POST /v1/admin/tuning-rules", () => {
    it("creates a rule and returns 201 with id and trigger_pattern", async () => {
      mockCreateRule.mockResolvedValueOnce(RULE_FIXTURE as any);

      const body = {
        tenant_id: "demo-tenant",
        trigger_pattern: RULE_FIXTURE.trigger_pattern,
        expected_behavior: RULE_FIXTURE.expected_behavior,
        priority: RULE_FIXTURE.priority,
      };

      const res = await request(app)
        .post("/v1/admin/tuning-rules")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.trigger_pattern).toBe(RULE_FIXTURE.trigger_pattern);
    });

    it("returns 401 without auth token", async () => {
      const res = await request(app)
        .post("/v1/admin/tuning-rules")
        .send({
          tenant_id: "demo-tenant",
          trigger_pattern: "test",
          expected_behavior: "test behavior",
        });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /v1/admin/tuning-rules/:id
  // -------------------------------------------------------------------------
  describe("PUT /v1/admin/tuning-rules/:id", () => {
    it("updates a rule and returns 200", async () => {
      const updatedRule = { ...RULE_FIXTURE, expected_behavior: "更新後の期待動作" };
      mockUpdateRule.mockResolvedValueOnce(updatedRule as any);

      const res = await request(app)
        .put("/v1/admin/tuning-rules/1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ expected_behavior: "更新後の期待動作" });

      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/admin/tuning-rules/:id
  // -------------------------------------------------------------------------
  describe("DELETE /v1/admin/tuning-rules/:id", () => {
    it("deletes a rule and returns 200 with ok=true", async () => {
      mockDeleteRule.mockResolvedValueOnce(RULE_FIXTURE as any);

      const res = await request(app)
        .delete("/v1/admin/tuning-rules/1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
