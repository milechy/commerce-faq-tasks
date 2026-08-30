/**
 * db.withTenant.test.ts — withTenant() が発行するトランザクション/GUC 制御を
 * DB 無しで検証する(通常の `pnpm test` / Gate で常時実行される)。
 *
 * 実際の RLS 絞り込み(非オーナーロール接続下でのテナント越境防御)は Postgres が
 * 要るため rlsTenantIsolation.test.ts(Gate4 相当)で検証する。ここでは
 * 「BEGIN → set_config(is_local) → COMMIT / 例外時 ROLLBACK → release」という
 * 配線そのものが正しいことだけを、モックプールで確定させる。
 */
import { withTenant } from "./db";

interface QueryCall {
  text: string;
  values?: unknown[];
}

function makeMockPool(opts: { failInFn?: boolean } = {}) {
  const queries: QueryCall[] = [];
  let released = 0;
  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(() => {
      released += 1;
    }),
  };
  const pool = {
    connect: jest.fn(async () => client),
  };
  return {
    rawPool: pool,
    client,
    queries,
    getReleased: () => released,
    opts,
  };
}

describe("withTenant()", () => {
  it("テナント指定時: BEGIN → set_config('app.current_tenant', $1, true) → fn → COMMIT → release", async () => {
    const m = makeMockPool();
    const result = await withTenant(
      "tenant-A",
      async (client) => {
        await client.query("SELECT 1 FROM chat_messages");
        return "ok";
      },
      { pool: m.rawPool as never },
    );

    expect(result).toBe("ok");
    const texts = m.queries.map((q) => q.text);
    expect(texts[0]).toBe("BEGIN");
    // set_config はパラメータバインド(SET LOCAL の文字列補間を避ける)
    const setConfig = m.queries.find((q) => q.text.includes("set_config"));
    expect(setConfig?.text).toContain("app.current_tenant");
    expect(setConfig?.text).toContain("$1");
    expect(setConfig?.values).toEqual(["tenant-A"]);
    expect(texts).toContain("SELECT 1 FROM chat_messages");
    expect(texts[texts.length - 1]).toBe("COMMIT");
    expect(m.getReleased()).toBe(1);
    // is_super_admin は立てない
    expect(texts.some((t) => t.includes("is_super_admin"))).toBe(false);
  });

  it("superAdmin=true: app.is_super_admin='on' を立て、app.current_tenant は立てない", async () => {
    const m = makeMockPool();
    await withTenant(null, async () => undefined, { pool: m.rawPool as never, superAdmin: true });
    const texts = m.queries.map((q) => q.text);
    expect(texts.some((t) => t.includes("app.is_super_admin"))).toBe(true);
    expect(texts.some((t) => t.includes("app.current_tenant"))).toBe(false);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[texts.length - 1]).toBe("COMMIT");
  });

  it("tenantId=null かつ superAdmin なし: GUC を一切設定しない(後方互換=全行)", async () => {
    const m = makeMockPool();
    await withTenant(null, async () => undefined, { pool: m.rawPool as never });
    const texts = m.queries.map((q) => q.text);
    expect(texts.some((t) => t.includes("set_config"))).toBe(false);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[texts.length - 1]).toBe("COMMIT");
  });

  it("空文字テナントは未設定と同じ扱い(GUC を立てない)", async () => {
    const m = makeMockPool();
    await withTenant("", async () => undefined, { pool: m.rawPool as never });
    const texts = m.queries.map((q) => q.text);
    expect(texts.some((t) => t.includes("set_config"))).toBe(false);
  });

  it("fn が例外を投げたら ROLLBACK し、例外を再送出し、クライアントを release する", async () => {
    const m = makeMockPool();
    const boom = new Error("boom");
    await expect(
      withTenant(
        "tenant-A",
        async () => {
          throw boom;
        },
        { pool: m.rawPool as never },
      ),
    ).rejects.toBe(boom);
    const texts = m.queries.map((q) => q.text);
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect(m.getReleased()).toBe(1);
  });
});
