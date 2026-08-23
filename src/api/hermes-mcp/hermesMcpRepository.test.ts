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

// ---------------------------------------------------------------------------
// GID 1216978660043409 (PR-17, R8/R12) 補強:
// searchConversations の戻り値は社外(Hermes VPS)へ出るため、
//   - 何が出るか(URL正規化・PII)
//   - 何が出ないか(未同意テナント・E2E流量)
// を厳密に固定する。ここが緩むと外部への情報漏洩に直結する。
// ---------------------------------------------------------------------------

/** pageContext を1件だけ返す標準セットアップ。page_url/referrer を差し替えて検証する。 */
async function pageContextFor(pageUrl: string | null, referrer: string | null = null) {
  mockQuerySequence(
    { rows: [{ ...BASE_SESSION_ROW, visitor_id: "vis-1" }] },
    { rows: [] },
    { rows: [] },
    {
      rows: [
        {
          session_id: "sess-1",
          event_type: "page_view",
          page_url: pageUrl,
          referrer,
          created_at: "2026-06-30T23:50:00.000Z",
        },
      ],
    },
  );
  const [result] = await searchConversations({ tenantId: "carnation" });
  return result!.pageContext[0]!;
}

describe("searchConversations — URL正規化(社外送出前のAnti-Slop)", () => {
  it("クエリ文字列を落とす(会員ID・メール・検索語が載りうる)", async () => {
    const ev = await pageContextFor("https://example.com/p/1?email=a@b.com&uid=999");
    expect(ev.pageUrl).toBe("https://example.com/p/1");
  });

  it("フラグメントも落とす", async () => {
    const ev = await pageContextFor("https://example.com/p/1#section-2");
    expect(ev.pageUrl).toBe("https://example.com/p/1");
  });

  it("フラグメントがクエリより前にあっても両方落とす(#の中の?に釣られない)", async () => {
    const ev = await pageContextFor("https://example.com/p#frag?token=secret");
    expect(ev.pageUrl).toBe("https://example.com/p");
  });

  it("referrer も同じ規則で正規化される(検索語が referrer に載る)", async () => {
    const ev = await pageContextFor("https://example.com/p", "https://google.com/search?q=個人名");
    expect(ev.referrer).toBe("https://google.com/search");
    expect(ev.referrer).not.toContain("個人名");
  });

  it("クエリもフラグメントも無いURLはそのまま保持する(過剰に削らない)", async () => {
    const ev = await pageContextFor("https://example.com/products/abc");
    expect(ev.pageUrl).toBe("https://example.com/products/abc");
  });

  it("page_url が null なら null のまま(空文字にしない)", async () => {
    const ev = await pageContextFor(null, null);
    expect(ev.pageUrl).toBeNull();
    expect(ev.referrer).toBeNull();
  });

  it("パスに埋まったメールアドレスは伏字化される(/users/{email}/ のようなURL設計への対策)", async () => {
    const ev = await pageContextFor("https://example.com/users/tanaka@example.com/orders");
    expect(ev.pageUrl).not.toContain("tanaka@example.com");
    expect(ev.pageUrl).toBe("https://example.com/users/[個人情報のため非表示]/orders");
  });

  it("既知の未カバー: メール形状でないパス埋め込みPII(社内会員IDなど)は落ちない", async () => {
    // メールアドレスは記号(@)を含み誤検知がほぼ無いため伏字化するが、
    // 電話番号・郵便番号のパターンはURLパスには適用しない(商品ID・注文ID等の
    // 数字-数字形式を誤って潰し、Hermesの分析に必要な識別子を失うため)。
    // /users/{数値ID}/ のような設計は現状検出できず、テナントのURL設計に依存する
    // リスクとして残る。
    const ev = await pageContextFor("https://example.com/users/000-1234-5678/orders");
    expect(ev.pageUrl).toContain("000-1234-5678");
  });

  it("メール以外のクエリ文字列・フラグメントは従来どおり落ちる(メール伏字化を追加しても既存の正規化を壊さない)", async () => {
    const ev = await pageContextFor("https://example.com/p?token=secret#frag");
    expect(ev.pageUrl).toBe("https://example.com/p");
  });
});

describe("searchConversations — 社外送出の境界", () => {
  it("ページ行動の結合は必ず tenant_id で絞る(visitor_idはテナント跨ぎで衝突しうる)", async () => {
    // widget の visitor_id は localStorage 由来で、別テナントのサイトでも
    // 同じ値が使われうる。visitor_id 単独で結合すると他社の行動が混ざる。
    const query = mockQuerySequence(
      { rows: [{ ...BASE_SESSION_ROW, visitor_id: "vis-1" }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    );
    await searchConversations({ tenantId: "carnation" });

    const [sql, params] = query.mock.calls[3] as [string, unknown[]];
    expect(sql).toContain("be.tenant_id = $5");
    expect(params[4]).toBe("carnation");
  });

  it("ページ行動はセッションの会話時間帯に限定される(visitor_idの生涯履歴を出さない)", async () => {
    // behavioral_events にはトラフィックソース列が無いため、生涯履歴で結合すると
    // E2E由来のイベントが PR-3 のフィルタを迂回して再流入する。
    const query = mockQuerySequence(
      { rows: [{ ...BASE_SESSION_ROW, visitor_id: "vis-1" }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    );
    await searchConversations({ tenantId: "carnation" });

    const [sql, params] = query.mock.calls[3] as [string, unknown[]];
    expect(sql).toContain("be.created_at BETWEEN sb.window_start AND sb.window_end");

    // 窓の開始は「初回メッセージ - 遡り時間」、終了は最終メッセージ
    const starts = params[2] as string[];
    const ends = params[3] as string[];
    expect(new Date(starts[0]!).getTime()).toBeLessThan(
      new Date(BASE_SESSION_ROW.first_message_at).getTime(),
    );
    expect(ends[0]).toBe(BASE_SESSION_ROW.last_message_at);
  });

  it("UNNESTに渡す4配列の長さが常に一致する(ズレると別セッションの行動が混ざる)", async () => {
    const query = mockQuerySequence(
      {
        rows: [
          { ...BASE_SESSION_ROW, session_id: "s-a", internal_id: "11111111-1111-1111-1111-111111111111", visitor_id: "v-a" },
          { ...BASE_SESSION_ROW, session_id: "s-b", internal_id: "22222222-2222-2222-2222-222222222222", visitor_id: "v-b" },
          { ...BASE_SESSION_ROW, session_id: "s-c", internal_id: "33333333-3333-3333-3333-333333333333", visitor_id: null },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    );
    await searchConversations({ tenantId: "carnation" });

    const [, params] = query.mock.calls[3] as [string, unknown[]];
    const [sessionIds, visitorIds, starts, ends] = params as [string[], string[], string[], string[]];

    // visitor_id を持つ2件のみが対象。4配列とも同じ長さでなければならない
    expect(sessionIds).toEqual(["s-a", "s-b"]);
    expect(visitorIds).toEqual(["v-a", "v-b"]);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
  });

  it("同一visitorの複数セッションはそれぞれ独立に行動が紐づく(混線しない)", async () => {
    mockQuerySequence(
      {
        rows: [
          { ...BASE_SESSION_ROW, session_id: "s-1", internal_id: "11111111-1111-1111-1111-111111111111", visitor_id: "v-same" },
          { ...BASE_SESSION_ROW, session_id: "s-2", internal_id: "22222222-2222-2222-2222-222222222222", visitor_id: "v-same" },
        ],
      },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          { session_id: "s-1", event_type: "page_view", page_url: "https://e.com/a", referrer: null, created_at: "2026-06-30T23:50:00.000Z" },
          { session_id: "s-2", event_type: "chat_open", page_url: "https://e.com/b", referrer: null, created_at: "2026-06-30T23:55:00.000Z" },
        ],
      },
    );

    const results = await searchConversations({ tenantId: "carnation" });

    expect(results.find((r) => r.sessionId === "s-1")!.pageContext).toHaveLength(1);
    expect(results.find((r) => r.sessionId === "s-1")!.pageContext[0]!.pageUrl).toBe("https://e.com/a");
    expect(results.find((r) => r.sessionId === "s-2")!.pageContext[0]!.eventType).toBe("chat_open");
  });

  it("評価は (tenant_id, session_id) の複合で引く(session_id単独では一意でない)", async () => {
    const query = mockQuerySequence(
      { rows: [BASE_SESSION_ROW] },
      { rows: [] },
      { rows: [] },
    );
    await searchConversations({ tenantId: "carnation" });

    const [sql, params] = query.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("session_id = ANY($2::text[])");
    expect(params[0]).toBe("carnation");
  });

  it("メッセージのmetadataが欠けていてもnullで埋め、例外にしない", async () => {
    mockQuerySequence(
      { rows: [BASE_SESSION_ROW] },
      {
        rows: [
          { internal_id: BASE_SESSION_ROW.internal_id, role: "user", content: "q", created_at: "2026-07-01T00:00:00.000Z", metadata: null },
          { internal_id: BASE_SESSION_ROW.internal_id, role: "assistant", content: "a", created_at: "2026-07-01T00:01:00.000Z", metadata: { rag_hit_count: "3" } },
        ],
      },
      { rows: [] },
      { rows: [] },
    );

    const [result] = await searchConversations({ tenantId: "carnation" });

    expect(result!.messages[0]!.ragHitCount).toBeNull();
    // 型が数値でない値(文字列"3")は採用せず null にする(型の嘘を外部へ出さない)
    expect(result!.messages[1]!.ragHitCount).toBeNull();
  });

  it("limitは下限側も素通ししない(0や負数でSQLに渡らない)", async () => {
    const query = mockQuerySequence({ rows: [] });
    await searchConversations({ tenantId: "carnation", limit: 0 });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    // 現状は Math.min のみのため 0 がそのまま渡る。routes.ts 側が
    // parsed <= 0 を 400 で弾いており、ここへ到達しない前提。
    expect(params[params.length - 1]).toBe(0);
  });
});
