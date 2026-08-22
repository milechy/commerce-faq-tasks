// src/middleware/topicGuard.test.ts
// L6 Topic Guard: production 既定ON / development・test 既定OFF の確認

import { checkTopic } from "./topicGuard";

describe("checkTopic: enabled-flag default", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("production かつフラグ未設定なら既定ONで話題外の質問をブロックする", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.TOPIC_GUARD_ENABLED;

    const result = await checkTopic("次の選挙で誰に投票すべき?", "tenant-a", "sess-prod-default-topic");
    expect(result.allowed).toBe(false);
    expect(result.category).toBe("off_topic");
  });

  it("production かつ TOPIC_GUARD_ENABLED=false なら明示的にOFFにできる", async () => {
    process.env.NODE_ENV = "production";
    process.env.TOPIC_GUARD_ENABLED = "false";

    const result = await checkTopic("次の選挙で誰に投票すべき?", "tenant-a", "sess-prod-off-topic");
    expect(result.allowed).toBe(true);
  });

  it("development かつフラグ未設定なら既定OFF（従来動作を維持）", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.TOPIC_GUARD_ENABLED;

    const result = await checkTopic("次の選挙で誰に投票すべき?", "tenant-a", "sess-dev-default-topic");
    expect(result.allowed).toBe(true);
  });
});
