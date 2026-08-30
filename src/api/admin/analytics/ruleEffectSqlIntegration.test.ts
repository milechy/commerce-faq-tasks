// src/api/admin/analytics/ruleEffectSqlIntegration.test.ts
//
// getRuleEffect（DiD集計。src/api/admin/analytics/ruleEffect.ts）を「実際の Postgres」に
// 対して検証する。
//
// ★このテストが埋める穴★
// 既存の ruleEffect.test.ts / ruleEffectRoute.test.ts は db.query をモックし、
// SQLが返す「行」を手で合成している。しかしこの関数が扱っているのは、
// まさにモックでは原理的に検証できない SQL の意味論そのもの:
//   - before/after の境界(first_message_at がちょうど approved_at の行はどちらに入るか)
//   - conversation_evaluations の相関サブクエリが tenant_id で本当に絞られているか
//     (session_id はテナントを跨いで一意ではない — テナントAとテナントBが
//      同じ session_id 文字列を持つケースは実際に起こりうる)
//   - score=0 の評価が NULL 相当に扱われるか(SQL側の `ev.score > 0` フィルタ)
//   - DISTINCT ON + ORDER BY created_at ASC が本当に「最初の発言」を選ぶか
//   - conversion_attributions が複数あっても EXISTS で二重計上されないか
//   - CANDIDATE_SESSION_PER_SIDE_LIMIT を超えたときに直近優先で切り詰められ、
//     もう一方の側が巻き込まれないか
// モックはこれらすべてを「モックした通りに動く」ことしか示せない。ここでは
// 実データを実 Postgres に投入し、getRuleEffect() の戻り値そのもので確認する。
//
// ★安全装置: 専用の環境変数(HERMES_MCP_SQL_TEST_DATABASE_URL)を使う★
// billingSqlIntegration.test.ts / hermesConsentSqlIntegration.test.ts と同じ理由
// (DATABASE_URL を流用すると開発者の .env が本番/検証DBを指していた場合に
// そこへ接続しかねない)。getRuleEffect が参照する5テーブル
// (tuning_rules / chat_sessions / chat_messages / conversation_evaluations /
// conversion_attributions)はすべて SCRIPTS/ci-hermes-schema.sh が既に作成済みのため、
// 専用の環境変数を新設せずそのまま流用する。
//
// ローカルで実行する場合:
//   createdb ruleeffect_sql_test
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/ruleeffect_sql_test \
//     bash SCRIPTS/ci-billing-schema.sh (DATABASE_URL に読み替えて実行)
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/ruleeffect_sql_test \
//     bash SCRIPTS/ci-hermes-schema.sh (同上)
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/ruleeffect_sql_test \
//     npx jest src/api/admin/analytics/ruleEffectSqlIntegration.test.ts

import { Pool } from "pg";
import { getRuleEffect, fetchCandidateSessions, CANDIDATE_SESSION_LIMIT } from "./ruleEffect";

const DB_URL = process.env.HERMES_MCP_SQL_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

// ruleEffect.ts 内の CANDIDATE_SESSION_PER_SIDE_LIMIT は export されていない
// (呼び出し元に上限値の変更を誘発したくないため)。CANDIDATE_SESSION_LIMIT は
// export されているのでそこから同じ計算式で導出する。
const PER_SIDE_LIMIT = CANDIDATE_SESSION_LIMIT / 2;

const RULE_CREATED_AT = "2026-01-01T00:00:00.000Z";
const APPROVED_AT = "2026-02-01T00:00:00.000Z";
const TRIGGER_PATTERN = "返品";
const MATCH_MSG = "返品したいのですが";
const NOMATCH_MSG = "配送状況を知りたいです";

d("getRuleEffect（実Postgresに対するDiD集計SQL検証）", () => {
  let db: Pool;
  let sessionSeq = 1;

  beforeAll(() => {
    // ★セッションのタイムゾーンをUTCに固定する★(billingSqlIntegration.test.ts と同じ理由。
    // first_message_at の境界比較を 'Z' 付きISO文字列で組み立てるため、接続セッションの
    // timezone GUC が本番(UTC)と違うと境界テストの合否が環境依存になる)。
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE tuning_rules, chat_sessions, chat_messages, conversation_evaluations, conversion_attributions RESTART IDENTITY CASCADE",
    );
    sessionSeq = 1;
  });

  async function insertRule(opts: {
    tenantId: string;
    triggerPattern?: string;
    createdAt?: string;
    approvedAt?: string;
  }): Promise<number> {
    const res = await db.query<{ id: number }>(
      `INSERT INTO tuning_rules
         (tenant_id, trigger_pattern, expected_behavior, priority, is_active, created_at, approved_at)
       VALUES ($1, $2, 'do something', 0, true, $3, $4)
       RETURNING id`,
      [
        opts.tenantId,
        opts.triggerPattern ?? TRIGGER_PATTERN,
        opts.createdAt ?? RULE_CREATED_AT,
        opts.approvedAt ?? APPROVED_AT,
      ],
    );
    return res.rows[0].id;
  }

  /**
   * 1セッション+最初のユーザー発言を作る。score/converted/2通目以降はオプションで
   * 付随データを足す(それぞれ省略時は「評価なし」「CVなし」「1通のみ」)。
   */
  async function insertSession(opts: {
    tenantId: string;
    firstMessageAt: string;
    content?: string;
    /** null なら metadata.source を設定しない(旧データ/未タグ付け相当) */
    source?: string | null;
    /** conversation_evaluations に何件・どのスコアで入れるか */
    scores?: number[];
    convertedTimes?: number;
    extraUserMessages?: { content: string; at: string }[];
  }): Promise<{ uuid: string; sessionIdText: string }> {
    const sessionIdText = `sess-${sessionSeq++}`;
    const metadata = opts.source === null ? "{}" : JSON.stringify({ source: opts.source ?? "user" });
    const sessionRes = await db.query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, session_id, metadata) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [opts.tenantId, sessionIdText, metadata],
    );
    const uuid = sessionRes.rows[0].id;
    await db.query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at)
       VALUES ($1, $2, 'user', $3, $4::timestamptz)`,
      [uuid, opts.tenantId, opts.content ?? NOMATCH_MSG, opts.firstMessageAt],
    );
    for (const extra of opts.extraUserMessages ?? []) {
      await db.query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at)
         VALUES ($1, $2, 'user', $3, $4::timestamptz)`,
        [uuid, opts.tenantId, extra.content, extra.at],
      );
    }
    for (const score of opts.scores ?? []) {
      await db.query(
        `INSERT INTO conversation_evaluations (tenant_id, session_id, score, evaluation_axes)
         VALUES ($1, $2, $3, '{}'::jsonb)`,
        [opts.tenantId, sessionIdText, score],
      );
    }
    for (let i = 0; i < (opts.convertedTimes ?? 0); i++) {
      await db.query(
        `INSERT INTO conversion_attributions (session_id, tenant_id, conversion_type) VALUES ($1, $2, 'purchase')`,
        [uuid, opts.tenantId],
      );
    }
    return { uuid, sessionIdText };
  }

  /**
   * 4群それぞれちょうど2件(getRuleEffectに渡すminSampleSize=2と一致)のベースラインを作る。
   * 個々のテストはこの上に検証対象の1セッションを追加し、対象群の
   * n/sessionCount/mean の増分だけを見る(ベースラインのスコアは全て50に揃え、
   * 差分を暗算しやすくする)。
   */
  async function seedBaseline(tenantId: string): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const day = 15 + i;
      await insertSession({ tenantId, firstMessageAt: `2026-01-${day}T00:00:00.000Z`, content: MATCH_MSG, scores: [50] }); // beforeTreatment
      await insertSession({ tenantId, firstMessageAt: `2026-02-${day}T00:00:00.000Z`, content: MATCH_MSG, scores: [50] }); // afterTreatment
      await insertSession({ tenantId, firstMessageAt: `2026-01-${day}T00:00:00.000Z`, content: NOMATCH_MSG, scores: [50] }); // beforeControl
      await insertSession({ tenantId, firstMessageAt: `2026-02-${day}T00:00:00.000Z`, content: NOMATCH_MSG, scores: [50] }); // afterControl
    }
  }

  it("境界: 最初の発言が承認時刻ちょうどのセッションは after 側に入る(>=)", async () => {
    const tenantId = "tenant-boundary";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);
    await insertSession({ tenantId, firstMessageAt: APPROVED_AT, content: NOMATCH_MSG, scores: [50] });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.comparison.groups.afterControl.sessionCount).toBe(3);
    expect(result.comparison.groups.beforeControl.sessionCount).toBe(2);
  });

  it("before期間にセッションが0件でも例外・ゼロ除算にならずinsufficient_dataを返す", async () => {
    const tenantId = "tenant-nobefore";
    const ruleId = await insertRule({ tenantId });
    // after側だけ作る。beforeTreatment/beforeControlのCTEが実際に空集合を
    // 返してもクラッシュしないこと、progressのcurrentNが0であることを確認する。
    await insertSession({ tenantId, firstMessageAt: "2026-02-15T00:00:00.000Z", content: MATCH_MSG, scores: [50] });
    await insertSession({ tenantId, firstMessageAt: "2026-02-16T00:00:00.000Z", content: MATCH_MSG, scores: [50] });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("insufficient_data");
    if (result.status !== "insufficient_data") return;
    const beforeTreatment = result.progress.find((p) => p.group === "beforeTreatment");
    const beforeControl = result.progress.find((p) => p.group === "beforeControl");
    expect(beforeTreatment?.currentN).toBe(0);
    expect(beforeControl?.currentN).toBe(0);
    // before系はETA計算対象外(観測期間固定)なのでnullのまま
    expect(beforeTreatment?.etaDays).toBeNull();
  });

  it("tenant_idで必ず絞られる: 他テナントの同名session_idの評価スコアが混入しない", async () => {
    const tenantA = "tenant-a-iso";
    const tenantB = "tenant-b-iso";
    const ruleId = await insertRule({ tenantId: tenantA });
    await seedBaseline(tenantA);

    // conversation_evaluations.session_id はテナントを跨いで一意ではない
    // (UNIQUEはtenant_id込みの複合ではなく、テーブル自体に一意制約が無い)。
    // 2テナントが同じ session_id 文字列を持つケースを再現する。
    const sharedSessionIdText = "shared-session-name";
    const sessA = await db.query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, session_id, metadata) VALUES ($1, $2, '{"source":"user"}'::jsonb) RETURNING id`,
      [tenantA, sharedSessionIdText],
    );
    await db.query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at)
       VALUES ($1, $2, 'user', $3, '2026-01-20T00:00:00.000Z'::timestamptz)`,
      [sessA.rows[0].id, tenantA, NOMATCH_MSG],
    );
    await db.query(
      `INSERT INTO conversation_evaluations (tenant_id, session_id, score, evaluation_axes) VALUES ($1, $2, 50, '{}'::jsonb)`,
      [tenantA, sharedSessionIdText],
    );

    // tenant B 側: 同じ session_id 文字列だが別テナント。CHECK制約の上限である
    // score=100を入れる。tenant_idガードが外れていればMAX(50,100)=100に引きずられる。
    const sessB = await db.query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, session_id, metadata) VALUES ($1, $2, '{"source":"user"}'::jsonb) RETURNING id`,
      [tenantB, sharedSessionIdText],
    );
    await db.query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at)
       VALUES ($1, $2, 'user', $3, '2026-01-20T00:00:00.000Z'::timestamptz)`,
      [sessB.rows[0].id, tenantB, NOMATCH_MSG],
    );
    await db.query(
      `INSERT INTO conversation_evaluations (tenant_id, session_id, score, evaluation_axes) VALUES ($1, $2, 100, '{}'::jsonb)`,
      [tenantB, sharedSessionIdText],
    );

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // beforeControlはtenant A側のみ対象: baseline2件(score50) + 対象1件(score50) = 3件、平均50。
    // tenant Bのchat_sessionsはtenant_id=$1の絞り込みで最初から候補に入らないため
    // sessionCountにも現れない。
    expect(result.comparison.groups.beforeControl.sessionCount).toBe(3);
    expect(result.comparison.groups.beforeControl.n).toBe(3);
    expect(result.comparison.groups.beforeControl.mean).toBe(50);
  });

  it("最初のユーザー発言はDISTINCT ON+created_at ASCで一番古い発言が採用される", async () => {
    const tenantId = "tenant-distinct";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);

    // 最初の発言(トリガー非一致)の5分後に、トリガーに一致する2通目を送る。
    // 「最初の発言」の定義を誤って最新発言や任意の発言で判定すると、
    // このセッションはtreatmentに誤分類される。
    await insertSession({
      tenantId,
      firstMessageAt: "2026-01-20T00:00:00.000Z",
      content: NOMATCH_MSG,
      scores: [50],
      extraUserMessages: [{ content: MATCH_MSG, at: "2026-01-20T00:05:00.000Z" }],
    });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.comparison.groups.beforeControl.sessionCount).toBe(3);
    expect(result.comparison.groups.beforeTreatment.sessionCount).toBe(2);
  });

  it("PR-3のトラフィックフィルタ: source='user'以外のセッションは母集団から除外される", async () => {
    const tenantId = "tenant-source";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);

    // e2e由来のセッション。トリガーに一致する内容だが、metadata.source!='user'のため
    // 除外されるはず(userSourceClauseがWHEREに正しく効いているかの実証)。
    await insertSession({
      tenantId,
      firstMessageAt: "2026-01-20T00:00:00.000Z",
      content: MATCH_MSG,
      scores: [50],
      source: "e2e",
    });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.analyzedSessions).toBe(8); // baseline8件のまま、e2eセッションは1件も含まれない
    expect(result.comparison.groups.beforeTreatment.sessionCount).toBe(2);
  });

  it("評価が無いセッションはn(判定対象)に数えないがsessionCountには数える", async () => {
    const tenantId = "tenant-noeval";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);

    await insertSession({ tenantId, firstMessageAt: "2026-01-20T00:00:00.000Z", content: NOMATCH_MSG }); // scores省略=評価なし

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.comparison.groups.beforeControl.sessionCount).toBe(3);
    expect(result.comparison.groups.beforeControl.n).toBe(2);
    expect(result.comparison.groups.beforeControl.mean).toBe(50); // 未評価は平均に影響しない
  });

  it("score=0の評価はNULL扱いになる(SQLの`ev.score > 0`フィルタ)", async () => {
    const tenantId = "tenant-zeroscore";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);

    await insertSession({ tenantId, firstMessageAt: "2026-01-20T00:00:00.000Z", content: NOMATCH_MSG, scores: [0] });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // 行自体は存在するのでsessionCountは増えるが、score>0フィルタでNULL相当になりnには入らない。
    expect(result.comparison.groups.beforeControl.sessionCount).toBe(3);
    expect(result.comparison.groups.beforeControl.n).toBe(2);
    expect(result.comparison.groups.beforeControl.mean).toBe(50);
  });

  it("同一セッションに複数回評価があればMAX(score)が採用される", async () => {
    const tenantId = "tenant-maxscore";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);

    await insertSession({ tenantId, firstMessageAt: "2026-01-20T00:00:00.000Z", content: NOMATCH_MSG, scores: [40, 90, 10] });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.comparison.groups.beforeControl.n).toBe(3);
    // baseline2件(score50,50) + 対象1件(max=90) の平均
    expect(result.comparison.groups.beforeControl.mean).toBeCloseTo((50 + 50 + 90) / 3, 2);
  });

  it("conversion_attributionsが複数あってもconvertedCount/sessionCountは二重計上されない", async () => {
    const tenantId = "tenant-multicv";
    const ruleId = await insertRule({ tenantId });
    await seedBaseline(tenantId);

    await insertSession({
      tenantId,
      firstMessageAt: "2026-01-20T00:00:00.000Z",
      content: NOMATCH_MSG,
      scores: [50],
      convertedTimes: 2,
    });

    const result = await getRuleEffect(db, ruleId, 2);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.comparison.groups.beforeControl.sessionCount).toBe(3); // 行の倍化なし
    expect(result.comparison.groups.beforeControl.n).toBe(3);
    expect(result.comparison.groups.beforeControl.mean).toBe(50);
    expect(result.comparison.groups.beforeControl.convertedCount).toBe(1); // CVが2件でもセッションとしては1
  });

  // 回帰: fetchCandidateSessions() の最終SELECT(before_limited/after_limitedを
  // UNION ALLしてchat_sessionsとJOINする箇所)には、当初 ORDER BY が無かった。
  // before_limited/after_limited内部の `ORDER BY first_message_at DESC` は
  // 各CTEが「どの行をLIMITで選ぶか」を決めるだけで、UNION ALL+JOIN後に
  // Postgresが実際に返す行の並び順までは保証しない。それにもかかわらず
  // 呼び出し側の `beforeRows.slice(0, CANDIDATE_SESSION_PER_SIDE_LIMIT)`
  // (ruleEffect.ts の fetchCandidateSessions 末尾)は「先頭から直近順に
  // 並んでいる」ことを暗黙に仮定していた。
  //
  // 実測(修正前): bulk(2026年1月頭、2501件)よりも明確に新しい(1月10日・
  // 11日の)treatmentセッションを2件加えると、本来は「全体で最も新しい
  // セッション」として無条件に生き残るはずが、2件のうち1件が切り捨てられた
  // (beforeTreatment.currentN=1になりゲート未達でinsufficient_dataに落ちる)。
  // まっさらなDBで5回連続実行して確認したところ、クエリプラン依存で
  // 非決定的(統計情報が付く前の1回目は再現せず、以降は再現)だった —
  // つまりCIのようにDBを毎回作り直す環境では確実に踏む条件だった。
  //
  // モックでは result.rows を呼び出し側で好きな順に組み立てるため、この
  // 「実際にPostgresが返す行順」の問題は原理的に再現できない。
  //
  // 修正: fetchCandidateSessions() の最終SELECTに
  // `ORDER BY f.first_message_at DESC` を追加し、呼び出し側の前提を
  // SQL自身に保証させた(詳細はruleEffect.ts側のコメント参照)。
  it(
    `回帰: 直近優先の上限(${PER_SIDE_LIMIT}件/側)を超えても、` +
      "全体最新の2セッションが切り捨てられてはいけない",
    async () => {
      const tenantId = "tenant-limit";
      const ruleId = await insertRule({ tenantId });

      // before側にPER_SIDE_LIMIT+1件(全件トリガー非一致=control)をバルク投入する。
      // session_id文字列に埋め込んだ通し番号から決定的にタイムスタンプを導出する
      // (INSERT...SELECT...RETURNINGの行順はSQL標準上保証されないため、
      // row_number()での対応付けに頼らない)。
      await db.query(
        `INSERT INTO chat_sessions (tenant_id, session_id, metadata)
         SELECT $1, 'bulk-before-' || i, '{"source":"user"}'::jsonb
         FROM generate_series(1, $2::int) AS i`,
        [tenantId, PER_SIDE_LIMIT + 1],
      );
      await db.query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at)
         SELECT cs.id, $1, 'user', $2,
                TIMESTAMPTZ '2026-01-01T00:00:00Z'
                  + (substring(cs.session_id from 'bulk-before-(\\d+)'))::int * interval '1 minute'
         FROM chat_sessions cs
         WHERE cs.tenant_id = $1 AND cs.session_id LIKE 'bulk-before-%'`,
        [tenantId, NOMATCH_MSG],
      );
      // 一番古い(通し番号1、つまり2026-01-01T00:01:00Z)セッションだけにscore=100を、
      // 残り全件にscore=1を付与する。直近優先(DESC)で切り詰められるなら、
      // 最も古い側から弾かれ、生き残った行の平均は1のまま変わらないはず
      // (score=100の行が生き残ると平均が動くので、切り詰めの方向を検出できる)。
      await db.query(
        `INSERT INTO conversation_evaluations (tenant_id, session_id, score, evaluation_axes)
         SELECT $1, cs.session_id,
                CASE WHEN (substring(cs.session_id from 'bulk-before-(\\d+)'))::int = 1 THEN 100 ELSE 1 END,
                '{}'::jsonb
         FROM chat_sessions cs
         WHERE cs.tenant_id = $1 AND cs.session_id LIKE 'bulk-before-%'`,
        [tenantId],
      );

      // beforeTreatmentのゲート(n>=2)を満たすため、bulk-controlより明確に新しい
      // (=削られにくい)日付のtreatmentセッションを2件加える。
      //
      // ★実装から判明した挙動(自己発見)★
      // CANDIDATE_SESSION_PER_SIDE_LIMIT は「beforeTreatmentとbeforeControlの合算」に
      // 対する共有予算であり、trigger一致/不一致で別枠になっていない
      // (fetchCandidateSessionsのSQLはmatchesTriggerPatternを一切知らず、
      // first_message_at DESCの1本の順序だけでbefore側全体をLIMITする。
      // treatment/control の分岐はSQLの外、getRuleEffect側でJS実行される)。
      // そのため、この2件のtreatmentセッションは「before側」の2500枠のうち
      // 2枠を必ず消費し、bulk-controlの生存数はPER_SIDE_LIMITぴったりではなく
      // PER_SIDE_LIMIT - 2 になる(以下のアサーションはこの実測に基づく)。
      await insertSession({ tenantId, firstMessageAt: "2026-01-10T00:00:00.000Z", content: MATCH_MSG, scores: [50] });
      await insertSession({ tenantId, firstMessageAt: "2026-01-11T00:00:00.000Z", content: MATCH_MSG, scores: [50] });
      await insertSession({ tenantId, firstMessageAt: "2026-02-10T00:00:00.000Z", content: MATCH_MSG, scores: [50] });
      await insertSession({ tenantId, firstMessageAt: "2026-02-11T00:00:00.000Z", content: MATCH_MSG, scores: [50] });
      await insertSession({ tenantId, firstMessageAt: "2026-02-15T00:00:00.000Z", content: NOMATCH_MSG, scores: [50] });
      await insertSession({ tenantId, firstMessageAt: "2026-02-16T00:00:00.000Z", content: NOMATCH_MSG, scores: [50] });

      const result = await getRuleEffect(db, ruleId, 2);
      if (result.status === "rule_not_found" || result.status === "not_yet_approved") {
        throw new Error(`unexpected status: ${result.status}`);
      }

      expect(result.truncated).toBe(true);

      // ruleEffect.ts の fetchCandidateSessions() 末尾に `ORDER BY
      // f.first_message_at DESC` を追加した(このテストが発見した回帰の修正)。
      // これにより「全体で最も新しいセッション」は上限超過時も無条件に
      // 生き残るはず。
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      expect(result.comparison.groups.beforeTreatment.sessionCount).toBe(2);
      // CANDIDATE_SESSION_PER_SIDE_LIMIT は before の treatment/control 合算の
      // 共有予算であるため(trigger一致/不一致で別枠になっていない)、
      // control側の生存数はPER_SIDE_LIMITぴったりではなく2件分減る。
      expect(result.comparison.groups.beforeControl.n).toBe(PER_SIDE_LIMIT - 2);
      expect(result.comparison.groups.beforeControl.mean).toBe(1); // score=100の最古行が切り捨てられている
      expect(result.comparison.groups.afterControl.sessionCount).toBe(2); // after側は打ち切りの影響を受けない
      expect(result.analyzedSessions).toBe(PER_SIDE_LIMIT + 2 + 2); // before(2500) + afterTreatment2 + afterControl2
    },
    30_000, // バルク投入(2501件)のため既定タイムアウトを延長
  );

  // 上のテストは「上限超過で切り捨てられない」という結果(getRuleEffectの
  // 最終出力)からORDER BYの効果を間接的に見ており、判定材料が上限到達という
  // 状況にもプランナの選択にも依存する(実際、まっさらなDBではORDER BYを
  // 外しても再現しないことが多い。統計情報が乏しい小さいデータではNested Loop
  // Joinが選ばれ、CTE内部のソート順がJOIN後もたまたま保持されてしまうため)。
  //
  // このテストは不変条件そのもの(「fetchCandidateSessions()が返す行は、
  // before/after各側でfirst_message_at降順に並んでいる」)を直接見る。
  // 上限に到達させる必要が無いため少数のデータで済み、判定はプランに依存しない
  // ―― ORDER BYがSQLに存在する限り、Postgresがどの結合方式(Hash Join/
  // Nested Loop/Merge Join)を選んでも最終的な行順は保証される(SQL仕様)。
  //
  // ★このテストが「ORDER BYの不在」を確実に検出できることの根拠★
  // enable_nestloop/enable_mergejoinをoffにしてHash Joinを強制する
  // (chat_sessionsとのJOINでHash Joinが選ばれると、ORDER BYが無い場合は
  // 挿入順(あえてシャッフルしてある)のまま行が返ってくることを、この
  // テストを書く過程で実際に確認した — ORDER BYを外した状態でこのGUC設定を
  // 併用すると、まっさらなDBでも複数回連続で確実に順序が崩れる)。
  it("回帰: fetchCandidateSessions()が返す行はbefore/after各側でfirst_message_at降順(ORDER BYの不変条件を直接検証・プラン非依存)", async () => {
    const tenantId = "tenant-order-invariant";
    // fetchCandidateSessions() は tenantId/sinceIso/approvedAtIso を直接引数で
    // 受け取り、tuning_rules は参照しない(ルール解決は呼び出し元のgetRuleEffect
    // が担う)ため、ここではtuning_rulesへの挿入は不要。

    // 意図的にシャッフルした順序で挿入する(挿入順=物理格納順に依存して
    // たまたま降順になる、という偶然の一致を排除するため)。
    const beforeTimestamps = Array.from(
      { length: 20 },
      (_, i) => `2026-01-${String(2 + i).padStart(2, "0")}T00:00:00.000Z`,
    );
    const afterTimestamps = Array.from(
      { length: 20 },
      (_, i) => `2026-02-${String(2 + i).padStart(2, "0")}T00:00:00.000Z`,
    );
    function shuffle<T>(arr: T[]): T[] {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(((i + 1) * 9301 + 49297) % 233280 / 233280 * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    for (const ts of shuffle([...beforeTimestamps, ...afterTimestamps])) {
      await insertSession({ tenantId, firstMessageAt: ts, content: NOMATCH_MSG });
    }

    // SET LOCALはトランザクション内でのみ有効かつコネクション単位のGUCのため、
    // Poolの使い回しではなく単一のクライアントを明示的にチェックアウトして使う。
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Hash Joinを強制する(Nested Loop/Merge Joinを無効化)。ORDER BYが
      // SQLに存在する限り、この強制はfetchCandidateSessionsの結果の正しさに
      // 影響しないはず。
      await client.query("SET LOCAL enable_nestloop = off");
      await client.query("SET LOCAL enable_mergejoin = off");

      const result = await fetchCandidateSessions(client, tenantId, RULE_CREATED_AT, APPROVED_AT);

      const approvedAtMs = new Date(APPROVED_AT).getTime();
      const beforeRows = result.rows.filter(
        (r) => new Date(r.first_message_at).getTime() < approvedAtMs,
      );
      const afterRows = result.rows.filter(
        (r) => new Date(r.first_message_at).getTime() >= approvedAtMs,
      );
      expect(beforeRows.length).toBe(20);
      expect(afterRows.length).toBe(20);

      const isDescending = (rows: typeof result.rows) =>
        rows.every(
          (r, i) =>
            i === 0 ||
            new Date(rows[i - 1].first_message_at).getTime() >= new Date(r.first_message_at).getTime(),
        );
      expect(isDescending(beforeRows)).toBe(true);
      expect(isDescending(afterRows)).toBe(true);

      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});
