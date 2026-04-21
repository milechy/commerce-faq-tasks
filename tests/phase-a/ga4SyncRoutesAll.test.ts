// tests/phase-a/ga4SyncRoutesAll.test.ts
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
import { registerInternalGa4SyncRoutes } from "../../src/api/internal/ga4SyncRoutes";

jest.mock("../../src/lib/ga4/ga4HealthCheck", () => ({
  runGa4HealthCheck: jest.fn(),
}));

import { runGa4HealthCheck } from "../../src/lib/ga4/ga4HealthCheck";
const mockHealthCheck = runGa4HealthCheck as jest.MockedFunction<typeof runGa4HealthCheck>;

const HMAC_SECRET = "test-internal-hmac-secret";

function makeHmacHeaders(body: unknown = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${JSON.stringify(body)}`;
  const signature = createHmac("sha256", HMAC_SECRET).update(message).digest("hex");
  return {
    "x-internal-request": "1",
    "x-hmac-timestamp": timestamp,
    "x-hmac-signature": signature,
  };
}

function makeApp(queryRows: unknown[]) {
  const app = express();
  app.use(express.json());
  process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
  process.env.NODE_ENV = "production";

  const mockDb: any = {
    query: jest.fn().mockResolvedValue({ rows: queryRows, rowCount: queryRows.length }),
  };
  registerInternalGa4SyncRoutes(app, mockDb);
  return { app, mockDb };
}

describe("POST /internal/ga4/health-check-all", () => {
  afterEach(() => {
    delete process.env.INTERNAL_API_HMAC_SECRET;
    delete process.env.NODE_ENV;
    mockHealthCheck.mockClear();
  });

  it("returns results array for all connected tenants", async () => {
    mockHealthCheck
      .mockResolvedValueOnce({ status: "connected", connectedAt: new Date() })
      .mockResolvedValueOnce({ status: "connected", connectedAt: new Date() });

    const { app } = makeApp([
      { id: "tenant-a", ga4_property_id: "111" },
      { id: "tenant-b", ga4_property_id: "222" },
    ]);

    const body = {};
    const res = await request(app)
      .post("/internal/ga4/health-check-all")
      .set(makeHmacHeaders(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].status).toBe("connected");
    expect(res.body.results[1].status).toBe("connected");
    expect(res.body.checked_at).toBeTruthy();
  });

  it("includes error tenants in results", async () => {
    mockHealthCheck
      .mockResolvedValueOnce({ status: "connected", connectedAt: new Date() })
      .mockResolvedValueOnce({ status: "error", errorMessage: "permission_denied" });

    const { app } = makeApp([
      { id: "tenant-a", ga4_property_id: "111" },
      { id: "tenant-c", ga4_property_id: "333" },
    ]);

    const body = {};
    const res = await request(app)
      .post("/internal/ga4/health-check-all")
      .set(makeHmacHeaders(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    const errorResult = res.body.results.find((r: any) => r.tenant_id === "tenant-c");
    expect(errorResult.status).toBe("error");
    expect(errorResult.error_message).toBe("permission_denied");
  });

  it("returns empty results when no tenants are configured", async () => {
    const { app } = makeApp([]);
    const body = {};
    const res = await request(app)
      .post("/internal/ga4/health-check-all")
      .set(makeHmacHeaders(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(0);
  });

  it("returns 401 without HMAC headers", async () => {
    const { app } = makeApp([]);
    const res = await request(app)
      .post("/internal/ga4/health-check-all")
      .set("x-internal-request", "1")
      .send({});

    expect(res.status).toBe(401);
  });

  it("returns 403 without x-internal-request header", async () => {
    const { app } = makeApp([]);
    const body = {};
    const headers = makeHmacHeaders(body);
    const { "x-internal-request": _removed, ...headersWithoutInternal } = headers;
    const res = await request(app)
      .post("/internal/ga4/health-check-all")
      .set(headersWithoutInternal)
      .send(body);

    expect(res.status).toBe(403);
  });
});
