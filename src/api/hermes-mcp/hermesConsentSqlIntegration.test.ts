// src/api/hermes-mcp/hermesConsentSqlIntegration.test.ts
//
// GET /v1/hermes-mcp/proposals の越境防止を「実際の Postgres」に対して検証する。
//
// ★このテストが埋める穴★
// 既存の routes.test.ts はDBをモックし、SQL文字列に
// "tr.tenant_id = 'global'" が含まれるか・shareConsentSqlPredicate()経由かを
// 文字列一致でしか見ていなかった。この検証は二重に弱い:
//   - 述語を間違った別名に適用しても、AND/ORの優先順位を間違えても文字列は
//     一致するので通ってしまう
//   - 逆に、意味は正しいままWHEREを書き換えただけで落ちる(壊れやすいだけ)
// ここでは実データを実 Postgres に投入し、「未同意テナントの提案は一切
// 返らない」ことをレスポンス本体で証明する。
//
// ★安全装置: 専用の環境変数(HERMES_MCP_SQL_TEST_DATABASE_URL)を使う★
// billingSqlIntegration.test.ts と同じ理由(DATABASE_URLを流用すると開発者の
// .envが本番/検証DBを指していた場合にそこへ接続しかねない)。
//
// ★モックの範囲について★
// getPool() だけを実DBのPoolに差し替える。isHermesDataConsentGranted /
// shareConsentSqlPredicate は本物(hermesConsent.ts)を使う ― ここを
// モックすると「越境防止ロジックが正しいか」ではなく「モックした通りに
// 動くか」を検証するだけになり、このテストの目的そのものが失われる。
//
// ローカルで実行する場合:
//   createdb hermes_sql_test
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/hermes_sql_test \
//     bash SCRIPTS/ci-billing-schema.sh (DATABASE_URL に読み替えて実行)
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/hermes_sql_test \
//     bash SCRIPTS/ci-hermes-schema.sh (同上)
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/hermes_sql_test \
//     npx jest src/api/hermes-mcp/hermesConsentSqlIntegration.test.ts

import { Pool } from "pg";
import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { CASES } from "../../lib/shareConsentDrift.fixtures";

const DB_URL = process.env.HERMES_MCP_SQL_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

const API_KEY = "test-hermes-mcp-sql-key";

let db: Pool;

// getPool() だけを実DBに差し替える。他の依存(hermesConsent, notifications,
// ruleEffect)はすべて本物を使う。jest.mock はモジュールトップレベルで
// ホイストされるため、db への参照は import 文より前でも問題ない
// (実際に getPool() が呼ばれるのは beforeAll で db を初期化した後)。
jest.mock("../../lib/db", () => ({
  getPool: () => db,
}));

import { registerHermesMcpRoutes } from "./routes";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerHermesMcpRoutes(app);
  return app;
}

function authedGet(path: string) {
  return request(makeApp()).get(path).set("Authorization", `Bearer ${API_KEY}`);
}

interface TenantRow {
  id: string;
  features?: unknown;
}

async function insertTenant(row: TenantRow): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, name, features) VALUES ($1, $1, $2::jsonb)`,
    [row.id, JSON.stringify(row.features ?? {})],
  );
}

let nextRuleId = 1;
async function insertProposal(opts: {
  tenantId: string; // 'global' も可
  status?: "pending" | "active" | "rejected";
  createdAt?: string;
  title?: string;
}): Promise<void> {
  const id = nextRuleId++;
  await db.query(
    `INSERT INTO tuning_rules
       (tenant_id, trigger_pattern, expected_behavior, priority, is_active,
        source, status, evidence, dedup_key, created_at)
     VALUES ($1, $2, 'do something', 0, false, 'hermes', $3, '{}'::jsonb, $4, $5)`,
    [
      opts.tenantId,
      opts.title ?? `proposal-${id}`,
      opts.status ?? "pending",
      `dedup-${id}`,
      opts.createdAt ?? new Date().toISOString(),
    ],
  );
}

d("GET /v1/hermes-mcp/proposals — 越境防止(実Postgres)", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tuning_rules RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    process.env.HERMES_MCP_API_KEY = API_KEY;
    nextRuleId = 1;
  });

  afterEach(() => {
    delete process.env.HERMES_MCP_API_KEY;
  });

  it("scope='tenant' の提案は同意済み(share=true)テナントのものだけ返る", async () => {
    await insertTenant({ id: "consented-co", features: { learning: { learn: true, share: true } } });
    await insertTenant({ id: "unconsented-co", features: { learning: { learn: true, share: false } } });
    await insertProposal({ tenantId: "consented-co", title: "consented-proposal" });
    await insertProposal({ tenantId: "unconsented-co", title: "unconsented-proposal" });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0].tenant_id).toBe("consented-co");
    expect(res.body.proposals[0].title).toBe("consented-proposal");
  });

  it("未同意テナントの提案は「存在確認すら与えない」— レスポンスのどこにも痕跡が無い", async () => {
    await insertTenant({ id: "unconsented-co", features: { learning: { learn: true, share: false } } });
    await insertProposal({ tenantId: "unconsented-co", title: "should-never-leak" });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("unconsented-co");
    expect(JSON.stringify(res.body)).not.toContain("should-never-leak");
  });

  it("scope='global'(tenant_id='global')の提案は、同意済みテナントが1件も無くても返る", async () => {
    await insertTenant({ id: "unconsented-co", features: { learning: { learn: true, share: false } } });
    await insertProposal({ tenantId: "global", title: "global-insight" });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0]).toMatchObject({ scope: "global", title: "global-insight" });
  });

  it("created_at DESC の順序が実際のレスポンスで守られる(scope混在)", async () => {
    await insertTenant({ id: "co", features: { learning: { learn: true, share: true } } });
    await insertProposal({ tenantId: "co", title: "oldest", createdAt: "2026-01-01T00:00:00Z" });
    await insertProposal({ tenantId: "global", title: "middle", createdAt: "2026-01-02T00:00:00Z" });
    await insertProposal({ tenantId: "co", title: "newest", createdAt: "2026-01-03T00:00:00Z" });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.body.proposals.map((p: { title: string }) => p.title)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("limitは同意フィルタ適用後の件数に効く(未同意の新しい行がlimitを食い潰さない)", async () => {
    // 未同意テナントの行の方が同意済みテナントの行より新しい(created_at降順で
    // 先に来る)。もしWHEREでの絞り込みより先にLIMITだけ効くような実装バグが
    // あれば、未同意の行にlimitを食い潰され結果が0件になる。
    await insertTenant({ id: "consented-co", features: { learning: { learn: true, share: true } } });
    await insertTenant({ id: "unconsented-co", features: { learning: { learn: true, share: false } } });
    await insertProposal({ tenantId: "consented-co", title: "the-only-consented", createdAt: "2026-01-01T00:00:00Z" });
    await insertProposal({ tenantId: "unconsented-co", title: "newer-1", createdAt: "2026-01-02T00:00:00Z" });
    await insertProposal({ tenantId: "unconsented-co", title: "newer-2", createdAt: "2026-01-03T00:00:00Z" });
    await insertProposal({ tenantId: "unconsented-co", title: "newer-3", createdAt: "2026-01-04T00:00:00Z" });

    const res = await authedGet("/v1/hermes-mcp/proposals?limit=1");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0].title).toBe("the-only-consented");
  });

  // shareConsentDrift.test.ts のケース表(JS側 resolveLearningConsentFromFeatures
  // が本物のPostgres上でも同じ判定になることを示す。同ファイルのコメントは
  // 「jest実行環境にPostgresは無いため、SQL側は本番実測結果の書き写しと
  // 正規表現照合の二段構え」と明言しており、ここがその「実測」をCI上で
  // 再現可能にする。
  describe.each(CASES)("ケース表: $label ($note)", ({ label, features, expectedShare }) => {
    it(`features=${JSON.stringify(features)} → share=${expectedShare} が実Postgresの提案取得結果と一致する`, async () => {
      const tenantId = `case-${label.toLowerCase()}`;
      await insertTenant({ id: tenantId, features });
      await insertProposal({ tenantId, title: `proposal-for-${tenantId}` });

      const res = await authedGet("/v1/hermes-mcp/proposals");

      expect(res.status).toBe(200);
      const titles = res.body.proposals.map((p: { title: string }) => p.title);
      if (expectedShare) {
        expect(titles).toContain(`proposal-for-${tenantId}`);
      } else {
        expect(titles).not.toContain(`proposal-for-${tenantId}`);
      }
    });
  });
});
