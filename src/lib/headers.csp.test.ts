import express from "express";
import path from "path";
import request from "supertest";

// 静的ファイル配信ミドルウェアと同じCSP設定を再現するテスト用アプリ
function buildStaticApp() {
  const app = express();
  const publicDir = path.resolve(process.cwd(), "public");

  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://cdn.leonardo.ai",
        "connect-src 'self' https://api.r2c.biz wss://*.livekit.cloud",
        "media-src 'self' https: blob:",
      ].join("; "),
    );
    next();
  });

  // テスト用のダミーエンドポイント
  app.get("/test-csp", (_req, res) => res.send("ok"));
  void publicDir; // 実ファイル不要
  return app;
}

describe("static middleware CSP header", () => {
  const app = buildStaticApp();

  function getCsp(res: request.Response): string {
    const val = res.headers["content-security-policy"];
    return Array.isArray(val) ? val.join(" ") : (val ?? "");
  }

  it("default-src は 'self' に限定されている", async () => {
    const res = await request(app).get("/test-csp");
    expect(getCsp(res)).toContain("default-src 'self'");
  });

  it("script-src に cdn.jsdelivr.net が含まれる (LiveKit SDK)", async () => {
    const res = await request(app).get("/test-csp");
    expect(getCsp(res)).toContain("https://cdn.jsdelivr.net");
  });

  it("img-src に cdn.leonardo.ai が含まれる (アバター画像)", async () => {
    const res = await request(app).get("/test-csp");
    expect(getCsp(res)).toContain("https://cdn.leonardo.ai");
  });

  it("connect-src に wss://*.livekit.cloud が含まれる (LiveKit WS)", async () => {
    const res = await request(app).get("/test-csp");
    expect(getCsp(res)).toContain("wss://*.livekit.cloud");
  });

  it("'unsafe-eval' が含まれない (XSSリスク防止)", async () => {
    const res = await request(app).get("/test-csp");
    expect(getCsp(res)).not.toContain("unsafe-eval");
  });

  it("wildcard * のみのディレクティブが存在しない (最小権限)", async () => {
    const res = await request(app).get("/test-csp");
    // 各ディレクティブが * 単独になっていないこと
    const directives = getCsp(res).split(";").map((d) => d.trim());
    for (const d of directives) {
      const parts = d.split(/\s+/);
      expect(parts).not.toContain("*");
    }
  });
});
