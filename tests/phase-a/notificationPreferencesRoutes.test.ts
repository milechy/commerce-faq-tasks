// tests/phase-a/notificationPreferencesRoutes.test.ts
import express from "express";
import request from "supertest";
import { registerNotificationPreferencesRoutes } from "../../src/api/admin/tenants/notificationPreferencesRoutes";
import jwt from "jsonwebtoken";

function makeMockDb(getRows: any[] = [], putOk = true) {
  let call = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const i = call++;
      if (i === 0 && putOk !== false) {
        return Promise.resolve({ rows: getRows });
      }
      if (!putOk) return Promise.reject(new Error("db error"));
      return Promise.resolve({ rows: [] });
    }),
  } as any;
}

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  process.env.NODE_ENV = "development";
  registerNotificationPreferencesRoutes(app, db);
  return app;
}

function makeToken(tenantId: string) {
  return jwt.sign({ app_metadata: { tenant_id: tenantId, role: "client_admin" } }, "test");
}

describe("Notification Preferences Routes", () => {
  afterEach(() => { delete process.env.NODE_ENV; });

  describe("GET /v1/admin/tenants/:id/notification-preferences", () => {
    it("returns preferences list", async () => {
      const rows = [
        { notification_type: "ga4_error", email_enabled: true, in_app_enabled: false, threshold: null },
      ];
      const db = makeMockDb(rows);
      const app = makeApp(db);
      const res = await request(app)
        .get("/v1/admin/tenants/t1/notification-preferences")
        .set("Authorization", `Bearer ${makeToken("t1")}`);
      expect(res.status).toBe(200);
      expect(res.body.preferences).toHaveLength(1);
      expect(res.body.preferences[0].notification_type).toBe("ga4_error");
    });

    it("returns 403 for wrong tenant", async () => {
      const app = makeApp(makeMockDb([]));
      const res = await request(app)
        .get("/v1/admin/tenants/other/notification-preferences")
        .set("Authorization", `Bearer ${makeToken("t1")}`);
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /v1/admin/tenants/:id/notification-preferences", () => {
    it("upserts preference and returns ok", async () => {
      let callCount = 0;
      const db = {
        query: jest.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({ rows: [] });
        }),
      } as any;
      const app = makeApp(db);
      const res = await request(app)
        .put("/v1/admin/tenants/t1/notification-preferences")
        .set("Authorization", `Bearer ${makeToken("t1")}`)
        .send({ notification_type: "ga4_error", email_enabled: true, in_app_enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(callCount).toBe(1);
    });

    it("returns 400 for invalid body", async () => {
      const app = makeApp(makeMockDb([]));
      const res = await request(app)
        .put("/v1/admin/tenants/t1/notification-preferences")
        .set("Authorization", `Bearer ${makeToken("t1")}`)
        .send({ email_enabled: "not-a-bool" });
      expect(res.status).toBe(400);
    });

    it("returns 403 for wrong tenant", async () => {
      const app = makeApp(makeMockDb([]));
      const res = await request(app)
        .put("/v1/admin/tenants/other/notification-preferences")
        .set("Authorization", `Bearer ${makeToken("t1")}`)
        .send({ notification_type: "ga4_error", email_enabled: true, in_app_enabled: true });
      expect(res.status).toBe(403);
    });
  });
});
