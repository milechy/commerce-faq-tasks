// src/api/hermes-mcp/hermesMcpAuth.test.ts

import express from "express";
import request from "supertest";
import { hermesMcpAuthMiddleware } from "./hermesMcpAuth";

function makeApp() {
  const app = express();
  app.get("/protected", hermesMcpAuthMiddleware, (_req, res) => res.json({ ok: true }));
  return app;
}

const ENV_KEY = "HERMES_MCP_API_KEY";

beforeEach(() => {
  delete process.env[ENV_KEY];
});

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("hermesMcpAuthMiddleware", () => {
  it("HERMES_MCP_API_KEY未設定は503(fail-closed)", async () => {
    const res = await request(makeApp()).get("/protected").set("Authorization", "Bearer anything");
    expect(res.status).toBe(503);
  });

  it("Authorizationヘッダなしは401", async () => {
    process.env[ENV_KEY] = "secret-key-123";
    const res = await request(makeApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("Bearer以外のスキームは401", async () => {
    process.env[ENV_KEY] = "secret-key-123";
    const res = await request(makeApp()).get("/protected").set("Authorization", "Basic xxx");
    expect(res.status).toBe(401);
  });

  it("不正なトークンは401", async () => {
    process.env[ENV_KEY] = "secret-key-123";
    const res = await request(makeApp()).get("/protected").set("Authorization", "Bearer wrong-key");
    expect(res.status).toBe(401);
  });

  it("正しいトークンは200で通過", async () => {
    process.env[ENV_KEY] = "secret-key-123";
    const res = await request(makeApp()).get("/protected").set("Authorization", "Bearer secret-key-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("長さが違うトークンでも例外を投げず401を返す", async () => {
    process.env[ENV_KEY] = "secret-key-123";
    const res = await request(makeApp()).get("/protected").set("Authorization", "Bearer x");
    expect(res.status).toBe(401);
  });
});
