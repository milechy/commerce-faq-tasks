// src/api/hermes-mcp/hermesMcpRepositorySqlIntegration.test.ts
//
// searchConversations() の候補セッション取得SQLを実 Postgres に対して検証する。
//
// ★このテストが埋める穴★
// hermesMcpRepository.ts のコメントは次のように警告している:
//   「first/last_message_at はメッセージが1件も無い場合 MIN/MAX が NULL に
//    なるため、chat_sessions自体が持つ started_at/last_message_at にフォール
//    バックする(これが無いと ORDER BY ... DESC で NULL が先頭に来る Postgres
//    の既定挙動により、発話無しセッションが limit を食い潰して直近の実会話を
//    押し出してしまう)」
// しかし既存の hermesMcpRepository.test.ts はDBをモックしているため、この
// 「NULLはDESCで先頭に来る」というPostgresの実挙動そのものはこれまで一度も
// 実行されて検証されたことが無い。モックはどんな順序の行でも指定通りに
// 返してしまうため、この事故はモックテストでは原理的に検出できない。
//
// 実際に手元のPostgres 17.6で確認済み: COALESCEを外すと発話ゼロセッション
// (MAX(m.created_at) IS NULL)がDESC順の先頭に来て、実会話を完全に押し出す。
//
// ★安全装置: 専用の環境変数(HERMES_MCP_SQL_TEST_DATABASE_URL)を使う★
// hermesConsentSqlIntegration.test.ts / billingSqlIntegration.test.ts と同じ
// 理由・同じ変数名(スキーマは SCRIPTS/ci-billing-schema.sh +
// SCRIPTS/ci-hermes-schema.sh で共有する)。
//
// ローカルで実行する場合は hermesConsentSqlIntegration.test.ts のコメント参照。

import { Pool } from "pg";
import { searchConversations } from "./hermesMcpRepository";

const DB_URL = process.env.HERMES_MCP_SQL_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let db: Pool;

jest.mock("../../lib/db", () => ({
  getPool: () => db,
}));

interface SessionSeed {
  sessionId: string;
  startedAt: string;
  lastMessageAt: string;
  messages?: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
}

async function seedSession(tenantId: string, seed: SessionSeed): Promise<void> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO chat_sessions (tenant_id, session_id, started_at, last_message_at, message_count, metadata)
     VALUES ($1, $2, $3, $4, $5, '{"source":"user"}'::jsonb)
     RETURNING id`,
    [tenantId, seed.sessionId, seed.startedAt, seed.lastMessageAt, seed.messages?.length ?? 0],
  );
  const internalId = result.rows[0]!.id;
  for (const m of seed.messages ?? []) {
    await db.query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [internalId, tenantId, m.role, m.content, m.createdAt],
    );
  }
}

d("searchConversations — 発話ゼロセッションのlimit食い潰し(実Postgres)", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE chat_messages, chat_sessions, conversion_attributions, conversation_evaluations RESTART IDENTITY CASCADE");
  });

  it("発話ゼロで離脱した複数セッションが、limitを食い潰して直近の実会話を押し出さない", async () => {
    // 発話ゼロセッション(started_at/last_message_atは古い日付)を3件。
    for (const [i, day] of ["2026-01-01", "2026-01-02", "2026-01-03"].entries()) {
      await seedSession("carnation", {
        sessionId: `zero-${i + 1}`,
        startedAt: day,
        lastMessageAt: day,
      });
    }
    // 直近の実会話(発話ゼロセッションより明確に新しい)を1件。
    await seedSession("carnation", {
      sessionId: "real-conversation",
      startedAt: "2026-08-01T00:00:00Z",
      lastMessageAt: "2026-08-01T00:05:00Z",
      messages: [
        { role: "user", content: "保証はありますか", createdAt: "2026-08-01T00:00:00Z" },
        { role: "assistant", content: "3ヶ月保証です", createdAt: "2026-08-01T00:05:00Z" },
      ],
    });

    // limit=3: 発話ゼロ3件だけで埋まりうる件数。NULLがDESCの先頭に来る
    // Postgresの既定挙動のままだと実会話が完全に押し出されて0件になる。
    const results = await searchConversations({ tenantId: "carnation", limit: 3 });

    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain("real-conversation");
    // 直近の実会話が先頭(最新)であること
    expect(sessionIds[0]).toBe("real-conversation");
    const real = results.find((r) => r.sessionId === "real-conversation")!;
    expect(real.messages).toHaveLength(2);
  });

  it("発話ゼロセッションはmessages: []のまま、実会話と正しく共存する(limitに余裕がある場合)", async () => {
    await seedSession("carnation", { sessionId: "zero-1", startedAt: "2026-01-01", lastMessageAt: "2026-01-01" });
    await seedSession("carnation", {
      sessionId: "real-1",
      startedAt: "2026-08-01T00:00:00Z",
      lastMessageAt: "2026-08-01T00:05:00Z",
      messages: [{ role: "user", content: "hi", createdAt: "2026-08-01T00:00:00Z" }],
    });

    const results = await searchConversations({ tenantId: "carnation", limit: 10 });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.sessionId === "zero-1")!.messages).toEqual([]);
    expect(results.find((r) => r.sessionId === "real-1")!.messages).toHaveLength(1);
  });
});
