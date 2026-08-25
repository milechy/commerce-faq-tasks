// src/api/admin/analytics/trafficSourceFilter.test.ts
// GID 1216970103691946: 集計クエリが chat_sessions.metadata.source='user' 以外を
// 除外していることの検証(summary / trends / evaluations / conversions)。
//
// SQLの実行結果ではなく、pool.query() に渡された「SQLテキストに絞り込み条件が
// 含まれているか」を検証する(cvAggregation.test.ts と同じモック手法)。

import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../../lib/notifications", () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    // super_admin にして plan ゲートのクエリを発生させない(assert対象を絞るため)
    req.supabaseUser = { app_metadata: { role: "super_admin" } };
    next();
  },
}));

import { registerAnalyticsRoutes } from "./routes";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

const USER_SOURCE_SQL = "metadata->>'source' = 'user'";

beforeEach(() => {
  mockQuery.mockReset();
  // どのクエリにも安全に応答できる汎用モック(件数0・平均null等)
  mockQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
});

describe("GET /v1/admin/analytics/summary — source='user'フィルタ", () => {
  it("chat_sessions・conversation_evaluations・conversion_attributions のクエリ全てにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/summary");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sessionQueries = allSql.filter((sql) => /FROM chat_sessions/.test(sql) && !/tenants t/.test(sql));
    expect(sessionQueries.length).toBeGreaterThan(0);
    for (const sql of sessionQueries) {
      expect(sql).toContain(USER_SOURCE_SQL);
    }

    const evalQuery = allSql.find((sql) => /FROM conversation_evaluations/.test(sql));
    expect(evalQuery).toBeDefined();
    expect(evalQuery).toContain(USER_SOURCE_SQL);

    const cvQuery = allSql.find((sql) => /FROM conversion_attributions/.test(sql));
    expect(cvQuery).toBeDefined();
    expect(cvQuery).toContain(USER_SOURCE_SQL);
    // P0-3 (GID 1217808492463681, 2026-08-25): このテストは元々
    // `session_id IS NULL` の混入を「既存データの後方互換」として正当化し、
    // バグを仕様として固定していた。実際にはこの分岐が279件・¥507,210,000の
    // e2eトラフィックを無条件で通し、cv-status(同じテーブルをuserSourceExists
    // のみで集計)と正反対の値を summary が返していた
    // (本番実測: summary側 cv_count_30d=279 / cv-status側 0)。
    // D2(確定した設計判断): session_id が無い行は数えない。
    expect(cvQuery).not.toContain("session_id IS NULL");
  });
});

describe("GET /v1/admin/analytics/trends — source='user'フィルタ", () => {
  it("セッション数・Judgeスコア推移のサブクエリにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/trends");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const trendSql = allSql.find((sql) => /generate_series/.test(sql));
    expect(trendSql).toBeDefined();
    expect(trendSql).toContain(USER_SOURCE_SQL);
  });

  // GID 1217825468673283: fetchAnalyticsSummary の sentiment_distribution
  // (P0-3, PR #954)と同根の欠陥がfetchAnalyticsTrendのsentimentトレンド
  // クエリ(sentTrendsResult, FROM chat_messages cm)にもあった。上のテストは
  // generate_seriesクエリ(セッション数・Judgeスコア推移)しか見ておらず、
  // このクエリの欠落を検出できていなかった。
  it("sentimentトレンド(chat_messages)のクエリにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/trends");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sentTrendSql = allSql.find((sql) => /FROM chat_messages cm/.test(sql));
    expect(sentTrendSql).toBeDefined();
    expect(sentTrendSql).toContain(USER_SOURCE_SQL);
  });

  // USER_SOURCE_SQL("metadata->>'source' = 'user'")だけを見るアサーションは、
  // userSourceExists の第3引数が誤っていても通ってしまう(変異テストで実証:
  // "id"→"session_id" に変えても analytics 188件が全て緑のまま)。
  // 誤った第3引数は本番で cs.session_id(TEXT) = cm.session_id(UUID) を生成し、
  // Postgres は暗黙キャストしないため /trends が全呼び出しで500になる。
  // 静かな誤集計ではなく即死するので、結合列そのものを固定する。
  // PR #954 が summary 側で確立したガード(cvAggregation.test.ts)と同じ形。
  it("sentimentトレンドは chat_sessions.id(UUID)と突き合わせる(TEXT列と結合して500にしない)", async () => {
    await request(makeApp()).get("/v1/admin/analytics/trends");
    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sentTrendSql = allSql.find((sql) => /FROM chat_messages cm/.test(sql))!;
    expect(sentTrendSql).toMatch(/cs\.id\s*=\s*cm\.session_id/);
  });

  // GID 1217825468673283 のレビューで発見: sentiment と同じ理由で
  // knowledge_gaps 側にも実ユーザー判定が要る。summary側(total_knowledge_gaps)には
  // 付いているのに trends 側だけ抜けていると、同じ「未回答質問数」が
  // 2画面で食い違う(片方はe2e除外、片方は含む)。
  it("knowledge_gapsトレンドにも実ユーザー判定が入る(summaryと同じ数字になる)", async () => {
    await request(makeApp()).get("/v1/admin/analytics/trends");
    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const trendSql = allSql.find((sql) => /generate_series/.test(sql))!;
    // kg_count サブクエリ部分だけを取り出して検証する
    const kgBlock = /FROM knowledge_gaps kg[\s\S]*?GROUP BY day/.exec(trendSql)?.[0] ?? "";
    expect(kgBlock).toContain(USER_SOURCE_SQL);
    expect(kgBlock).toMatch(/cs\.id\s*=\s*kg\.session_id/);
  });

  // 実運用の大半は client_admin(テナント絞り込みあり)だが、上のテストは全て
  // super_admin(tenant_id なし)の分岐しか通っていなかった。$2 と EXISTS が
  // 並ぶ実際の形を1本固定しておく。
  it("テナント絞り込みありでも tenant_id 条件と実ユーザー判定が併存する", async () => {
    await request(makeApp()).get("/v1/admin/analytics/trends?tenant=tenant-a");
    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sentTrendSql = allSql.find((sql) => /FROM chat_messages cm/.test(sql))!;
    expect(sentTrendSql).toContain("cm.tenant_id = $2");
    expect(sentTrendSql).toContain(USER_SOURCE_SQL);
  });

  // /summary の sentiment_distribution と /trends の日次 sentiment は、同じ
  // chat_messages.sentiment を数える「同じ指標」。片方だけ述語が変わると
  // 2画面で数字が食い違う(P0-3で実際に起きた: summary 279 / cv-status 0)。
  // PR #954 が cvAggregation.test.ts で summary↔cv-status に対して確立した
  // 「EXISTS句の文字列一致を固定する」ガードを、summary↔trends にも広げる。
  // どちらか片方だけを将来編集したらここで落ちる。
  it("/summary と /trends の sentiment が同じEXISTS述語を使う(2画面で数字が割れない)", async () => {
    await request(makeApp()).get("/v1/admin/analytics/trends");
    const trendsSql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((sql) => /FROM chat_messages cm/.test(sql))!;

    mockQuery.mockClear();
    await request(makeApp()).get("/v1/admin/analytics/summary");
    const summarySql = mockQuery.mock.calls
      .map((c) => c[0] as string)
      .find((sql) => /FROM chat_messages\b/.test(sql) && /sentiment->>'label'/.test(sql))!;
    expect(summarySql).toBeDefined();

    // テーブル別名(cm. / chat_messages.)の差だけを吸収して、述語の構造を比較する。
    const normalize = (sql: string) => {
      const m = /AND EXISTS \([\s\S]*?metadata->>'source' = 'user'[\s\S]*?\)/.exec(sql);
      return (m ? m[0] : "").replace(/\bcm\./g, "chat_messages.").replace(/\s+/g, " ").trim();
    };
    expect(normalize(trendsSql)).toBe(normalize(summarySql));
  });
});

describe("GET /v1/admin/analytics/evaluations — source='user'フィルタ", () => {
  it("スコア分布・軸平均・低スコアセッション一覧の3クエリ全てにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/evaluations");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const evalQueries = allSql.filter((sql) => /FROM conversation_evaluations/.test(sql));
    expect(evalQueries.length).toBe(3);
    for (const sql of evalQueries) {
      expect(sql).toContain(USER_SOURCE_SQL);
    }
  });
});

describe("GET /v1/admin/analytics/conversions — source='user'フィルタ", () => {
  it("chat_sessions直接参照クエリ全てにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/conversions");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const sessionQueries = allSql.filter((sql) => /chat_sessions/.test(sql));
    expect(sessionQueries.length).toBeGreaterThan(0);
    for (const sql of sessionQueries) {
      expect(sql).toContain(USER_SOURCE_SQL);
    }
  });
});

describe("GET /v1/admin/analytics/cv-status — source='user'フィルタ (PR-3)", () => {
  it("conversion_attributions のCVカウントにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/cv-status");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const caQuery = allSql.find((sql) => /FROM conversion_attributions/.test(sql));
    expect(caQuery).toBeDefined();
    expect(caQuery).toContain(USER_SOURCE_SQL);
  });
});

describe("GET /v1/admin/analytics/measurement-health — source='user'フィルタ (PR-7)", () => {
  it("outcome記録率・実ユーザー有効セッション数のクエリにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get("/v1/admin/analytics/measurement-health");
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const outcomeSql = allSql.find((sql) => /outcome_recorded_by/.test(sql));
    expect(outcomeSql).toBeDefined();
    expect(outcomeSql).toContain(USER_SOURCE_SQL);
  });
});

describe("GET /v1/admin/analytics/knowledge-attribution — source='user'フィルタ (PR-3)", () => {
  it("current_period・previous_period 両方のCTEにsource='user'絞り込みが入っている", async () => {
    const res = await request(makeApp()).get(
      "/v1/admin/analytics/knowledge-attribution?tenant_id=carnation",
    );
    expect(res.status).toBe(200);

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const kaQuery = allSql.find((sql) => /current_period AS/.test(sql));
    expect(kaQuery).toBeDefined();
    // current_period・previous_period 両方のCTEに絞り込みが入っている(2箇所)ことを確認
    expect(kaQuery!.split(USER_SOURCE_SQL).length - 1).toBe(2);
  });
});
