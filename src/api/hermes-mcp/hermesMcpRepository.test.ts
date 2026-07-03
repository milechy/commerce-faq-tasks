// src/api/hermes-mcp/hermesMcpRepository.test.ts

import { searchConversations } from "./hermesMcpRepository";

jest.mock("../../lib/db", () => ({
  getPool: jest.fn(),
}));

import { getPool } from "../../lib/db";
const mockGetPool = getPool as jest.Mock;

function mockQuery(rows: object[]) {
  const query = jest.fn().mockResolvedValue({ rows });
  mockGetPool.mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  mockGetPool.mockReset();
});

describe("searchConversations", () => {
  it("tenant_idのみ指定: 全条件無しでSELECTし結果を返す", async () => {
    const query = mockQuery([
      {
        session_id: "sess-1",
        role: "user",
        content: "保証はありますか",
        created_at: "2026-07-01T00:00:00.000Z",
        judge_score: 85,
        converted: true,
      },
    ]);

    const results = await searchConversations({ tenantId: "carnation" });

    expect(results).toEqual([
      {
        sessionId: "sess-1",
        role: "user",
        content: "保証はありますか",
        createdAt: "2026-07-01T00:00:00.000Z",
        judgeScore: 85,
        converted: true,
      },
    ]);
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("s.tenant_id = $1");
    expect(args).toEqual(["carnation", 50]); // デフォルトlimit=50
  });

  it("query指定時: ILIKE条件を追加する", async () => {
    const query = mockQuery([]);
    await searchConversations({ tenantId: "carnation", query: "保証" });

    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("m.content ILIKE");
    expect(args).toContain("%保証%");
  });

  it("minJudgeScore指定時: conversation_evaluations EXISTS条件を追加する", async () => {
    const query = mockQuery([]);
    await searchConversations({ tenantId: "carnation", minJudgeScore: 80 });

    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("conversation_evaluations");
    expect(sql).toContain("ce.score >=");
    expect(args).toContain(80);
  });

  it("convertedOnly指定時: conversion_attributions EXISTS条件を追加する", async () => {
    const query = mockQuery([]);
    await searchConversations({ tenantId: "carnation", convertedOnly: true });

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("conversion_attributions");
    expect(sql).toContain("ca.session_id = s.id");
  });

  it("limitは200を超えられない", async () => {
    const query = mockQuery([]);
    await searchConversations({ tenantId: "carnation", limit: 9999 });

    const [, args] = query.mock.calls[0];
    expect(args[args.length - 1]).toBe(200);
  });

  it("judge_scoreがnullの場合はjudgeScore: null", async () => {
    mockQuery([
      {
        session_id: "sess-2",
        role: "assistant",
        content: "はい、3ヶ月保証です",
        created_at: "2026-07-01T00:00:00.000Z",
        judge_score: null,
        converted: false,
      },
    ]);
    const [result] = await searchConversations({ tenantId: "carnation" });
    expect(result!.judgeScore).toBeNull();
    expect(result!.converted).toBe(false);
  });
});
