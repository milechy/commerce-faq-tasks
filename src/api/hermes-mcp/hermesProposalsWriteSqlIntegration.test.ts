// src/api/hermes-mcp/hermesProposalsWriteSqlIntegration.test.ts
//
// POST /v1/hermes-mcp/proposals の書き込みを実 Postgres に対して検証する。
//
// CLAUDE.md(このディレクトリ)より:
//   「書き込みは E2E で検証できない。e2eWriteGuard が非GETを403にする。
//    結合テストで通すのが唯一の手段。」
// routes.test.ts はDBをモックしてSQL文字列/引数を見ているだけで、実際の
// (tenant_id, dedup_key) の部分一意インデックス(uniq_tuning_rules_tenant_dedup_key)
// がHermesの想定どおりに効くかは一度も実行されていない。ここでは
//   1) POSTした提案がGETで実際に読み戻せること(書いた後に読める)
//   2) 同じdedup_keyでもscope(tenant_id)が異なれば別提案として両方保存される
//      (一意制約が (tenant_id, dedup_key) の複合であること)
//   3) 同一テナント・同一dedup_keyの再投稿は実際のON CONFLICTでduplicate:trueになる
// を実DBで固定する。
//
// ★安全装置★ hermesConsentSqlIntegration.test.ts と同じ専用環境変数を使う。
import { Pool } from "pg";
import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { registerHermesMcpRoutes } from "./routes";

const DB_URL = process.env.HERMES_MCP_SQL_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

const API_KEY = "test-hermes-mcp-write-key";

let db: Pool;

jest.mock("../../lib/db", () => ({
  getPool: () => db,
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  registerHermesMcpRoutes(app);
  return app;
}

function authedGet(path: string) {
  return request(makeApp()).get(path).set("Authorization", `Bearer ${API_KEY}`);
}

function authedPost(path: string, body: object) {
  return request(makeApp()).post(path).set("Authorization", `Bearer ${API_KEY}`).send(body);
}

d("POST /v1/hermes-mcp/proposals — 書き込みの実DB検証", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tuning_rules RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, features) VALUES ('carnation', 'carnation', $1::jsonb)`,
      [JSON.stringify({ learning: { learn: true, share: true } })],
    );
    process.env.HERMES_MCP_API_KEY = API_KEY;
  });

  afterEach(() => {
    delete process.env.HERMES_MCP_API_KEY;
  });

  const TENANT_PROPOSAL = {
    scope: "tenant",
    tenant_id: "carnation",
    title: "保証訴求の改善",
    rationale: "会話ログから保証質問への回答が購入に繋がるパターンを確認",
    suggested_action: "保証訴求を初回応答に含める",
    dedup_key: "tenant:carnation:warranty-pitch",
  };

  it("POSTした提案が直後のGETで実際に読み戻せる(書き込みはE2Eで検証できないため結合テストで確認する)", async () => {
    const postRes = await authedPost("/v1/hermes-mcp/proposals", TENANT_PROPOSAL);
    expect(postRes.status).toBe(201);
    expect(postRes.body.duplicate).toBe(false);

    const getRes = await authedGet("/v1/hermes-mcp/proposals");
    expect(getRes.status).toBe(200);
    expect(getRes.body.proposals).toEqual([
      expect.objectContaining({
        proposal_id: postRes.body.proposal_id,
        tenant_id: "carnation",
        title: "保証訴求の改善",
        status: "pending",
        dedup_key: "tenant:carnation:warranty-pitch",
      }),
    ]);
  });

  it("同一テナント・同一dedup_keyの再投稿は実際のON CONFLICTでduplicate:trueになり、行は増えない", async () => {
    const first = await authedPost("/v1/hermes-mcp/proposals", TENANT_PROPOSAL);
    expect(first.status).toBe(201);

    const second = await authedPost("/v1/hermes-mcp/proposals", TENANT_PROPOSAL);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true });

    const count = await db.query("SELECT COUNT(*)::int AS n FROM tuning_rules");
    expect(count.rows[0]!.n).toBe(1);
  });

  it("同じdedup_keyでもscope(tenant_id)が異なれば一意制約に衝突せず両方保存される", async () => {
    const sharedDedupKey = "shared-insight-slug";

    const tenantRes = await authedPost("/v1/hermes-mcp/proposals", {
      ...TENANT_PROPOSAL,
      dedup_key: sharedDedupKey,
    });
    expect(tenantRes.status).toBe(201);
    expect(tenantRes.body.duplicate).toBe(false);

    const globalRes = await authedPost("/v1/hermes-mcp/proposals", {
      scope: "global",
      title: "心理原則scarcityの全体採用を検討",
      rationale: "複数の同意済みテナントで共通するパターンを確認",
      suggested_action: "デフォルト戦略に追加検討",
      dedup_key: sharedDedupKey,
    });
    expect(globalRes.status).toBe(201);
    expect(globalRes.body.duplicate).toBe(false);

    const rows = await db.query(
      "SELECT tenant_id, dedup_key FROM tuning_rules WHERE dedup_key = $1 ORDER BY tenant_id",
      [sharedDedupKey],
    );
    expect(rows.rows).toEqual([
      { tenant_id: "carnation", dedup_key: sharedDedupKey },
      { tenant_id: "global", dedup_key: sharedDedupKey },
    ]);
  });
});
