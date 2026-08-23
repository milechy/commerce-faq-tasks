// src/api/admin/chat-history/chatHistoryRepository.sessions.test.ts
// GID 1216970103691946 (PR-3): getSessions が管理画面でe2e/実ユーザーを見分けられるよう
// SELECT に metadata.source を含めて返すことの検証。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { getSessions } from "./chatHistoryRepository";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getSessions: source列", () => {
  it("SELECT文にs.metadata->>'source' AS sourceを含む", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] }); // list

    await getSessions({ tenantId: "carnation" });

    const [listSql] = mockQuery.mock.calls[1]!;
    expect(listSql).toContain("s.metadata->>'source' AS source");
  });

  it("結果行のsourceフィールドをそのまま返す(呼び出し元でe2e/user等を判定できる)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "uuid-1",
            tenant_id: "carnation",
            session_id: "s1",
            started_at: "2026-08-01T00:00:00.000Z",
            last_message_at: "2026-08-01T00:01:00.000Z",
            message_count: 2,
            outcome: null,
            outcome_recorded_at: null,
            source: "e2e",
            first_message_preview: "こんにちは",
          },
        ],
      });

    const result = await getSessions({ tenantId: "carnation" });

    expect(result.sessions[0]!.source).toBe("e2e");
  });
});
