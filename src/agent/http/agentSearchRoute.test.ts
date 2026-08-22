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

import { createAgentSearchHandler } from "./agentSearchRoute";
import { runSearchAgent } from "../flow/searchAgent";
import { fetchDefaultExcludedIds } from "../../lib/defaultExcludedIds";

const mockedRunSearchAgent = runSearchAgent as jest.MockedFunction<typeof runSearchAgent>;
const mockedFetchDefaultExcludedIds = fetchDefaultExcludedIds as jest.MockedFunction<
  typeof fetchDefaultExcludedIds
>;

function mockReq(overrides: Record<string, unknown> = {}): AuthedRequest {
  const headers: Record<string, string> = (overrides.headers as Record<string, string>) ?? {};
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    headers,
    body: { q: "送料について" },
    tenantId: undefined as unknown as string,
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
});
