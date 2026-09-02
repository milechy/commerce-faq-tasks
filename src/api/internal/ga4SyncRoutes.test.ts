// src/api/internal/ga4SyncRoutes.test.ts
// GID [A2A-0d]: Cron駆動のGA4連携(health-check-all/health-check/sync)は、
// プラン降格後も ga4_property_id が残るテナントに対してGA4 API呼び出し
// (原価が発生する)を続けてはいけない。呼び出し前にプランを確認し、
// entitlementが無ければ結果を "plan_restricted" として API を叩かずに終える。

import express from "express";
import type { Express } from "express";
import { request } from "../../../tests/helpers/testServer";
import type { Pool } from "pg";
import { registerInternalGa4SyncRoutes } from "./ga4SyncRoutes";

// HMAC検証はこのテストの関心事ではないため、素通りさせる。
jest.mock("../../lib/crypto/hmacVerifier", () => ({
  internalHmacMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockRunGa4HealthCheck = jest.fn();
jest.mock("../../lib/ga4/ga4HealthCheck", () => ({
  runGa4HealthCheck: (...args: unknown[]) => mockRunGa4HealthCheck(...args),
}));

const mockFetchGa4Conversions = jest.fn();
jest.mock("../../lib/ga4/ga4ConversionFetcher", () => ({
  fetchGa4Conversions: (...args: unknown[]) => mockFetchGa4Conversions(...args),
}));

const mockQuery = jest.fn();
const db = { query: (...args: unknown[]) => mockQuery(...args) } as unknown as Pool;

let app: Express;

beforeEach(() => {
  mockQuery.mockReset();
  mockRunGa4HealthCheck.mockReset().mockResolvedValue({ status: "connected", errorMessage: null });
  mockFetchGa4Conversions.mockReset().mockResolvedValue({ conversions: 0 });
  app = express();
  app.use(express.json());
  registerInternalGa4SyncRoutes(app, db);
});

describe("POST /internal/ga4/health-check-all (plan gate)", () => {
  it("plan未達のテナントはGA4 APIを呼ばずplan_restrictedを返す", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "t-standard", ga4_property_id: "111", plan: "standard" },
        { id: "t-growth", ga4_property_id: "222", plan: "growth" },
      ],
    });

    const res = await request(app).post("/internal/ga4/health-check-all").send({});

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenant_id: "t-standard", status: "plan_restricted" }),
        expect.objectContaining({ tenant_id: "t-growth", status: "connected" }),
      ])
    );
    // GA4 APIはgrowthテナントの分だけ呼ばれる(standardは呼ばない)
    expect(mockRunGa4HealthCheck).toHaveBeenCalledTimes(1);
    expect(mockRunGa4HealthCheck).toHaveBeenCalledWith("t-growth", "222", db);
  });
});

describe("POST /internal/ga4/health-check (plan gate)", () => {
  it("plan未達なら reason=plan_restricted を返しGA4 APIを呼ばない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ga4_property_id: "111", plan: "starter" }] });

    const res = await request(app).post("/internal/ga4/health-check").send({ tenant_id: "t1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: "plan_restricted" });
    expect(mockRunGa4HealthCheck).not.toHaveBeenCalled();
  });
});

describe("POST /internal/ga4/sync (plan gate)", () => {
  it("plan未達なら reason=plan_restricted を返しGA4 APIを呼ばない", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ga4_property_id: "111", ga4_status: "connected", plan: "free_ad" }],
    });

    const res = await request(app)
      .post("/internal/ga4/sync")
      .send({ tenant_id: "t1", start_date: "2026-08-01", end_date: "2026-08-31" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: "plan_restricted" });
    expect(mockFetchGa4Conversions).not.toHaveBeenCalled();
  });

  it("plan=growth かつ ga4_status=connected なら通過する", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ga4_property_id: "111", ga4_status: "connected", plan: "growth" }],
    });

    const res = await request(app)
      .post("/internal/ga4/sync")
      .send({ tenant_id: "t1", start_date: "2026-08-01", end_date: "2026-08-31" });

    expect(res.status).toBe(200);
    expect(mockFetchGa4Conversions).toHaveBeenCalledTimes(1);
  });
});
