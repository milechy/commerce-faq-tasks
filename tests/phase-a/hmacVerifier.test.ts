// tests/phase-a/hmacVerifier.test.ts
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { internalHmacMiddleware, verifyHmacSignature } from "../../src/lib/crypto/hmacVerifier";

const SECRET = "test-secret-for-jest";

function makeSignedHeaders(body: unknown, secret: string = SECRET) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${JSON.stringify(body)}`;
  const signature = createHmac("sha256", secret).update(message).digest("hex");
  return { "x-hmac-timestamp": timestamp, "x-hmac-signature": signature };
}

describe("verifyHmacSignature", () => {
  const body = { task: "test" };

  it("returns true for valid signature", () => {
    const { "x-hmac-timestamp": ts, "x-hmac-signature": sig } = makeSignedHeaders(body);
    expect(verifyHmacSignature(SECRET, ts, body, sig)).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const { "x-hmac-timestamp": ts, "x-hmac-signature": sig } = makeSignedHeaders(body, "wrong-secret");
    expect(verifyHmacSignature(SECRET, ts, body, sig)).toBe(false);
  });

  it("returns false for stale timestamp (>5min)", () => {
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
    const message = `${oldTimestamp}:${JSON.stringify(body)}`;
    const sig = createHmac("sha256", SECRET).update(message).digest("hex");
    expect(verifyHmacSignature(SECRET, oldTimestamp, body, sig)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const { "x-hmac-timestamp": ts, "x-hmac-signature": sig } = makeSignedHeaders(body);
    expect(verifyHmacSignature(SECRET, ts, { task: "tampered" }, sig)).toBe(false);
  });
});

describe("internalHmacMiddleware", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    process.env.INTERNAL_API_HMAC_SECRET = SECRET;
    app.post("/internal/test", internalHmacMiddleware, (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  afterEach(() => {
    delete process.env.INTERNAL_API_HMAC_SECRET;
  });

  it("allows request with valid HMAC and x-internal-request header", async () => {
    const app = makeApp();
    const body = { task: "sync" };
    const headers = makeSignedHeaders(body);
    const res = await request(app)
      .post("/internal/test")
      .set("x-internal-request", "1")
      .set(headers)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects without x-internal-request header", async () => {
    const app = makeApp();
    const body = { task: "sync" };
    const headers = makeSignedHeaders(body);
    const res = await request(app)
      .post("/internal/test")
      .set(headers)
      .send(body);
    expect(res.status).toBe(403);
  });

  it("rejects with invalid HMAC signature", async () => {
    const app = makeApp();
    const body = { task: "sync" };
    const res = await request(app)
      .post("/internal/test")
      .set("x-internal-request", "1")
      .set("x-hmac-timestamp", Math.floor(Date.now() / 1000).toString())
      .set("x-hmac-signature", "deadbeef".repeat(8))
      .send(body);
    expect(res.status).toBe(401);
  });

  it("rejects when HMAC headers are missing", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/internal/test")
      .set("x-internal-request", "1")
      .send({ task: "sync" });
    expect(res.status).toBe(401);
  });
});
