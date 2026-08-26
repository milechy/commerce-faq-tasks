/**
 * billingSqlIntegration.test.ts — 集計SQLを「実際に」実行して検証する(A-2)。
 *
 * これまで stripeSync.test.ts は集計SQLをソース文字列への正規表現照合と、
 * テスト側で書き直した再現実装(billedQuantity ヘルパ)でしか守っておらず、
 * SQL の意味論(GROUP BY・JOIN・NUMERIC の丸め・numeric→文字列変換)は
 * 一度も実行されていなかった。ここでは実 Postgres に対して
 * computeExpectedBilling() を実際に呼び、手計算した期待値と一致することを
 * 確認する。
 *
 * ★安全装置: 専用の環境変数(BILLING_SQL_TEST_DATABASE_URL)を使う★
 * DATABASE_URL を流用すると、開発者の .env に本番/検証DBの接続先が
 * 入っていた場合に、このテストがそこへ実際に接続してテーブルを操作しかねない。
 * 専用の変数名にすることで、明示的にオプトインしない限り絶対に実行されない
 * (=通常の `pnpm test` では自動的にスキップされる)。
 *
 * ローカルで実行する場合:
 *   createdb billing_sql_test
 *   BILLING_SQL_TEST_DATABASE_URL=postgresql://localhost/billing_sql_test \
 *     bash SCRIPTS/ci-billing-schema.sh
 *   BILLING_SQL_TEST_DATABASE_URL=postgresql://localhost/billing_sql_test \
 *     npx jest src/lib/billing/billingSqlIntegration.test.ts
 */
import { Pool } from "pg";
import { computeExpectedBilling } from "./stripeSync";
import { findMissingColumns, REQUIRED_COLUMNS } from "../../api/admin/analytics/schemaHealth";

const DB_URL = process.env.BILLING_SQL_TEST_DATABASE_URL;

// env未設定時はスキップする(describe.skip ではなく it.skip 相当にするため
// describe 自体を切り替える。CIのPostgresジョブでのみ実行される)。
const d = DB_URL ? describe : describe.skip;

// schemaHealth.ts の REQUIRED_COLUMNS のうち、SCRIPTS/ci-billing-schema.sh が
// 対象とする billing 関連テーブルだけを抜き出す。REQUIRED_COLUMNS には
// chat_messages 等の非billingテーブルも含まれており、ci-billing-schema.sh は
// それらを作らないため全件チェックはできない(2026-08-25 収益監査で
// stripe_webhook_events がこの2つの間で食い違っていたことが発覚した本人)。
const BILLING_TABLES = [
  "billing_adjustments",
  "lemonslice_monthly_charges",
  "livekit_monthly_charges",
  "platform_monthly_charges",
  "stripe_subscriptions",
  "stripe_usage_reports",
  "stripe_webhook_events",
  "usage_logs",
] as const;
const BILLING_REQUIRED_COLUMNS = Object.fromEntries(
  BILLING_TABLES.map((t) => [t, REQUIRED_COLUMNS[t]])
);

d("computeExpectedBilling（実 Postgres に対する集計SQL実行）", () => {
  let db: Pool;

  beforeAll(() => {
    // ★セッションのタイムゾーンをUTCに固定する★
    // periodToDateRange() は getPeriodYyyyMm() の UTC ベースの暦月境界を
    // 'YYYY-MM-DD' という「タイムゾーン情報を持たない」文字列で SQL に渡す。
    // PostgreSQL はこれを timestamptz にキャストする際、接続セッションの
    // timezone GUC を使う(CLAUDE.md 禁止16 と同じ種類の罠)。本番VPSは
    // Etc/UTC で確認済み(2026-08-25)だが、ローカル開発機やCIランナーの
    // Postgres がそれ以外のタイムゾーンで動いていると、このテストの合否が
    // 実行環境によって変わってしまう。本番の実際の挙動(UTC)を固定して
    // 再現することで、テストを環境非依存かつ本番挙動に忠実にする。
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    // 前のテストの残骸を引きずらない。CASCADE で外部キー依存も一緒に消す。
    // chat_sessions は課金テーブルではないが、会話単位の課金で集計SQLが LEFT JOIN
    // するようになったため、残骸が残ると次のテストの message_count 判定を汚染する。
    await db.query(
      "TRUNCATE usage_logs, stripe_usage_reports, stripe_subscriptions, chat_sessions RESTART IDENTITY CASCADE"
    );
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, plan) VALUES ('t1', 't1', 'growth'), ('other', 'other', 'starter')`
    );
  });

  it("月中プラン変更・NULL行・billable=false・reported済み・他テナント・anam_sessionが混在する月を正しく集計する", async () => {
    await db.query(`
      -- starter期間 100件(×1.0)
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, cost_total_cents, plan, plan_multiplier, created_at)
      SELECT 't1', 'a'||g, 'chat', 5, 'starter', 1.0, '2026-03-05'::timestamptz FROM generate_series(1,100) g;

      -- growthへ変更後 100件(×1.5)
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, cost_total_cents, plan, plan_multiplier, created_at)
      SELECT 't1', 'b'||g, 'chat', 5, 'growth', 1.5, '2026-03-20'::timestamptz FROM generate_series(1,100) g;

      -- migration前の既存行 10件(plan_multiplier NULL → 現在プランのgrowth=1.5にフォールバック)
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, cost_total_cents, created_at)
      SELECT 't1', 'c'||g, 'chat', 5, '2026-03-10'::timestamptz FROM generate_series(1,10) g;

      -- billable=false(管理系機能)は除外される
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, billable, created_at)
      VALUES ('t1','x1','admin_tuning', 2.5, false, '2026-03-12');

      -- C-2: billing_status='reported'済みの行も対象に含む(累積を毎回再計算するため)
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, billing_status, created_at)
      VALUES ('t1','x2','chat', 2.5, 'reported', '2026-03-12');

      -- 他テナントは除外される
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      VALUES ('other','x3','chat', 2.5, '2026-03-12');

      -- anam_session: 90秒 → CEIL(90/60)=2単位 × 1.5
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, anam_session_seconds, plan_multiplier, created_at)
      VALUES ('t1','d1','anam_session', 90, 1.5, '2026-03-25');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");

    // 手計算(ローカルPostgres 17.6で事前検証済み):
    //   billable_units = 100 + 100 + 10 + 1(x2) + 2(anam) = 213
    //   billed_units_weighted = 100*1.0 + 100*1.5 + 10*1.5(fallback) + 1*2.5 + 2*1.5
    //                          = 100 + 150 + 15 + 2.5 + 3 = 270.5 → ceil = 271
    expect(result).toEqual({
      totalRequests: 212, // admin_tuning(billable=false)を除く210 + x2 + d1
      totalCostCents: 1050, // 210件 × 5セント
      billableUnits: 213,
      unstampedRows: 10,
      billedQuantity: 271,
      fallbackMultiplier: 1.5,
      // 込み枠(Standard/Growth)を差し引くための「生の」次元別数量。倍率は掛けない。
      // テキスト: session_id を持つ chat 行が無いので会話は0件。session_id が NULL の
      //   chat 行 211件(100+100+10+x2)が 1行=1単位 のフォールバックで数えられる。
      // アバター: anam_session 90秒 → CEIL(90/60) = 2分。
      textUnits: 211,
      avatarMinutes: 2,
    });
  });

  it("期間の境界は半開区間(月またぎを二重計上しない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','before','chat', 1.0, '2026-02-28 23:59:59+00'),
        ('t1','start','chat', 1.0, '2026-03-01 00:00:00+00'),
        ('t1','end','chat', 1.0, '2026-03-31 23:59:59+00'),
        ('t1','after','chat', 1.0, '2026-04-01 00:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");

    // 3月開始ちょうど(start)は含み、4月開始ちょうど(after)は含まない
    expect(result.totalRequests).toBe(2);
    expect(result.billedQuantity).toBe(2);
  });

  it("利用が無い月は全て0で、例外を投げない", async () => {
    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result).toEqual({
      totalRequests: 0,
      totalCostCents: 0,
      billableUnits: 0,
      unstampedRows: 0,
      billedQuantity: 0,
      fallbackMultiplier: 1.5,
      textUnits: 0,
      avatarMinutes: 0,
    });
  });

  it("NUMERIC の丸め: 端数を持つ倍率の合計が浮動小数の誤差なく切り上がる", async () => {
    // 0.1 のような小数は浮動小数点で誤差が出やすいが、PostgresのNUMERIC型は
    // 正確な10進演算をする。3件 × 1.5 = 4.5 → ceil(4.5) = 5 になることを確認。
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      SELECT 't1', 'n'||g, 'chat', 1.5, '2026-03-15'::timestamptz FROM generate_series(1,3) g
    `);
    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.billedQuantity).toBe(5);
  });


  // ───────────────────────────────────────────────────────────────────────────
  // 会話単位の課金(テキスト) — 2026-08-26 に確定した課金単位。
  // CLAUDE.md 禁止56 / .claude/rules/billing.md §7。
  // SQL の意味論(DISTINCT ON・LEFT JOIN・GROUP の畳み方)は実 Postgres でしか
  // 検証できないため、単位の定義そのものはここで固定する。
  // ───────────────────────────────────────────────────────────────────────────

  /** 課金対象の会話(message_count>=2 = 1往復以上)を1件作る */
  const insertSession = async (
    tenantId: string,
    sessionId: string,
    messageCount: number
  ): Promise<void> => {
    await db.query(
      `INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ($1, $2, $3)`,
      [tenantId, sessionId, messageCount]
    );
  };

  it("同一会話の複数リクエストは1単位として請求する(リクエスト単位に戻らない)", async () => {
    await insertSession("t1", "s-1", 2);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','r1','s-1','chat', 1.0, '2026-03-05'),
        ('t1','r2','s-1','chat', 1.0, '2026-03-05'),
        ('t1','r3','s-1','chat', 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");

    // 3リクエスト = 1会話 = 1単位。旧規則なら 3 になっていた。
    expect(result.billableUnits).toBe(1);
    expect(result.billedQuantity).toBe(1);
    // 原価とリクエスト数は行単位のまま(可視化のための値なので畳まない)
    expect(result.totalRequests).toBe(3);
  });

  it("会話が3件あれば3単位(会話ごとに独立して数える)", async () => {
    await insertSession("t1", "s-1", 2);
    await insertSession("t1", "s-2", 4);
    await insertSession("t1", "s-3", 10);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','a1','s-1','chat', 1.0, '2026-03-05'),
        ('t1','a2','s-1','chat', 1.0, '2026-03-05'),
        ('t1','b1','s-2','chat', 1.0, '2026-03-06'),
        ('t1','c1','s-3','chat', 1.0, '2026-03-07'),
        ('t1','c2','s-3','chat', 1.0, '2026-03-07'),
        ('t1','c3','s-3','chat', 1.0, '2026-03-07')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(3);
    expect(result.billedQuantity).toBe(3);
  });

  it("message_count が 0 / 1 の会話は課金しない(ウィジェットを開いただけ・応答が返っていない)", async () => {
    await insertSession("t1", "opened-only", 0);
    await insertSession("t1", "no-reply", 1);
    await insertSession("t1", "real", 2);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','x1','opened-only','chat', 1.0, '2026-03-05'),
        ('t1','x2','no-reply','chat', 1.0, '2026-03-05'),
        ('t1','x3','real','chat', 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");

    // 本番実測では 0 件が 325 セッション(23%)。ここを課金すると請求が2割水増しされる。
    expect(result.billableUnits).toBe(1);
    expect(result.billedQuantity).toBe(1);
    // 原価は3件分とも記録に残る(請求数量が0になることと原価計上は別のアサーション)
    expect(result.totalRequests).toBe(3);
  });

  it("message_count は境界(1件目=課金しない / 2件目=課金する)でだけ切り替わる", async () => {
    await insertSession("t1", "s-1", 1);
    await insertSession("t1", "s-2", 2);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','r1','s-1','chat', 1.0, '2026-03-05'), ('t1','r2','s-2','chat', 1.0, '2026-03-05')
    `);
    expect((await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter")).billableUnits).toBe(1);

    // 後から2通目が入れば、次の再計算で課金対象に「戻る」。
    // (書き込み時に billable=false を焼き付ける実装だと二度と戻らない = 恒久的な過少請求)
    await db.query(`UPDATE chat_sessions SET message_count = 2 WHERE session_id = 's-1'`);
    expect((await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter")).billableUnits).toBe(2);
  });

  it("chat_sessions 行が無い会話は課金する(Right to Erasure の削除・saveMessage の記録漏れで請求が消えない)", async () => {
    // chat_sessions を作らない = 削除済み or fire-and-forget の記録漏れ
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','r1','ghost','chat', 1.0, '2026-03-05'), ('t1','r2','ghost','chat', 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    // 会話としては1単位。0 にすると billedQuantity が「減る」ことがあり、
    // 単調非減少を前提にした idempotencyKey が過去のキーへ後戻りする。
    expect(result.billableUnits).toBe(1);
    expect(result.billedQuantity).toBe(1);
  });

  it("会話の削除で billedQuantity が減らない(削除前後で同額)", async () => {
    await insertSession("t1", "s-1", 4);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','r1','s-1','chat', 1.0, '2026-03-05'), ('t1','r2','s-1','chat', 1.0, '2026-03-05')
    `);
    const before = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");

    await db.query(`DELETE FROM chat_sessions WHERE tenant_id = 't1' AND session_id = 's-1'`);
    const after = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");

    expect(after.billedQuantity).toBe(before.billedQuantity);
  });

  it("session_id が NULL の既存行(migration適用前)は 1行=1単位で数え続ける(黙って請求から消さない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      SELECT 't1', 'legacy'||g, 'chat', 1.0, '2026-03-05'::timestamptz FROM generate_series(1,5) g
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(5);
    expect(result.billedQuantity).toBe(5);
  });

  it("会話単位の行と NULL の既存行が混在しても、それぞれの規則で数える", async () => {
    await insertSession("t1", "s-1", 2);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','n1', NULL,  'chat', 1.0, '2026-03-05'),
        ('t1','n2', NULL,  'chat', 1.0, '2026-03-05'),
        ('t1','s1','s-1',  'chat', 1.0, '2026-03-06'),
        ('t1','s2','s-1',  'chat', 1.0, '2026-03-06')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(3); // NULL 2件 + 会話1件
  });

  it("会話内で plan_multiplier が割れたら最初の行(会話開始時点)の倍率を採る", async () => {
    await insertSession("t1", "s-1", 4);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','r2','s-1','chat', 2.5, '2026-03-05 10:05:00+00'),
        ('t1','r1','s-1','chat', 1.0, '2026-03-05 10:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    // 会話開始時点は starter(1.0)。後から enterprise へ上げても遡って高くならない。
    expect(result.billedQuantity).toBe(1);
  });

  // ★CLAUDE.md 禁止24: JOIN 先にもテナント述語を張る★
  // chat_sessions の業務キーは (tenant_id, session_id) の複合で、session_id 単体は
  // テナントを跨いで衝突しうる。テナント述語を落とすと、他テナントの会話の
  // message_count で自テナントの課金可否が決まる。
  // 判定が「反転する」向きで組むこと — 自テナント側が課金対象のケースだけを見ると、
  // 他テナント行が混ざっても答えが変わらず、述語を落としても緑のままになる。
  it("他テナントの同名 session_id の message_count で課金可否が決まらない", async () => {
    // t1 の会話は1通だけ(課金対象外)。同じ session_id を持つ other の会話は5通。
    // テナント述語が無いと other 側が拾われ、課金対象外のはずの会話が課金される。
    await insertSession("t1", "shared-id", 1);
    await insertSession("other", "shared-id", 5);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','r1','shared-id','chat', 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(0);
  });

  it("他テナントの会話が1通でも、自テナントの会話は課金される(上のテストの対照)", async () => {
    await insertSession("t1", "shared-id", 2);
    await insertSession("other", "shared-id", 1);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','r1','shared-id','chat', 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // アバターは「分」で課金する(CLAUDE.md 禁止56)。
  // ───────────────────────────────────────────────────────────────────────────

  it("avatar は avatar_session_ms を分に切り上げて数える(回数で数えない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, plan_multiplier, created_at)
      VALUES
        ('t1','a1','avatar',    30000, 1.0, '2026-03-05'),  -- 30秒  → 1分
        ('t1','a2','avatar',    60000, 1.0, '2026-03-06'),  -- 60秒  → 1分
        ('t1','a3','avatar',    61000, 1.0, '2026-03-07'),  -- 61秒  → 2分
        ('t1','a4','avatar',  900000, 1.0, '2026-03-08')    -- 15分  → 15分
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    // 1 + 1 + 2 + 15 = 19分。回数で数えると 4 にしかならず、15分セッションで赤字になる。
    expect(result.billableUnits).toBe(19);
    expect(result.billedQuantity).toBe(19);
    expect(result.billableUnits).not.toBe(4);
  });

  it("avatar_session_ms が NULL の行(agent.py の TTS 報告)は 0 分として扱う(同一セッションの二重計上を避ける)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, tts_text_bytes, plan_multiplier, created_at)
      VALUES
        ('t1','tts1','avatar', NULL, 120, 1.0, '2026-03-05'),
        ('t1','tts2','avatar', NULL, 340, 1.0, '2026-03-05'),
        ('t1','sess','avatar', 180000, NULL, 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    // セッション長は _report_avatar_usage が別行で報告する(3分)。
    // 発話ごとの TTS 行を1単位ずつ数えると、同じセッションを発話回数分だけ二重請求する。
    expect(result.billableUnits).toBe(3);
  });

  it("avatar の分換算はプラン倍率と併用でき、切り上げは合計に対して1回だけ", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, plan_multiplier, created_at)
      VALUES
        ('t1','a1','avatar', 30000, 1.5, '2026-03-05'),
        ('t1','a2','avatar', 30000, 1.5, '2026-03-06'),
        ('t1','a3','avatar', 30000, 1.5, '2026-03-07')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.billableUnits).toBe(3);
    // 1*1.5 × 3 = 4.5 → 切り上げは1回だけなので 5(行ごとに切り上げると 6 に膨らむ)
    expect(result.billedQuantity).toBe(5);
  });

  it("anam_session の秒→分換算は据え置き(avatar を足したことで壊れていない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, anam_session_seconds, plan_multiplier, created_at)
      VALUES ('t1','n1','anam_session', 90, 1.0, '2026-03-05')
    `);
    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(2);
  });

  it("テキスト会話とアバターは別々の規則で数え、二重計上しない", async () => {
    await insertSession("t1", "s-1", 4);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, avatar_session_ms, plan_multiplier, created_at)
      VALUES
        ('t1','c1','s-1',  'chat',   NULL,   1.0, '2026-03-05'),
        ('t1','c2','s-1',  'chat',   NULL,   1.0, '2026-03-05'),
        ('t1','v1', NULL,  'avatar', 120000, 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    // 会話1単位 + アバター2分 = 3。アバター行は feature_used が 'chat' ではないため、
    // 会話の COUNT には構造的に入らない。
    expect(result.billableUnits).toBe(3);
  });

  it("session_id を持つ非チャット行は会話に畳まれず、それぞれの規則で数える", async () => {
    // 現状 session_id を入れるのは /api/chat だけだが、将来他経路が入れても
    // 会話カウントが汚染されない(feature_used='chat' で厳密に絞っている)ことを固定する。
    await insertSession("t1", "s-1", 4);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, avatar_session_ms, plan_multiplier, created_at)
      VALUES
        ('t1','c1','s-1','chat',   NULL,   1.0, '2026-03-05'),
        ('t1','c2','s-1','chat',   NULL,   1.0, '2026-03-05'),
        ('t1','v1','s-1','avatar', 120000, 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(3); // 会話1 + アバター2分
  });

  it("会話単位でも絶対値の再計算は冪等(同じ入力で何度呼んでも同じ値)", async () => {
    await insertSession("t1", "s-1", 2);
    await insertSession("t1", "s-2", 2);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, billing_status, created_at)
      VALUES
        ('t1','r1','s-1','chat', 1.5, 'reported', '2026-03-05'),
        ('t1','r2','s-1','chat', 1.5, 'pending',  '2026-03-05'),
        ('t1','r3','s-2','chat', 1.5, 'pending',  '2026-03-06')
    `);

    const first  = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    const second = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");

    expect(second).toEqual(first);
    // billing_status では絞らない: reported 済みの会話も毎回数え直す(累積の絶対値)
    expect(first.billableUnits).toBe(2);
    expect(first.billedQuantity).toBe(3); // ceil(1.5 + 1.5)
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 込み枠(Standard/Growth)を差し引くための「生の」次元別数量。
  // billedQuantity は行ごとの倍率で重み付け済みの値なので、込み枠の差し引きには
  // 使えない(枠は「会話数」「分数」という生の単位で定義されている)。
  // ───────────────────────────────────────────────────────────────────────────
  it("textUnits は会話(session_id)ごとに1、session_id が NULL の chat 行は 1行=1単位で足す", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
      VALUES ('t1','s1',4), ('t1','s2',2);

      -- 会話s1に3リクエスト、会話s2に2リクエスト → 会話は2件
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, plan_multiplier, created_at)
      VALUES
        ('t1','r1','chat','s1', 1.25, '2026-03-05'),
        ('t1','r2','chat','s1', 1.25, '2026-03-05'),
        ('t1','r3','chat','s1', 1.25, '2026-03-05'),
        ('t1','r4','chat','s2', 1.25, '2026-03-06'),
        ('t1','r5','chat','s2', 1.25, '2026-03-06');

      -- session_id が NULL の chat 行(migration適用前の既存行)は 1行=1単位
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','r6','chat', 1.25, '2026-03-07'), ('t1','r7','chat', 1.25, '2026-03-07');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "standard");
    // 会話2件 + session_idなしの2行 = 4。リクエスト数(7)ではないことが本旨。
    expect(result.textUnits).toBe(4);
    expect(result.totalRequests).toBe(7);
  });

  it("textUnits は message_count < 2 の会話(ウィジェットを開いただけ)を数えない", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
      VALUES ('t1','open-only',0), ('t1','no-reply',1), ('t1','real',2);

      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, plan_multiplier, created_at)
      VALUES
        ('t1','r1','chat','open-only', 1.25, '2026-03-05'),
        ('t1','r2','chat','no-reply',  1.25, '2026-03-05'),
        ('t1','r3','chat','real',      1.25, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "standard");
    expect(result.textUnits).toBe(1);
  });

  it("avatarMinutes は avatar(ミリ秒)と anam_session(秒)を分に切り上げて合算する", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, plan_multiplier, created_at)
      VALUES
        ('t1','a1','avatar', 90000,  1.25, '2026-03-05'),   -- 90秒  → 2分
        ('t1','a2','avatar', 600000, 1.25, '2026-03-06');   -- 600秒 → 10分

      INSERT INTO usage_logs (tenant_id, request_id, feature_used, anam_session_seconds, plan_multiplier, created_at)
      VALUES ('t1','a3','anam_session', 61, 1.25, '2026-03-07');  -- 61秒 → 2分
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "standard");
    expect(result.avatarMinutes).toBe(14);
    // 「回数」で数えると3。時間に比例する原価を回数で請求しない(禁止56)。
    expect(result.avatarMinutes).not.toBe(3);
  });

  it("次元が混ざらない: テキストの会話がアバター分に、アバターがテキストに入らない", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',2);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, plan_multiplier, created_at)
      VALUES ('t1','r1','chat','s1', 1.25, '2026-03-05');
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, plan_multiplier, created_at)
      VALUES ('t1','a1','avatar', 300000, 1.25, '2026-03-05');  -- 5分
      -- voice はどちらの次元でもない(基本料に含まれる扱い)
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','v1','voice', 1.25, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "standard");
    expect(result.textUnits).toBe(1);
    expect(result.avatarMinutes).toBe(5);
  });

  it("billable=false の行は次元別数量にも入らない", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',2);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, plan_multiplier, billable, created_at)
      VALUES ('t1','r1','chat','s1', 1.25, false, '2026-03-05');
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, plan_multiplier, billable, created_at)
      VALUES ('t1','a1','avatar', 300000, 1.25, false, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "standard");
    expect(result.textUnits).toBe(0);
    expect(result.avatarMinutes).toBe(0);
  });

  // PR-6(2026-08-25 収益監査): SCRIPTS/ci-billing-schema.sh の FILES 配列と
  // schemaHealth.ts の REQUIRED_COLUMNS が食い違うと、CI は緑のまま本番だけ
  // 列が欠落する事故が起きる(stripe_webhook_events で実際に発生していた)。
  // ci-billing-schema.sh が作った実DBに対して REQUIRED_COLUMNS を直接照合し、
  // 2つの情報源が同期していることを実行時に固定する。
  it("ci-billing-schema.sh が作るテーブルは schemaHealth.ts の REQUIRED_COLUMNS を全て満たす", async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [Object.keys(BILLING_REQUIRED_COLUMNS)]
    );
    const actual = new Map<string, Set<string>>();
    for (const r of rows.rows) {
      const set = actual.get(r.table_name) ?? new Set<string>();
      set.add(r.column_name);
      actual.set(r.table_name, set);
    }
    const missing = findMissingColumns(actual, BILLING_REQUIRED_COLUMNS);
    expect(missing).toEqual([]);
  });
});
