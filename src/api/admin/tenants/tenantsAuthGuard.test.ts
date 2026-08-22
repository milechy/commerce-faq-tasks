// src/api/admin/tenants/tenantsAuthGuard.test.ts
// D1c 統合漏れの回帰テスト。
//
// registerTenantAdminRoutes は長らく独自のインライン tenantAuth を持っており、
// SUPABASE_JWT_SECRET 未設定時に production でも無条件 next() する fail-open だった
// （共有 supabaseAuthMiddleware は production で 503）。守っている面がテナントCRUD・
// APIキー発行/失効・招待という最高権限面だったため、他ルータより弱い認証で
// 守られている状態が残っていた。
//
// 他のテストファイル（routes.test.ts 等）は supabaseAuthMiddleware をモックして
// 業務ロジックを検証するため、この経路は素通りする。ここでは**モックせず実物を通し**、
// 認証層そのものの挙動を固定する。
//
// 意図的にモックしないもの: src/admin/http/supabaseAuthMiddleware
jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

jest.mock("../../../lib/tenant-context", () => ({
  registerTenant: jest.fn(),
  updateTenantEnabled: jest.fn(),
}));

jest.mock("../../../agent/openclaw/workspaceCache", () => ({
  invalidateWorkspaceCache: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "./routes";

/** DBに到達したら失敗と分かるよう、呼ばれたら記録する Pool スタブ */
function makeSpyDb() {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return { query } as any;
}

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  registerTenantAdminRoutes(app, db);
  return app;
}

describe("tenants ルータの認証層（共有 supabaseAuthMiddleware に一本化されていること）", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("production かつ SUPABASE_JWT_SECRET 未設定なら 503 で止まり、DBに到達しない（旧インライン実装は無条件 next() だった）", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SUPABASE_JWT_SECRET;
    const db = makeSpyDb();

    const res = await request(makeApp(db))
      .get("/v1/admin/tenants")
      .set("Authorization", "Bearer whatever");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "auth_not_configured" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("production かつ secret 設定済みなら、不正な署名のトークンは 401 で止まりDBに到達しない", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_JWT_SECRET = "correct-secret";
    const db = makeSpyDb();

    const res = await request(makeApp(db))
      .get("/v1/admin/tenants")
      .set("Authorization", "Bearer not-a-real-jwt");

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("最高権限面（APIキー発行）も同じ認証層で守られている", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SUPABASE_JWT_SECRET;
    const db = makeSpyDb();

    const res = await request(makeApp(db))
      .post("/v1/admin/tenants/tenant-a/keys")
      .set("Authorization", "Bearer whatever");

    expect(res.status).toBe(503);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("このファイルは jwt.verify / jwt.decode を自前で持たない（インライン認証コピーの再発防止）", () => {
    // 構造不変条件。既存の confirmPolicy.test.ts / index.wiringInvariants.test.ts と同じ手法。
    // throw は it() の内側に置き、リネーム時にスイート全体が読み込み例外で死なないようにする。
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const source = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");

    expect(source).not.toMatch(/jwt\.verify\(/);
    expect(source).not.toMatch(/jwt\.decode\(/);
    expect(source).toMatch(/supabaseAuthMiddleware/);
  });
});
