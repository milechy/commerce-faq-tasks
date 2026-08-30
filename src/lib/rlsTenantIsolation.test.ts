/**
 * rlsTenantIsolation.test.ts — phase76 の RLS ポリシーが「非オーナーロール接続下で」
 * テナント越境を実際に遮断することを、実 Postgres に対して証明する(Gate4 相当)。
 *
 * ★安全装置: 専用の環境変数(RLS_TEST_DATABASE_URL)を使う★
 * billingSqlIntegration.test.ts と同じ方針。DATABASE_URL を流用すると開発者の
 * .env 次第で本番/検証DBを操作しかねないため、専用変数を明示的に設定した時だけ
 * 実行する(＝通常の `pnpm test` では自動スキップ)。
 *
 * ローカルで実行する場合:
 *   createdb rls_test
 *   RLS_TEST_DATABASE_URL=postgresql://localhost/rls_test \
 *     npx jest src/lib/rlsTenantIsolation.test.ts --runInBand
 *
 * このテストが証明すること:
 *   1. 非オーナーロールで withTenant('tenant-A') 内から chat_messages を読むと、
 *      A の行しか見えない(B の行は RLS で不可視)。アプリ層 WHERE を一切書かなくても
 *      DB 側で遮断される = 多層防御。
 *   2. withTenant(null, {superAdmin:true}) は全テナントを横断して見える。
 *   3. GUC 未設定(＝withTenant を通さない後方互換経路)は全行が見える
 *      (既存経路の挙動を壊さない設計の裏取り)。
 *   4. WITH CHECK: 非オーナーが withTenant('tenant-A') 内で他テナント行を
 *      INSERT しようとすると RLS で拒否される。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { withTenant } from "./db";

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

const CHAT_HISTORY_MIGRATION = join(__dirname, "../api/admin/chat-history/migration.sql");
const RLS_MIGRATION = join(__dirname, "../migrations/phase76_rls_tenant_isolation.sql");

// 非オーナーのアプリロール名(テスト用・毎回作り直す)。
const APP_ROLE = "r2c_rls_test_app";

d("phase76 RLS テナント越境遮断（実 Postgres・非オーナーロール）", () => {
  // owner 接続(スキーマ適用・シード・ロール作成用)
  let owner: Pool;
  // 非オーナーのアプリロールで接続するプール(withTenant に渡す)
  let appPool: Pool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL });

    // 1) スキーマ + RLS ポリシーを適用(冪等)
    await owner.query(readFileSync(CHAT_HISTORY_MIGRATION, "utf8"));
    await owner.query(readFileSync(RLS_MIGRATION, "utf8"));

    // 2) 非オーナーのアプリロールを作り直し、必要権限のみ付与
    //    (オーナーにはしない — オーナーは RLS をバイパスするため)。
    await owner.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    // パスワードは接続に使わず SET ROLE 経由で切り替えるため NOLOGIN で十分。
    await owner.query(`CREATE ROLE ${APP_ROLE} NOLOGIN`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON chat_sessions, chat_messages TO ${APP_ROLE}`,
    );
    await owner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    );

    // 3) appPool は接続確立ごとに SET ROLE で非オーナーへ降格する。
    //    これで withTenant() が握るクライアントは RLS の対象になる。
    appPool = new Pool({ connectionString: DB_URL });
    appPool.on("connect", (client) => {
      void client.query(
        `SET ROLE ${APP_ROLE}`,
      );
    });
  });

  afterAll(async () => {
    if (appPool) await appPool.end();
    if (owner) {
      await owner.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => undefined);
      await owner.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined);
      await owner.end();
    }
  });

  beforeEach(async () => {
    // owner 権限で残骸を消してシード(owner は RLS バイパスなので自由に書ける)。
    await owner.query("TRUNCATE chat_messages, chat_sessions RESTART IDENTITY CASCADE");
    // 2 テナント分のセッション + メッセージ
    const a = await owner.query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, session_id) VALUES ('tenant-A', 'sess-a') RETURNING id`,
    );
    const b = await owner.query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, session_id) VALUES ('tenant-B', 'sess-b') RETURNING id`,
    );
    await owner.query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content)
       VALUES ($1, 'tenant-A', 'user', 'A-secret')`,
      [a.rows[0].id],
    );
    await owner.query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content)
       VALUES ($1, 'tenant-B', 'user', 'B-secret')`,
      [b.rows[0].id],
    );
  });

  it("withTenant('tenant-A') 内では chat_messages が A の行しか見えない（WHERE 無しでも遮断）", async () => {
    const rows = await withTenant(
      "tenant-A",
      async (client) => {
        // ★アプリ層の tenant_id 述語を意図的に書かない★ それでも RLS で絞られる。
        const r = await client.query<{ tenant_id: string; content: string }>(
          "SELECT tenant_id, content FROM chat_messages ORDER BY id",
        );
        return r.rows;
      },
      { pool: appPool },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe("tenant-A");
    expect(rows[0].content).toBe("A-secret");
  });

  it("withTenant('tenant-B') 内では B の行しか見えない", async () => {
    const rows = await withTenant(
      "tenant-B",
      async (client) => {
        const r = await client.query<{ content: string }>(
          "SELECT content FROM chat_messages",
        );
        return r.rows;
      },
      { pool: appPool },
    );
    expect(rows.map((x) => x.content)).toEqual(["B-secret"]);
  });

  it("superAdmin=true では全テナントを横断して見える", async () => {
    const rows = await withTenant(
      null,
      async (client) => {
        const r = await client.query<{ content: string }>(
          "SELECT content FROM chat_messages ORDER BY content",
        );
        return r.rows;
      },
      { pool: appPool, superAdmin: true },
    );
    expect(rows.map((x) => x.content)).toEqual(["A-secret", "B-secret"]);
  });

  it("GUC 未設定（withTenant を通さない後方互換経路）では全行が見える", async () => {
    // withTenant を通さず、非オーナー接続で直接読む(既存の getPool().query 経路の等価物)。
    const client = await appPool.connect();
    try {
      const r = await client.query<{ content: string }>(
        "SELECT content FROM chat_messages ORDER BY content",
      );
      expect(r.rows.map((x) => x.content)).toEqual(["A-secret", "B-secret"]);
    } finally {
      client.release();
    }
  });

  it("WITH CHECK: withTenant('tenant-A') 内から他テナント行の INSERT は RLS で拒否される", async () => {
    await expect(
      withTenant(
        "tenant-A",
        async (client) => {
          // tenant-A のセッションに tenant-B のメッセージを差し込もうとする越境書き込み。
          const sess = await client.query<{ id: string }>(
            "SELECT id FROM chat_sessions ORDER BY id LIMIT 1",
          );
          await client.query(
            `INSERT INTO chat_messages (session_id, tenant_id, role, content)
             VALUES ($1, 'tenant-B', 'user', 'B-injected')`,
            [sess.rows[0].id],
          );
        },
        { pool: appPool },
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
