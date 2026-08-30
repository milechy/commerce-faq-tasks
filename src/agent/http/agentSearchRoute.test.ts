import type { Response } from "express";
import pino from "pino";
import type { AuthedRequest } from "./authMiddleware";

jest.mock("../flow/searchAgent", () => ({
  runSearchAgent: jest.fn(),
}));
jest.mock("../../lib/defaultExcludedIds", () => ({
  fetchDefaultExcludedIds: jest.fn(),
  mergeExcludedIds: jest.fn((excludedIds: unknown) => excludedIds ?? []),
}));
jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: jest.fn(),
}));

import { createAgentSearchHandler } from "./agentSearchRoute";
import { runSearchAgent } from "../flow/searchAgent";
import { fetchDefaultExcludedIds } from "../../lib/defaultExcludedIds";
import { trackUsage } from "../../lib/billing/usageTracker";
import { CHAT_LLM_MODEL } from "../../lib/billing/chatUsage";

const mockedRunSearchAgent = runSearchAgent as jest.MockedFunction<typeof runSearchAgent>;
const mockedFetchDefaultExcludedIds = fetchDefaultExcludedIds as jest.MockedFunction<
  typeof fetchDefaultExcludedIds
>;
const mockedTrackUsage = trackUsage as jest.MockedFunction<typeof trackUsage>;

function mockReq(overrides: Record<string, unknown> = {}): AuthedRequest {
  const headers: Record<string, string> = (overrides.headers as Record<string, string>) ?? {};
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    headers,
    body: { q: "送料について" },
    tenantId: undefined as unknown as string,
    requestId: "req-test-1",
    ...overrides,
  } as unknown as AuthedRequest;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe("createAgentSearchHandler", () => {
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchDefaultExcludedIds.mockResolvedValue([]);
    mockedRunSearchAgent.mockResolvedValue({ answer: "ok" } as any);
  });

  it("rejects request with no authenticated tenantId (401)", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({ tenantId: undefined });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "unauthorized" })
    );
    expect(mockedRunSearchAgent).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied x-tenant-id header and uses the authenticated tenantId", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({
      tenantId: "tenant-a",
      headers: { "x-tenant-id": "tenant-b" },
    });
    const res = mockRes();

    await handler(req, res);

    expect(mockedFetchDefaultExcludedIds).toHaveBeenCalledWith("tenant-a");
    expect(mockedRunSearchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a" })
    );
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it("scopes the search to the authenticated tenantId when no header is present", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({ tenantId: "tenant-a" });
    const res = mockRes();

    await handler(req, res);

    expect(mockedRunSearchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a" })
    );
  });

  it("still validates the request body before touching tenant resolution", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({ tenantId: "tenant-a", body: {} });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedRunSearchAgent).not.toHaveBeenCalled();
  });

  describe("x-tenant-id header cannot override the authenticated tenant (regression guard)", () => {
    it("ignores a header naming a real, differently-cased tenant id", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "Tenant-B" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("ignores an empty-string x-tenant-id header", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("ignores a whitespace-only x-tenant-id header", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "   " },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("ignores an oversized x-tenant-id header value (10k chars) without throwing", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "b".repeat(10_000) },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
      expect(res.status).not.toHaveBeenCalledWith(500);
    });

    it("ignores a header value containing embedded null bytes / control chars", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "tenant-b\u0000\u0007" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("does not read differently-cased header names (X-Tenant-Id, X-TENANT-ID) either", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "tenant-b" }, // mockReq lower-cases lookups; simulates any casing variant
      });
      // sanity: header() itself still resolves the value (proves the route just never calls it)
      expect(req.header("X-Tenant-Id")).toBe("tenant-b");

      const res = mockRes();
      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("a super_admin-authenticated request still resolves to its own authenticated tenantId, not the header", async () => {
      // super_admin's tenant switching must go through an explicit, guarded mechanism
      // (targetTenantId + isSuperAdmin check) elsewhere — never through this header.
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "super-admin-home-tenant",
        headers: { "x-tenant-id": "victim-tenant" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "super-admin-home-tenant" })
      );
    });
  });

  describe("defensive fail-closed when tenantId is falsy but not strictly undefined", () => {
    it("rejects with 401 when tenantId is an empty string", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "" });
      const res = mockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockedRunSearchAgent).not.toHaveBeenCalled();
    });

    it("rejects with 401 when tenantId is null", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: null as unknown as string });
      const res = mockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockedRunSearchAgent).not.toHaveBeenCalled();
    });

    it("never calls fetchDefaultExcludedIds before the tenant check (no side effects pre-auth)", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: undefined });
      const res = mockRes();

      await handler(req, res);

      expect(mockedFetchDefaultExcludedIds).not.toHaveBeenCalled();
    });
  });

  // 収益監査ギャップ [P0]: /agent.search・/agent/search は LLM 合成・埋め込みを
  // 実行するのに trackUsage を通っておらず完全に未計上だった。
  describe("billing usage tracking (revenue audit gap [P0])", () => {
    it("counts usage via trackUsage with featureUsed=chat, the authenticated tenantId and requestId", async () => {
      mockedRunSearchAgent.mockResolvedValue({
        answer: "ok",
        llmUsage: { prompt_tokens: 120, completion_tokens: 40 },
      } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a", requestId: "req-42" });
      const res = mockRes();

      await handler(req, res);

      expect(mockedTrackUsage).toHaveBeenCalledTimes(1);
      expect(mockedTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-a",
          requestId: "req-42",
          featureUsed: "chat",
          model: CHAT_LLM_MODEL,
          inputTokens: 120,
          outputTokens: 40,
        })
      );
    });

    it("does not pass a sessionId (agent.search is a one-shot search, not a conversation)", async () => {
      mockedRunSearchAgent.mockResolvedValue({
        answer: "ok",
        llmUsage: { prompt_tokens: 10, completion_tokens: 5 },
      } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      const params = mockedTrackUsage.mock.calls[0][0];
      expect(params.sessionId).toBeUndefined();
    });

    it("folds the OpenAI query embedding into extraLlmUsages at its real model rate (not the chat model)", async () => {
      mockedRunSearchAgent.mockResolvedValue({
        answer: "ok",
        llmUsage: { prompt_tokens: 100, completion_tokens: 20 },
        embeddingUsage: { model: "text-embedding-3-small", totalTokens: 512 },
      } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      expect(mockedTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          extraLlmUsages: [
            { model: "text-embedding-3-small", inputTokens: 512, outputTokens: 0 },
          ],
        })
      );
    });

    it("records {0,0} chat tokens when synthesis produced no usage (still one billable request)", async () => {
      mockedRunSearchAgent.mockResolvedValue({ answer: "ok" } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      expect(mockedTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          featureUsed: "chat",
          inputTokens: 0,
          outputTokens: 0,
        })
      );
      // no embedding/planner → extraLlmUsages omitted entirely
      expect(mockedTrackUsage.mock.calls[0][0]).not.toHaveProperty("extraLlmUsages");
    });

    it("does not count usage when the request is rejected (401 / 400) before running the agent", async () => {
      const handler = createAgentSearchHandler(logger);

      await handler(mockReq({ tenantId: undefined }), mockRes()); // 401
      await handler(mockReq({ tenantId: "tenant-a", body: {} }), mockRes()); // 400

      expect(mockedTrackUsage).not.toHaveBeenCalled();
    });
  });
});
