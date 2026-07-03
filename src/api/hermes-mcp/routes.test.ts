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
jest.mock("../../lib/notifications", () => ({
  createNotification: jest.fn(),
}));

const mockInsertProposal = jest.fn();
const mockFindProposalIdByDedupKey = jest.fn();
jest.mock("./proposalRepository", () => ({
  createHermesProposalRepository: jest.fn(() => ({
    insertProposal: mockInsertProposal,
    findProposalIdByDedupKey: mockFindProposalIdByDedupKey,
  })),
}));

import { isHermesDataConsentGranted, listHermesConsentingTenantIds } from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";
import { createNotification } from "../../lib/notifications";

const mockIsConsentGranted = isHermesDataConsentGranted as jest.Mock;
const mockListConsenting = listHermesConsentingTenantIds as jest.Mock;
const mockSearchConversations = searchConversations as jest.Mock;
const mockCreateNotification = createNotification as jest.Mock;

const API_KEY = "test-hermes-mcp-key";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerHermesMcpRoutes(app);
  return app;
}

function authedGet(path: string) {
  return request(makeApp()).get(path).set("Authorization", `Bearer ${API_KEY}`);
}

function authedPost(path: string, body: object) {
  return request(makeApp()).post(path).set("Authorization", `Bearer ${API_KEY}`).send(body);
}

const VALID_TENANT_PROPOSAL = {
  scope: "tenant",
  tenant_id: "carnation",
  title: "保証訴求の改善",
  rationale: "会話ログから保証質問への回答が購入に繋がるパターンを確認",
  suggested_action: "保証訴求を初回応答に含める",
  dedup_key: "tenant:carnation:warranty-pitch",
};

const VALID_GLOBAL_PROPOSAL = {
  scope: "global",
  title: "心理原則scarcityの全体採用を検討",
  rationale: "複数の同意済みテナントで共通するパターンを確認",
  suggested_action: "デフォルト戦略に追加検討",
  dedup_key: "global:scarcity-pattern",
};

beforeEach(() => {
  process.env.HERMES_MCP_API_KEY = API_KEY;
  mockIsConsentGranted.mockReset();
  mockListConsenting.mockReset();
  mockSearchConversations.mockReset();
  mockCreateNotification.mockReset().mockResolvedValue(undefined);
  mockInsertProposal.mockReset().mockResolvedValue(true);
  mockFindProposalIdByDedupKey.mockReset().mockResolvedValue("1");
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

describe("POST /v1/hermes-mcp/proposals", () => {
  it("認証なしは401", async () => {
    const res = await request(makeApp()).post("/v1/hermes-mcp/proposals").send(VALID_TENANT_PROPOSAL);
    expect(res.status).toBe(401);
  });

  it("正常系: tenant提案(同意済み)を保存し201・通知がclient_admin宛に送られる", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ proposal_id: "1", duplicate: false });
    expect(mockIsConsentGranted).toHaveBeenCalledWith("carnation");
    expect(mockInsertProposal).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "tenant", tenantId: "carnation" }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: "client_admin", recipientTenantId: "carnation" }),
    );
  });

  it("正常系: global提案を保存し201・通知がsuper_admin宛に送られる(同意チェックは呼ばれない)", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_GLOBAL_PROPOSAL);

    expect(res.status).toBe(201);
    expect(mockIsConsentGranted).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: "super_admin", recipientTenantId: undefined }),
    );
  });

  it("未同意テナントは403、insertProposalは呼ばれない(同意チェック最優先)", async () => {
    mockIsConsentGranted.mockResolvedValue(false);
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(403);
    expect(mockInsertProposal).not.toHaveBeenCalled();
  });

  it("重複投稿(dedup_key衝突)は200でduplicate:trueを返す(エラー扱いしない)", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockInsertProposal.mockResolvedValue(false);
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicate: true });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: 不正なscopeは400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_GLOBAL_PROPOSAL, scope: "bogus" });
    expect(res.status).toBe(400);
    expect(mockInsertProposal).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: scope=tenantでtenant_id欠落は400", async () => {
    const { tenant_id: _drop, ...rest } = VALID_TENANT_PROPOSAL;
    const res = await authedPost("/v1/hermes-mcp/proposals", rest);
    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: scope=globalでtenant_idを渡すと400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_GLOBAL_PROPOSAL, tenant_id: "carnation" });
    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: titleが空文字は400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_GLOBAL_PROPOSAL, title: "" });
    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: dedup_key欠落は400", async () => {
    const { dedup_key: _drop, ...rest } = VALID_GLOBAL_PROPOSAL;
    const res = await authedPost("/v1/hermes-mcp/proposals", rest);
    expect(res.status).toBe(400);
  });
});
