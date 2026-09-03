// src/api/admin/analytics/measurementHealth.test.ts
// GID 1216970103691946 (PR-7): 計測ヘルス5指標の集計ロジックとCLAUDE.md禁止34
// (母数不足時に0や矢印を出さない)の検証。

jest.mock("../chat-history/chatHistoryRepository", () => ({
  AUTO_OUTCOME_RECORDED_BY: "system:cv_bridge",
}));

import { fetchMeasurementHealth } from "./measurementHealth";
import { fetchHermesAcceptanceRate } from "./summaryQueries";

function makeDb(responses: Array<{ rows: any[] }>) {
  let i = 0;
  const query = jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [] }));
  return { query };
}

describe("fetchMeasurementHealth", () => {
  it("5指標すべてを正しく集計する", async () => {
    const db = makeDb([
      { rows: [{ source: "e2e", count: "407" }, { source: "(null)", count: "598" }, { source: "user", count: "13" }] },
      { rows: [{ count: "320" }] }, // empty sessions
      { rows: [{ linked: "0", total: "858" }] }, // CV link
      { rows: [{ recorded: "1", auto_recorded: "0", total: "1041" }] }, // outcome
      { rows: [{ count: "13" }] }, // valid user sessions
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.sourceBreakdown).toEqual([
      { source: "e2e", count: 407 },
      { source: "(null)", count: 598 },
      { source: "user", count: 13 },
    ]);
    expect(result.emptySessionCount).toBe(320);
    expect(result.cvSessionLinkRate).toEqual({ numerator: 0, denominator: 858, rate: 0 });
    expect(result.outcomeRecordRate).toEqual({ numerator: 1, denominator: 1041, rate: 0.1, autoRecorded: 0 });
    expect(result.validUserSessionCount).toBe(13);
  });

  it("母数0のとき rate は 0 ではなく null を返す(CLAUDE.md 禁止34)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.cvSessionLinkRate.rate).toBeNull();
    expect(result.outcomeRecordRate.rate).toBeNull();
  });

  it("tenantId指定時は全クエリにtenant_id絞り込みが入る", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    await fetchMeasurementHealth(db, "tenant-a", "30d");

    // knowledgeIndexDrift(countFaqIndexMismatch)は独立した1引数クエリ形式
    // ($1=tenantIdのみ)で、faqIndexSync.test.ts 側でテナント絞り込みを検証済み。
    // ここでは元々の5指標クエリ(interval + tenant_id=$2)の絞り込みのみを検証する。
    const originalMetricCalls = db.query.mock.calls.filter(
      ([sql]: [string]) => !/FROM faq_docs|FROM faq_embeddings/.test(sql),
    );
    expect(originalMetricCalls.length).toBeGreaterThan(0);
    for (const call of originalMetricCalls) {
      const [sql, params] = call as [string, unknown[]];
      expect(sql).toMatch(/tenant_id = \$2/);
      expect(params).toEqual(["30 days", "tenant-a"]);
    }
  });

  it("knowledgeIndexDrift: tenantId指定時は3ストア突合を返す", async () => {
    // countFaqIndexMismatch のクエリ順は呼び出し順に依存しないよう、
    // SQL文の特徴的な部分文字列で振り分ける(連番配列だと内部クエリ数の
    // 変更に弱いため。variant.test.ts 等と同じ流儀)。
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/FROM faq_docs fd\s+WHERE fd\.tenant_id/.test(sql)) return Promise.resolve({ rows: [{ c: 1 }] });
      if (/FROM faq_embeddings fe/.test(sql)) return Promise.resolve({ rows: [{ c: 2 }] });
      if (/FROM faq_docs\s+WHERE tenant_id/.test(sql)) return Promise.resolve({ rows: [{ c: 10 }] });
      return Promise.resolve({ rows: [] });
    });
    const db = { query };

    const result = await fetchMeasurementHealth(db, "tenant-a", "30d");

    expect(result.knowledgeIndexDrift).toEqual({
      dbPublishedCount: 10,
      embeddingMissingCount: 1,
      orphanEmbeddingCount: 2,
      esCount: null, // ES_URL 未設定
    });
  });

  it("knowledgeIndexDrift: tenantId未指定(cross-tenant view)では null", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.knowledgeIndexDrift).toBeNull();
  });

  it("outcome記録率・実ユーザー有効セッション数のクエリはsource='user'絞り込みが入る(e2eを含めない)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    await fetchMeasurementHealth(db, null, "30d");

    const [outcomeSql] = db.query.mock.calls[3] as [string, unknown[]];
    const [validSql] = db.query.mock.calls[4] as [string, unknown[]];
    expect(outcomeSql).toContain("metadata->>'source' = 'user'");
    expect(validSql).toContain("metadata->>'source' = 'user'");
  });

  it("自動記録件数(auto_recorded)は outcome_recorded_by = AUTO_OUTCOME_RECORDED_BY で数える", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "5", auto_recorded: "3", total: "10" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    const [outcomeSql] = db.query.mock.calls[3] as [string, unknown[]];
    expect(outcomeSql).toContain("system:cv_bridge");
    expect(result.outcomeRecordRate.autoRecorded).toBe(3);
  });

  it("source列がnull(metadata.source未設定)のセッションは'(null)'という文字列で集計される(実データの文字列'null'と区別)", async () => {
    const db = makeDb([
      { rows: [{ source: "(null)", count: "598" }] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.sourceBreakdown[0]!.source).toBe("(null)");
  });
});

// L0-4(Gate 0): 4往復以上率(message_count>=8)。母数(validUserSessionCountと同じ
// 母集団)がMIN_CONVERSATIONS_FOR_RATE(30)未満なら、denominator=0でなくてもrateはnull
// (CLAUDE.md禁止34)。既存のvalidUserSessionCountクエリを1本に統合しているため、
// その値との整合も合わせて固定する。
describe("fetchMeasurementHealth — deepConversationRate", () => {
  it("母数0のとき rate は null(0%ではない)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0", deep_count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.deepConversationRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(result.validUserSessionCount).toBe(0);
  });

  it("母数1(会話1件のみ)のとき、denominator>0でもrateはnull(分母1でtrendを出さない)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "1", deep_count: "1" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.deepConversationRate).toEqual({ numerator: 1, denominator: 1, rate: null });
  });

  it("母数がMIN_CONVERSATIONS_FOR_RATE(30)ちょうどなら率を出す", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "30", deep_count: "6" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.deepConversationRate).toEqual({ numerator: 6, denominator: 30, rate: 20 });
  });

  it("母数が29(閾値未満)なら率を出さない", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "29", deep_count: "29" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.deepConversationRate.rate).toBeNull();
    expect(result.deepConversationRate).toEqual({ numerator: 29, denominator: 29, rate: null });
  });

  it("message_count>=8のクエリは既存のvalidUserSessionCountクエリ(source='user'絞り込み)と同じ1本に同居する(新規クエリを足さない)", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "30", deep_count: "6" }] },
    ]);

    await fetchMeasurementHealth(db, null, "30d");

    const [validSql] = db.query.mock.calls[4] as [string, unknown[]];
    expect(validSql).toContain("message_count >= 8");
    expect(validSql).toContain("metadata->>'source' = 'user'");
  });
});

// ナレッジ配線是正P14: 消費者の回答評価(👍👎)は率ではなく生の件数で返す
// (母数が小さくても、生の件数自体は禁止34が問題にする「誤った自信」を生まない)。
describe("fetchMeasurementHealth — answerFeedback", () => {
  it("up/downそれぞれのFILTER集計をそのまま返す", async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/FROM behavioral_events b\s+WHERE b\.event_type = 'answer_feedback'/.test(sql)) {
        return Promise.resolve({ rows: [{ up: "7", down: "3" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const db = { query };

    const result = await fetchMeasurementHealth(db, "tenant-a", "30d");

    expect(result.answerFeedback).toEqual({ upCount: 7, downCount: 3 });
  });

  it("行が返らない異常時でも落ちず0/0を返す", async () => {
    const db = makeDb([
      { rows: [] },
      { rows: [{ count: "0" }] },
      { rows: [{ linked: "0", total: "0" }] },
      { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] },
      { rows: [{ count: "0" }] },
    ]);

    const result = await fetchMeasurementHealth(db, null, "30d");

    expect(result.answerFeedback).toEqual({ upCount: 0, downCount: 0 });
  });

  it("tenantId指定時はbehavioral_eventsのクエリにもtenant_id絞り込みが入る", async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/FROM behavioral_events b\s+WHERE b\.event_type = 'answer_feedback'/.test(sql)) {
        return Promise.resolve({ rows: [{ up: "1", down: "1" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const db = { query };

    await fetchMeasurementHealth(db, "tenant-a", "30d");

    const feedbackCall = db.query.mock.calls.find(([sql]: [string]) =>
      /FROM behavioral_events b\s+WHERE b\.event_type = 'answer_feedback'/.test(sql),
    );
    expect(feedbackCall).toBeDefined();
    const [sql, params] = feedbackCall as [string, unknown[]];
    expect(sql).toContain("b.tenant_id = $2");
    expect(params).toEqual(["30 days", "tenant-a"]);
  });
});

// D2 / G5: 「チャットを開いたのに会話しなかった」割合。
// visitor_id の記録開始前は結合しようがないため、期間全体で率を出すと
// 「0%が話した」という誤った数字になる。母数の開始点を切る設計を固定する。
describe("fetchMeasurementHealth — chatOpenDropoff", () => {
  const BASE = [
    { rows: [] },                                              // sourceBreakdown
    { rows: [{ count: "0" }] },                                // empty
    { rows: [{ linked: "0", total: "0" }] },                   // cv
    { rows: [{ recorded: "0", auto_recorded: "0", total: "0" }] }, // outcome
    { rows: [{ count: "0" }] },                                // valid
  ];

  it("母数が閾値未満なら率を出さず null を返す(禁止34)", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: "2026-08-24T01:13:30Z", with_vid: "25", total: "39" }] },
      { rows: [{ opened: "10", conversed: "0" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.visitorsOpened).toBe(10);
    expect(r.chatOpenDropoff.dropoffRate).toBeNull();
    expect(r.chatOpenDropoff.trackingSince).toBe("2026-08-24T01:13:30Z");
  });

  it("母数が足りていれば率を出す", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "100", total: "100" }] },
      { rows: [{ opened: "100", conversed: "25" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.dropoffRate).toBe(75);
    expect(r.chatOpenDropoff.visitorsConversed).toBe(25);
  });

  it("visitor_id を持つセッションが1件も無ければ trackingSince は null(集計不能を明示)", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: null, with_vid: "0", total: "1103" }] },
      { rows: [{ opened: "0", conversed: "0" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.trackingSince).toBeNull();
    expect(r.chatOpenDropoff.dropoffRate).toBeNull();
    // この指標がどれだけ信頼できるかを別途示す
    expect(r.chatOpenDropoff.sessionCoverage).toEqual({ numerator: 0, denominator: 1103, rate: 0 });
  });

  it("visitor_id の付与率(sessionCoverage)を返す。低いほどこの指標は当てにならない", async () => {
    const db = makeDb([
      ...BASE,
      { rows: [{ since: "2026-08-24T01:13:30Z", with_vid: "25", total: "39" }] },
      { rows: [{ opened: "5", conversed: "1" }] },
    ]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.sessionCoverage.numerator).toBe(25);
    expect(r.chatOpenDropoff.sessionCoverage.denominator).toBe(39);
  });

  it("行が返らない異常時でも落ちず、数値を出さない", async () => {
    const db = makeDb([...BASE, { rows: [] }, { rows: [] }]);

    const r = await fetchMeasurementHealth(db, null, "30d");

    expect(r.chatOpenDropoff.trackingSince).toBeNull();
    expect(r.chatOpenDropoff.visitorsOpened).toBe(0);
    expect(r.chatOpenDropoff.dropoffRate).toBeNull();
  });

  // GID 1218086189953625: 分子(chat_sessions)はsource='user'で浄化済みなのに
  // 分母(chat_open)がノーフィルタだと比率が意味を持たない。opened_visitors CTEに
  // source='user'の絞り込みが入っていること、NULLは「不明」として別集計され
  // 除外理由が可視化されることを固定する。
  describe("source フィルタ(e2e/不明の除外)", () => {
    it("opened_visitors のSQLは behavioral_events.source = 'user' で絞り込む", async () => {
      const db = makeDb([
        ...BASE,
        { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "100", total: "100" }] },
        { rows: [{ opened: "100", conversed: "25" }] },
      ]);

      await fetchMeasurementHealth(db, null, "30d");

      const dropoffSql = db.query.mock.calls
        .map(([sql]: [string]) => sql)
        .find((sql: string) => sql.includes("opened_visitors AS"));
      expect(dropoffSql).toContain("b.source = 'user'");
      expect(dropoffSql).toContain("b.source IS NULL");
    });

    it("source IS NULL(不明)の訪問者数を除外理由として別途返す", async () => {
      const db = makeDb([
        ...BASE,
        { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "100", total: "100" }] },
        { rows: [{ opened: "100", conversed: "25", opened_unknown_source: "42" }] },
      ]);

      const r = await fetchMeasurementHealth(db, null, "30d");

      expect(r.chatOpenDropoff.unknownSourceVisitorCount).toBe(42);
      // 不明分は分母(visitorsOpened)には含まれない(別建て集計のため足し込まれていない)
      expect(r.chatOpenDropoff.visitorsOpened).toBe(100);
    });

    it("opened_unknown_source が応答に無くても0にフォールバックする(後方互換)", async () => {
      const db = makeDb([
        ...BASE,
        { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "100", total: "100" }] },
        { rows: [{ opened: "100", conversed: "25" }] },
      ]);

      const r = await fetchMeasurementHealth(db, null, "30d");

      expect(r.chatOpenDropoff.unknownSourceVisitorCount).toBe(0);
    });
  });

  // LB-9: 先回り声がけ(AI起点の自動開封)と能動クリック開封は応答率の意味が違うのに
  // 従来の visitorsOpened/dropoffRate は合算していた。トリガー種別ごとに出し分ける。
  describe("proactive/manual の出し分け", () => {
    it("新フィールド(opened_proactive等)が無い応答でも0にフォールバックする(後方互換)", async () => {
      const db = makeDb([
        ...BASE,
        { rows: [{ since: "2026-08-24T01:13:30Z", with_vid: "25", total: "39" }] },
        { rows: [{ opened: "10", conversed: "5" }] },
      ]);
      const r = await fetchMeasurementHealth(db, null, "30d");
      expect(r.chatOpenDropoff.proactive).toEqual({ visitorsOpened: 0, visitorsConversed: 0, dropoffRate: null });
      expect(r.chatOpenDropoff.manual).toEqual({ visitorsOpened: 0, visitorsConversed: 0, dropoffRate: null });
    });

    it("proactiveとmanualをそれぞれ独立に集計し、母数が閾値以上なら率を出す", async () => {
      const db = makeDb([
        ...BASE,
        { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "500", total: "500" }] },
        {
          rows: [{
            opened: "400", conversed: "50",
            opened_proactive: "300", conversed_proactive: "15", // 先回り: 300開いて15会話 = 離脱95%
            opened_manual: "100", conversed_manual: "35",       // 能動: 100開いて35会話 = 離脱65%
          }],
        },
      ]);
      const r = await fetchMeasurementHealth(db, null, "30d");

      expect(r.chatOpenDropoff.proactive).toEqual({ visitorsOpened: 300, visitorsConversed: 15, dropoffRate: 95 });
      expect(r.chatOpenDropoff.manual).toEqual({ visitorsOpened: 100, visitorsConversed: 35, dropoffRate: 65 });
      // 全体の visitorsOpened(400) と proactive+manual(300+100=400) は一致しうるが、
      // 両方の開き方をした訪問者がいれば全体の方が小さくなる(重複を1人と数えるため)。
      // このテストでは一致するケースを検証するに留め、不一致自体は不変条件としない。
      expect(r.chatOpenDropoff.visitorsOpened).toBe(400);
    });

    it("proactiveの母数が閾値未満ならproactiveのdropoffRateだけnullになる(manualは出る)", async () => {
      const db = makeDb([
        ...BASE,
        { rows: [{ since: "2026-08-01T00:00:00Z", with_vid: "100", total: "100" }] },
        {
          rows: [{
            opened: "100", conversed: "60",
            opened_proactive: "5", conversed_proactive: "1",    // 母数不足(MIN_VISITORS_FOR_RATE=30未満)
            opened_manual: "95", conversed_manual: "59",
          }],
        },
      ]);
      const r = await fetchMeasurementHealth(db, null, "30d");

      expect(r.chatOpenDropoff.proactive.dropoffRate).toBeNull();
      expect(r.chatOpenDropoff.manual.dropoffRate).not.toBeNull();
    });
  });
});

// GID 1217972930945091 (H-7): Hermes提案(tuning_rules source='hermes')の採択率。
// pendingは未判断のため母数(denominator)に含めない。CLAUDE.md禁止34(母数不足で0%を
// 出さない)を summaryQueries.ts 側の実装でも同じ流儀で固定する。
describe("fetchHermesAcceptanceRate", () => {
  it("active/rejectedが混在するとき、採択率が一致する(pendingは母数に含めない)", async () => {
    const db = makeDb([{ rows: [{ active: "3", rejected: "1", pending: "5" }] }]);

    const result = await fetchHermesAcceptanceRate(db);

    expect(result.acceptanceRate).toEqual({ numerator: 3, denominator: 4, rate: 75 });
    expect(result.pendingCount).toBe(5);
    expect(typeof result.asOf).toBe("string");
    expect(Number.isNaN(Date.parse(result.asOf))).toBe(false);
  });

  it("母数0(Hermes提案が1件も無い)のとき rate は null(no_data)で 0% を出さない", async () => {
    const db = makeDb([{ rows: [{ active: "0", rejected: "0", pending: "0" }] }]);

    const result = await fetchHermesAcceptanceRate(db);

    expect(result.acceptanceRate).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  it("pendingのみ(active/rejectedが0件)のとき、母数に入らずnullのまま", async () => {
    const db = makeDb([{ rows: [{ active: "0", rejected: "0", pending: "7" }] }]);

    const result = await fetchHermesAcceptanceRate(db);

    expect(result.acceptanceRate.rate).toBeNull();
    expect(result.acceptanceRate.denominator).toBe(0);
    expect(result.pendingCount).toBe(7);
  });

  it("母数1(承認1件のみ)でも率自体は計算される(trend/矢印は別途フロント側で出さない)", async () => {
    const db = makeDb([{ rows: [{ active: "1", rejected: "0", pending: "0" }] }]);

    const result = await fetchHermesAcceptanceRate(db);

    expect(result.acceptanceRate).toEqual({ numerator: 1, denominator: 1, rate: 100 });
  });

  it("行が返らないとき(空DB)は例外を投げずゼロ扱いでnullを返す", async () => {
    const db = makeDb([{ rows: [] }]);

    const result = await fetchHermesAcceptanceRate(db);

    expect(result.acceptanceRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(result.pendingCount).toBe(0);
  });

  // 他の提案元(judge提案・evaluationのsuggested_rules/knowledge_gaps等)は同じ
  // tuning_rules テーブルに同居している。SQL側のWHERE句が外れると、それらが
  // 静かに母数へ混ざり込み「Hermesを止めるか続けるか」の判断そのものを誤らせる。
  // ここではmakeDbがSQL文の中身を見ないモックのため実データでの遮断は検証できないが、
  // WHERE句自体がクエリから失われていないことをテキストロックで固定する。
  it("SQLはsource='hermes'で絞り込む(judge提案等の他sourceを母数に混ぜない)", async () => {
    const db = makeDb([{ rows: [{ active: "3", rejected: "1", pending: "5" }] }]);

    await fetchHermesAcceptanceRate(db);

    const [sql] = db.query.mock.calls[0] as [string, unknown[]?];
    expect(sql).toMatch(/WHERE\s+source\s*=\s*'hermes'/);
    // source列に対する絞り込みがこの1箇所だけであること(WHERE句の外に
    // source条件が漏れて二重定義になっていないか、逆に別の緩い条件に
    // すり替わっていないかを1箇所の完全一致で固定する)
    expect(sql.match(/source\s*=\s*'hermes'/g)?.length).toBe(1);
  });

  // 集計は全テナント横断の累計値(super_adminにのみ合成される。routes.tsの
  // コメント・schemaHealthRoute.test.tsで確認済み)。tenant_id述語が紛れ込むと
  // 一部テナントの提案だけを見て「Hermesの成果」を語ることになり、意図と異なる。
  it("SQLはtenant_idで絞り込まない(全テナント横断の累計値であることを固定する)", async () => {
    const db = makeDb([{ rows: [{ active: "3", rejected: "1", pending: "5" }] }]);

    await fetchHermesAcceptanceRate(db);

    const [sql] = db.query.mock.calls[0] as [string, unknown[]?];
    expect(sql).not.toMatch(/tenant_id/);
  });

  // status='active'/'rejected'/'pending'以外の値(NULL・空文字・未知の文字列)の行は
  // どのFILTERにも一致せずCOUNT(*)から漏れる。無条件の全件COUNTが別途あると、
  // その「行方不明」の件数が別経路で母数に紛れ込む余地になるため、3つのFILTER付き
  // COUNT(*)以外に無条件COUNT(*)が存在しないことも合わせて固定する。
  it("SQLはstatus='active'/'rejected'/'pending'の完全一致FILTERのみで集計する(想定外statusの行はどのFILTERにも入らず母数を汚さない)", async () => {
    const db = makeDb([{ rows: [{ active: "3", rejected: "1", pending: "5" }] }]);

    await fetchHermesAcceptanceRate(db);

    const [sql] = db.query.mock.calls[0] as [string, unknown[]?];
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+status\s*=\s*'active'\)/);
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+status\s*=\s*'rejected'\)/);
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+status\s*=\s*'pending'\)/);
    expect(sql.match(/COUNT\(\*\)/g)?.length).toBe(3);
  });

  // CLAUDE.md 禁止16: AT TIME ZONE を片側だけ書く・サーバTZ依存の実装は本番でのみ
  // ズレ、数値はもっともらしく出るため気づけない。asOfはSQLのAT TIME ZONEではなく
  // JS Date#toISOString()(常にUTC・'Z'終端)で作るためprocess TZに依存しないことを固定する。
  it("asOfはUTC('Z'終端)のISO文字列で、process TZに依存しない(禁止16)", async () => {
    const db = makeDb([{ rows: [{ active: "1", rejected: "1", pending: "0" }] }]);

    const result = await fetchHermesAcceptanceRate(db);

    expect(result.asOf).toMatch(/Z$/);
  });
});
