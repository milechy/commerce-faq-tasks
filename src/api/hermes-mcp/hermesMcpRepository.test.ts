// src/api/hermes-mcp/hermesMcpRepository.test.ts
// GID 1216978660043409 (PR-17, R8): セッション単位でグループ化された
// searchConversations の検証。1セッションにつき最大4クエリ
// (候補セッション → メッセージ / 評価 / ページ行動を並列)発行する。

import { searchConversations } from "./hermesMcpRepository";

jest.mock("../../lib/db", () => ({
  getPool: jest.fn(),
}));

import { getPool } from "../../lib/db";
const mockGetPool = getPool as jest.Mock;

function mockQuerySequence(...responses: Array<{ rows: object[] }>) {
  const query = jest.fn();
  responses.forEach((r) => query.mockResolvedValueOnce(r));
  // フォールバック(想定外の追加呼び出しは空配列)
  query.mockResolvedValue({ rows: [] });
  mockGetPool.mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  mockGetPool.mockReset();
});

const BASE_SESSION_ROW = {
  internal_id: "11111111-1111-1111-1111-111111111111",
  session_id: "sess-1",
  visitor_id: null,
  outcome: "purchase",
  is_escalated: false,
  prompt_variant_id: "variant-b",
  prompt_variant_name: "B",
  converted: true,
  first_message_at: "2026-07-01T00:00:00.000Z",
  last_message_at: "2026-07-01T00:05:00.000Z",
};

describe("searchConversations", () => {
  it("候補セッションが0件なら以降のクエリを発行せず空配列を返す", async () => {
    const query = mockQuerySequence({ rows: [] });

    const results = await searchConversations({ tenantId: "carnation" });

    expect(results).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("tenant_idのみ指定: セッション単位でグループ化して返す(会話が途中で切れない)", async () => {
    const query = mockQuerySequence(
      { rows: [BASE_SESSION_ROW] }, // 候補セッション
      {
        rows: [
          {
            internal_id: BASE_SESSION_ROW.internal_id,
            role: "user",
            content: "保証はありますか",
            created_at: "2026-07-01T00:00:00.000Z",
            metadata: { rag_hit_count: 2, rag_top_score: 0.8, knowledge_gap: false },
          },
          {
            internal_id: BASE_SESSION_ROW.internal_id,
            role: "assistant",
            content: "3ヶ月保証です",
            created_at: "2026-07-01T00:05:00.000Z",
            metadata: {},
          },
        ],
      }, // メッセージ
      {
        rows: [
          {
            session_id: "sess-1",
            score: 85,
            evaluation_axes: { psychology_fit: 90 },
            used_principles: ["reciprocity"],
            failed_principles: [],
            notes: "良い対応",
          },
        ],
      }, // 評価
      { rows: [] }, // ページ行動(visitor_id無しのため対象外)
    );

    const results = await searchConversations({ tenantId: "carnation" });

    expect(results).toEqual([
      {
        sessionId: "sess-1",
        outcome: "purchase",
        isEscalated: false,
        promptVariantId: "variant-b",
        promptVariantName: "B",
        converted: true,
        evaluation: {
          score: 85,
          axes: { psychology_fit: 90 },
          usedPrinciples: ["reciprocity"],
          failedPrinciples: [],
          notes: "良い対応",
        },
        messages: [
          {
            role: "user",
            content: "保証はありますか",
            createdAt: "2026-07-01T00:00:00.000Z",
            ragHitCount: 2,
            ragTopScore: 0.8,
            knowledgeGap: false,
          },
          {
            role: "assistant",
            content: "3ヶ月保証です",
            createdAt: "2026-07-01T00:05:00.000Z",
            ragHitCount: null,
            ragTopScore: null,
            knowledgeGap: null,
          },
        ],
        pageContext: [],
      },
    ]);

    const [candidateSql, candidateArgs] = query.mock.calls[0];
    expect(candidateSql).toContain("s.tenant_id = $1");
    expect(candidateArgs).toEqual(["carnation", 50]); // デフォルトlimit=50
  });

  it("PR-3: 学習データ汚染防止のためsource='user'以外のセッションを常に除外する", async () => {
    const query = mockQuerySequence({ rows: [] });
    await searchConversations({ tenantId: "carnation" });

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("s.metadata->>'source' = 'user'");
  });

  it("query指定時: いずれかのメッセージがILIKE一致するセッションをEXISTSで絞り込む", async () => {
    const query = mockQuerySequence({ rows: [] });
    await searchConversations({ tenantId: "carnation", query: "保証" });

    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("m2.content ILIKE");
    expect(args).toContain("%保証%");
  });

  it("minJudgeScore指定時: conversation_evaluations EXISTS条件を追加する", async () => {
    const query = mockQuerySequence({ rows: [] });
    await searchConversations({ tenantId: "carnation", minJudgeScore: 80 });

    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("conversation_evaluations");
    expect(sql).toContain("ce.score >=");
    expect(args).toContain(80);
  });

  it("convertedOnly指定時: conversion_attributions EXISTS条件を追加する", async () => {
    const query = mockQuerySequence({ rows: [] });
    await searchConversations({ tenantId: "carnation", convertedOnly: true });

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("conversion_attributions");
    expect(sql).toContain("ca.session_id = s.id");
  });

  it("limitは200を超えられない", async () => {
    const query = mockQuerySequence({ rows: [] });
    await searchConversations({ tenantId: "carnation", limit: 9999 });

    const [, args] = query.mock.calls[0];
    expect(args[args.length - 1]).toBe(200);
  });

  it("評価が無いセッションは evaluation: null", async () => {
    mockQuerySequence(
      { rows: [{ ...BASE_SESSION_ROW, converted: false }] },
      { rows: [] },
      { rows: [] }, // 評価なし
      { rows: [] },
    );
    const [result] = await searchConversations({ tenantId: "carnation" });
    expect(result!.evaluation).toBeNull();
    expect(result!.converted).toBe(false);
  });

  it("R12: visitor_id有りのセッションはページ行動をセッションの会話時間帯(前後の遡り窓)で結合する", async () => {
    const sessionWithVisitor = { ...BASE_SESSION_ROW, visitor_id: "vis-1" };
    mockQuerySequence(
      { rows: [sessionWithVisitor] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            session_id: "sess-1",
            event_type: "page_view",
            page_url: "https://example.com/products/1?utm_source=x&email=a@b.com",
            referrer: "https://google.com/search?q=secret",
            created_at: "2026-06-30T23:50:00.000Z",
          },
        ],
      },
    );

    const [result] = await searchConversations({ tenantId: "carnation" });

    // Anti-Slop: page_url/referrer からクエリ文字列(会員ID・メール・検索語)を落とす
    expect(result!.pageContext).toEqual([
      {
        eventType: "page_view",
        pageUrl: "https://example.com/products/1",
        referrer: "https://google.com/search",
        createdAt: "2026-06-30T23:50:00.000Z",
      },
    ]);
  });

  it("visitor_id未設定のセッションはページ行動クエリの対象から除外される(4回目のクエリを発行しない)", async () => {
    const query = mockQuerySequence(
      { rows: [BASE_SESSION_ROW] }, // visitor_id: null
      { rows: [] },
      { rows: [] },
    );

    await searchConversations({ tenantId: "carnation" });

    // 候補・メッセージ・評価の3回のみ(ページ行動クエリはvisitor_id無しのため呼ばれない)
    expect(query).toHaveBeenCalledTimes(3);
  });
});
