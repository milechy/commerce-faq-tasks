// src/api/admin/chat-history/chatHistoryRepository.escalation.test.ts
// R0-②: escalateSession の単体テスト。escalation-widget-routes.test.ts は
// jest.mock でモジュールごと差し替えているため、実際のSQL(特に
// 「行が無ければ作らない」という空セッション防止のふるまい)は
// これまで一切実行されていなかった。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { escalateSession } from "./chatHistoryRepository";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("escalateSession", () => {
  it("対象セッションが存在しない場合、INSERTせずnullを返す(空セッション防止)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT: 該当なし

    const result = await escalateSession({ tenantId: "t1", sessionId: "no-such-session" });

    expect(result).toBeNull();
    // SELECT の1回だけで終わり、UPDATE(2回目のquery)は発行されない
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).not.toContain("INSERT INTO chat_sessions");
  });

  it("既存セッションが未エスカレーション状態なら、is_escalated=trueに更新しalreadyEscalated=falseを返す", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "db-id-1", is_escalated: false }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const result = await escalateSession({ tenantId: "t1", sessionId: "s1" });

    expect(result).toEqual({ dbSessionId: "db-id-1", alreadyEscalated: false });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [updateSql] = mockQuery.mock.calls[1]!;
    expect(updateSql).toContain("SET is_escalated = true");
  });

  it("既にエスカレーション済みの場合、alreadyEscalated=trueを返しescalated_atを上書きしない(冪等)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "db-id-1", is_escalated: true }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await escalateSession({ tenantId: "t1", sessionId: "s1" });

    expect(result).toEqual({ dbSessionId: "db-id-1", alreadyEscalated: true });
    const [updateSql] = mockQuery.mock.calls[1]!;
    expect(updateSql).toContain("escalated_at = COALESCE(escalated_at, NOW())");
  });
});
