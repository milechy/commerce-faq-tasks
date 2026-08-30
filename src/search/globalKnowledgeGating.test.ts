// src/search/globalKnowledgeGating.test.ts
// P1: 実回答経路(pgvectorSearch)の生成 SQL が、テナント別オプトインで
// global / r2c_docs の tenant スコープを増減させることを検証する。
// 本番 SQL は Postgres 側で評価されるため、pool.query に渡る SQL 文字列を捕捉して確認する。

const ENV_KEYS = [
  "GLOBAL_KNOWLEDGE_ENFORCE_OPTIN",
  "GLOBAL_KNOWLEDGE_TENANTS",
  "R2C_DOCS_ENFORCE_OPTIN",
  "R2C_DOCS_TENANTS",
  "DATABASE_URL",
] as const;

describe("pgvectorSearch: global/r2c_docs のオプトイン SQL 分岐", () => {
  const saved: Record<string, string | undefined> = {};
  let capturedSql: string | null = null;

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    capturedSql = null;
    jest.resetModules();
    jest.doMock("../lib/db", () => ({
      pool: {
        query: jest.fn((sql: string) => {
          capturedSql = sql;
          return Promise.resolve({ rows: [] });
        }),
      },
    }));
  });

  afterEach(() => {
    jest.dontMock("../lib/db");
  });

  async function runSearch(tenantId: string): Promise<string> {
    const { searchPgVector } = await import("./pgvectorSearch");
    await searchPgVector({ tenantId, embedding: [0.1, 0.2] });
    expect(capturedSql).not.toBeNull();
    return capturedSql!;
  }

  it("既定(env 未設定): global と r2c_docs を両方含む(後方互換)", async () => {
    const sql = await runSearch("tenantA");
    expect(sql).toContain("fe.tenant_id = 'global'");
    expect(sql).toContain("fe.tenant_id = 'r2c_docs'");
  });

  it("opt-in 有効・allowlist 外: global も r2c_docs も SQL から消える", async () => {
    process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
    process.env.GLOBAL_KNOWLEDGE_TENANTS = "accept";
    process.env.R2C_DOCS_ENFORCE_OPTIN = "true";
    process.env.R2C_DOCS_TENANTS = "";
    const sql = await runSearch("publicTenant");
    expect(sql).not.toContain("'global'");
    expect(sql).not.toContain("'r2c_docs'");
    expect(sql).toContain("fe.tenant_id = $2"); // 自テナントのみ残る
  });

  it("opt-in 有効・global のみ許可テナント: global は残り r2c_docs は消える", async () => {
    process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
    process.env.GLOBAL_KNOWLEDGE_TENANTS = "accept";
    process.env.R2C_DOCS_ENFORCE_OPTIN = "true";
    process.env.R2C_DOCS_TENANTS = "";
    const sql = await runSearch("accept");
    expect(sql).toContain("fe.tenant_id = 'global'");
    expect(sql).not.toContain("'r2c_docs'");
  });

  it("global のみ enforce(r2c_docs 未 enforce): r2c_docs は既定で残る", async () => {
    process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
    process.env.GLOBAL_KNOWLEDGE_TENANTS = ""; // global は誰も引けない
    const sql = await runSearch("tenantA");
    expect(sql).not.toContain("'global'");
    expect(sql).toContain("fe.tenant_id = 'r2c_docs'"); // 未 enforce のため従来どおり
  });
});
