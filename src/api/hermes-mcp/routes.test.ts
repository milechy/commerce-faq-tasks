// src/api/hermes-mcp/routes.test.ts

import express from "express";
import request from "supertest";
import { registerHermesMcpRoutes } from "./routes";

jest.mock("../../lib/hermesConsent", () => ({
  isHermesDataConsentGranted: jest.fn(),
  listHermesConsentingTenantIds: jest.fn(),
}));
jest.mock("./hermesMcpRepository", () => ({
  searchConversations: jest.fn(),
}));

import { isHermesDataConsentGranted, listHermesConsentingTenantIds } from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";

const mockIsConsentGranted = isHermesDataConsentGranted as jest.Mock;
const mockListConsenting = listHermesConsentingTenantIds as jest.Mock;
const mockSearchConversations = searchConversations as jest.Mock;

const API_KEY = "test-hermes-mcp-key";

function makeApp() {
  const app = express();
  registerHermesMcpRoutes(app);
  return app;
}

function authedGet(path: string) {
  return request(makeApp()).get(path).set("Authorization", `Bearer ${API_KEY}`);
}

beforeEach(() => {
  process.env.HERMES_MCP_API_KEY = API_KEY;
  mockIsConsentGranted.mockReset();
  mockListConsenting.mockReset();
  mockSearchConversations.mockReset();
});

afterEach(() => {
  delete process.env.HERMES_MCP_API_KEY;
});

describe("認証ガード", () => {
  it("Bearerトークンなしは401(tenants)", async () => {
    const res = await request(makeApp()).get("/v1/hermes-mcp/tenants");
    expect(res.status).toBe(401);
  });

  it("Bearerトークンなしは401(conversations)", async () => {
    const res = await request(makeApp()).get("/v1/hermes-mcp/conversations?tenant_id=carnation");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/hermes-mcp/tenants", () => {
  it("同意済みテナントID一覧を返す", async () => {
    mockListConsenting.mockResolvedValue(["carnation"]);
    const res = await authedGet("/v1/hermes-mcp/tenants");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantIds: ["carnation"] });
  });
});

describe("GET /v1/hermes-mcp/conversations", () => {
  it("tenant_id未指定は400", async () => {
    const res = await authedGet("/v1/hermes-mcp/conversations");
    expect(res.status).toBe(400);
    expect(mockIsConsentGranted).not.toHaveBeenCalled();
  });

  it("未同意テナントは403、searchConversationsは呼ばれない(同意チェック最優先)", async () => {
    mockIsConsentGranted.mockResolvedValue(false);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=other-tenant");
    expect(res.status).toBe(403);
    expect(mockSearchConversations).not.toHaveBeenCalled();
  });

  it("同意済みテナントは検索結果を返す", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockSearchConversations.mockResolvedValue([
      { sessionId: "s1", role: "user", content: "hi", createdAt: "x", judgeScore: 80, converted: true },
    ]);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(mockSearchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "carnation" }),
    );
  });

  it("不正なmin_judge_score(範囲外)は400", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&min_judge_score=150");
    expect(res.status).toBe(400);
    expect(mockSearchConversations).not.toHaveBeenCalled();
  });

  it("不正なlimit(範囲外)は400", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&limit=99999");
    expect(res.status).toBe(400);
  });

  it("converted_only=trueがsearchConversationsに伝搬する", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockSearchConversations.mockResolvedValue([]);
    await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&converted_only=true");
    expect(mockSearchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ convertedOnly: true }),
    );
  });
});
