// src/api/admin/chat-history/chatHistoryRepository.trafficSource.test.ts
// GID 1216970103691946: saveMessage() の chat_sessions.metadata.source 記録の検証

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { saveMessage } from "./chatHistoryRepository";

beforeEach(() => {
  mockQuery.mockReset();
  // 1回目のquery呼び出し(upsert)は結果を使わないので何でもよい
  mockQuery.mockResolvedValueOnce({ rows: [] }); // upsert
  mockQuery.mockResolvedValueOnce({ rows: [{ id: "session-uuid-1" }] }); // SELECT id
  mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT chat_messages
});

describe("saveMessage: chat_sessions.metadata.source", () => {
  it("trafficSource='e2e' 指定時、upsertのmetadataに{source:'e2e'}を渡す", async () => {
    await saveMessage({
      tenantId: "t1",
      sessionId: "s1",
      role: "user",
      content: "hello",
      trafficSource: "e2e",
    });

    const upsertCall = mockQuery.mock.calls[0]!;
    expect(upsertCall[0]).toContain("INSERT INTO chat_sessions");
    expect(upsertCall[0]).toContain("metadata");
    const params = upsertCall[1] as unknown[];
    const metadataParam = params[4] as string;
    expect(JSON.parse(metadataParam)).toEqual({ source: "e2e" });
  });

  it("trafficSource未指定時はデフォルトで{source:'user'}(既存呼び出し元との後方互換)", async () => {
    await saveMessage({
      tenantId: "t1",
      sessionId: "s1",
      role: "user",
      content: "hello",
    });

    const upsertCall = mockQuery.mock.calls[0]!;
    const params = upsertCall[1] as unknown[];
    const metadataParam = params[4] as string;
    expect(JSON.parse(metadataParam)).toEqual({ source: "user" });
  });

  it("ON CONFLICT時、metadataに既にsourceキーがあれば上書きしないSQL(CASE文)になっている", async () => {
    await saveMessage({
      tenantId: "t1",
      sessionId: "s1",
      role: "assistant",
      content: "hi",
      trafficSource: "chat_test",
    });

    const upsertCall = mockQuery.mock.calls[0]!;
    const sql = upsertCall[0] as string;
    // 2回目以降のUPDATEで既存のsourceを保持するCASE文が含まれること
    expect(sql).toMatch(/CASE\s+WHEN chat_sessions\.metadata \? 'source' THEN chat_sessions\.metadata/);
    expect(sql).toContain("ON CONFLICT (tenant_id, session_id) DO UPDATE SET");
  });

  it("trafficSource='demo'を正しく渡す", async () => {
    await saveMessage({
      tenantId: "t1",
      sessionId: "s1",
      role: "user",
      content: "hello",
      trafficSource: "demo",
    });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(JSON.parse(params[4] as string)).toEqual({ source: "demo" });
  });

  it("既存の呼び出し(trafficSource無し・metadata/ragSources等の既存パラメータ)が壊れないこと", async () => {
    await saveMessage({
      tenantId: "t1",
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      metadata: { model: "x" },
      ragSources: [],
      promptVariantId: "v1",
      promptVariantName: "variant-A",
    });

    expect(mockQuery).toHaveBeenCalledTimes(3);
    const upsertParams = mockQuery.mock.calls[0]![1] as unknown[];
    expect(upsertParams[0]).toBe("t1");
    expect(upsertParams[1]).toBe("s1");
    expect(upsertParams[2]).toBe("v1");
    expect(upsertParams[3]).toBe("variant-A");
    expect(JSON.parse(upsertParams[4] as string)).toEqual({ source: "user" });
  });
});
