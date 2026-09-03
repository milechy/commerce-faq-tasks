// src/lib/billing/billingApi.economics.test.ts
// GET /v1/admin/billing/economics — テナント別の採算(売上推計 − API原価)。
//
// ★このテストが守っている事故★
// このエンドポイントは原価とマージン倍率(margin_assumed)を同じ応答に載せる。
// テナント(client_admin)に届いた瞬間、粗利率がそのまま逆算される。
// costCalculator.ts の原価開示方針[H-10]は「面ごとに決める」であり、
// 運営専用の面であるここは super_admin 限定でなければならない。
import express from "express";
import { request } from "../../../tests/helpers/testServer";
import pino from "pino";
import { registerBillingAdminRoutes } from "./billingApi";
import { computeExpectedBilling } from "./stripeSync";
import { _clearEconomicsCache } from "./tenantEconomics";

jest.mock("./stripeSync", () => ({
  computeExpectedBilling: jest.fn(),
}));

const silentLogger = pino({ level: "silent" });

type Role = "super_admin" | "client_admin";
function makeApp(db: any, role: Role, tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { email: "admin@example.com", app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerBillingAdminRoutes(app, db, silentLogger, []);
  return app;
}

function makeDb() {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("FROM usage_logs")) {
        return {
          rows: [{
            tenant_id: "tenant-a", total_requests: "10",
            cost_base_billable: "1000", cost_base_nonbillable: "0",
            recorded_rows: "10", all_rows: "10",
          }],
        };
      }
      if (sql.includes("FROM tenants WHERE id = ANY")) {
        return { rows: [{ id: "tenant-a", name: "Tenant A" }] };
      }
      if (sql.includes("SELECT name FROM tenants")) return { rows: [{ name: "Tenant A" }] };
      if (sql.includes("SELECT plan FROM tenants")) return { rows: [{ plan: "standard" }] };
      if (sql.includes("stripe_subscriptions")) return { rows: [] };
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearEconomicsCache();
  (computeExpectedBilling as jest.Mock).mockResolvedValue({
    totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0,
    billedQuantity: 0, fallbackMultiplier: 1, textUnits: 100, avatarMinutes: 0,
  });
});

describe("GET /v1/admin/billing/economics", () => {
  it("★client_admin は到達できない（原価とマージン倍率が漏れる面）★", async () => {
    const res = await request(makeApp(makeDb(), "client_admin"))
      .get("/v1/admin/billing/economics?period=202609")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(403);
  });

  it("super_admin は取得できる", async () => {
    const res = await request(makeApp(makeDb(), "super_admin"))
      .get("/v1/admin/billing/economics?period=202609")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(200);
    expect(res.body.period_yyyymm).toBe("202609");
    expect(res.body.boundary).toBe("jst_calendar_month");
    expect(res.body.cost_basis).toBe("variable_only");
    expect(res.body.tenants).toHaveLength(1);
  });

  it("period 必須（未指定なら400）", async () => {
    const res = await request(makeApp(makeDb(), "super_admin"))
      .get("/v1/admin/billing/economics")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(400);
  });

  it("不正な period は400（13月・0月・日付形式を弾く）", async () => {
    const app = makeApp(makeDb(), "super_admin");
    for (const p of ["202613", "202600", "2026-09", "20269", "abcdef"]) {
      const res = await request(app)
        .get(`/v1/admin/billing/economics?period=${p}`)
        .set("Authorization", "Bearer dummy");
      expect([p, res.status]).toEqual([p, 400]);
    }
  });

  it("★任意の from/to を受け付けない（暦月以外で基本料を按分させない）★", async () => {
    const res = await request(makeApp(makeDb(), "super_admin"))
      .get("/v1/admin/billing/economics?from=2026-09-01&to=2026-09-15")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/billing/economics/:tenantId", () => {
  it("★client_admin は到達できない★", async () => {
    const res = await request(makeApp(makeDb(), "client_admin"))
      .get("/v1/admin/billing/economics/tenant-a?period=202609")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(403);
  });

  it("reconcile 未指定なら Stripe を叩かない（既定は推計のみ）", async () => {
    const db = makeDb();
    const res = await request(makeApp(db, "super_admin"))
      .get("/v1/admin/billing/economics/tenant-a?period=202609")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(200);
    // stripe_subscriptions を引いていない = 突合経路に入っていない
    const sqls = db.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s: string) => s.includes("stripe_subscriptions"))).toBe(false);
    expect(res.body.invoiced.amount_jpy).toBeNull();
    expect(res.body.variance_jpy).toBeNull();
  });

  it("存在しないテナントは404", async () => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM usage_logs")) return { rows: [] };
        return { rows: [] }; // tenants も空
      }),
    };
    const res = await request(makeApp(db, "super_admin"))
      .get("/v1/admin/billing/economics/nope?period=202609")
      .set("Authorization", "Bearer dummy");
    expect(res.status).toBe(404);
  });
});
