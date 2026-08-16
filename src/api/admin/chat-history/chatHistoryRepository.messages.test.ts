// src/api/admin/chat-history/chatHistoryRepository.messages.test.ts
// getMessages() の「セッション不在(null)」と「本文0件([])」の区別を固定する。
// 区別が無かったため、対応中の会話253件すべてが 404 になり返信できない状態になっていた
// (CLAUDE.md 20: 「存在しない」と「空」を同じ値で表現しない)。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { getMessages } from "./chatHistoryRepository";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getMessages", () => {
  it("セッションが存在し本文が3件あれば created_at ASC で3件返す", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "session-db-id" }] }) // 所有権確認
      .mockResolvedValueOnce({
        rows: [
          { id: "m1", role: "user", content: "こんにちは", metadata: {}, created_at: "2026-08-10T00:00:00Z" },
          { id: "m2", role: "assistant", content: "いらっしゃいませ", metadata: {}, created_at: "2026-08-10T00:00:01Z" },
          { id: "m3", role: "operator", content: "担当します", metadata: {}, created_at: "2026-08-10T00:00:02Z" },
        ],
      });

    const result = await getMessages({ sessionDbId: "session-db-id", tenantId: "carnation" });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result?.[0].id).toBe("m1");
  });

  it("セッションは存在するが本文0件のとき、null ではなく空配列を返す", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "session-db-id" }] }) // 所有権確認: 存在する
      .mockResolvedValueOnce({ rows: [] }); // 本文: 0件

    const result = await getMessages({ sessionDbId: "session-db-id", tenantId: "carnation" });

    expect(result).toEqual([]);
    expect(result).not.toBeNull();
  });

  it("セッションが存在しない場合は null を返す(空配列ではない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // 所有権確認: 該当なし

    const result = await getMessages({ sessionDbId: "not-exist", tenantId: "carnation" });

    expect(result).toBeNull();
    // 本文取得クエリまで進んでいないこと(存在しないのに2本目のSQLを叩かない)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("他テナントのセッションIDを指定した場合も null を返す(200/[]にしない = 越境で実在を漏らさない)", async () => {
    // tenant_id 条件付きの所有権確認クエリが「一致なし」を返すケース
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getMessages({ sessionDbId: "other-tenant-session", tenantId: "carnation" });

    expect(result).toBeNull();
  });

  it("tenantId 未指定(super_admin)でもセッション不在なら null を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getMessages({ sessionDbId: "not-exist" });

    expect(result).toBeNull();
  });

  it("tenantId 未指定(super_admin)で本文0件のセッションは空配列を返す", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "session-db-id" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getMessages({ sessionDbId: "session-db-id" });

    expect(result).toEqual([]);
  });
});
