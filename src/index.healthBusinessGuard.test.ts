// src/index.healthBusinessGuard.test.ts
//
// GET /health/business は アクティブ tenant_id 一覧・24h の会話/CV/RAG 件数・
// 最終会話時刻という営業機微を返すため内部専用でなければならない（外部から無認証で
// 開示できた実績あり [P0]）。src/index.ts は app.listen 副作用のため丸ごと import
// できないので（index.wiringInvariants.test.ts と同じ制約）、index.ts と同一の
// ハンドラチェーン（internalNetworkOnly → X-Internal-Request:1 → businessHealthHandler）
// を組み立て、loopback/非loopback・ヘッダ有無での挙動を supertest で検証する。
// チェーンが index.ts に実際に配線されていることは wiringInvariants 側で守る。

import express from "express";
import request from "supertest";
import { internalNetworkOnly } from "./api/middleware/internalNetworkOnly";
import { INTERNAL_REQUEST_HEADER } from "./lib/metrics/kpiDefinitions";

// 機微データ取得（DB）を切り離し、ガードの挙動だけを見る。到達 = 200。
jest.mock("./lib/healthBusiness", () => ({
  businessHealthHandler: (_req: express.Request, res: express.Response) =>
    res.status(200).json({ tenants_active_24h: ["secret-tenant"], warnings: [] }),
}));
import { businessHealthHandler } from "./lib/healthBusiness";

/** テスト用に socket.remoteAddress を上書きするミドルウェア（外部IP/ループバックを再現）。 */
function forceRemoteAddress(addr: string): express.RequestHandler {
  return (req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: addr,
      configurable: true,
    });
    next();
  };
}

/** index.ts と同一のガードチェーンで /health/business を組んだ app を返す。 */
function buildApp(remoteAddr: string) {
  const app = express();
  app.get(
    "/health/business",
    forceRemoteAddress(remoteAddr),
    internalNetworkOnly,
    (req, res, next) => {
      if (req.headers[INTERNAL_REQUEST_HEADER] !== "1") {
        return res.status(403).json({ error: "forbidden" });
      }
      return next();
    },
    businessHealthHandler
  );
  return app;
}

describe("GET /health/business — internal-only guard [P0]", () => {
  it("returns 403 for an external (non-loopback) caller even with the internal header set", async () => {
    const app = buildApp("203.0.113.7"); // TEST-NET-3, external
    const res = await request(app)
      .get("/health/business")
      .set(INTERNAL_REQUEST_HEADER, "1");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("returns 403 for an external caller with no header", async () => {
    const app = buildApp("203.0.113.7");
    const res = await request(app).get("/health/business");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a loopback caller that omits the X-Internal-Request header", async () => {
    const app = buildApp("127.0.0.1");
    const res = await request(app).get("/health/business");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("returns 200 for a loopback caller with X-Internal-Request: 1", async () => {
    const app = buildApp("127.0.0.1");
    const res = await request(app)
      .get("/health/business")
      .set(INTERNAL_REQUEST_HEADER, "1");
    expect(res.status).toBe(200);
    expect(res.body.tenants_active_24h).toEqual(["secret-tenant"]);
  });

  it("returns 200 for an IPv4-mapped IPv6 loopback peer (::ffff:127.0.0.1) with the header", async () => {
    const app = buildApp("::ffff:127.0.0.1");
    const res = await request(app)
      .get("/health/business")
      .set(INTERNAL_REQUEST_HEADER, "1");
    expect(res.status).toBe(200);
  });

  it("does not honor X-Forwarded-For to fake a loopback source (socket peer is authoritative)", async () => {
    const app = buildApp("203.0.113.7");
    const res = await request(app)
      .get("/health/business")
      .set(INTERNAL_REQUEST_HEADER, "1")
      .set("X-Forwarded-For", "127.0.0.1");
    expect(res.status).toBe(403);
  });
});
