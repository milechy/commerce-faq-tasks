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
import { countFreeAdBillableConversations, countFreeAdBillableRequests } from "../../api/chat/route";
import { countFreeAdAdminConsults, reserveAdminConsultSlotIfWithinLimit } from "../../api/admin/agent/agentRoutes";
import { initUsageTracker, trackUsage } from "./usageTracker";
import { calculateBaseCostCents, calculateBillingAmountCents } from "./costCalculator";
import { MARGIN_MULTIPLIER } from "./costCalculator";
import { fetchTenantEconomics, _clearEconomicsCache, type BillingSnapshotFn } from "./tenantEconomics";

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
      // 管理AI(admin_agent等)の行をこのフィクスチャに一切投入していないため 0。
      // admin_units CTE(session_id, JST暦日単位)自体の検証は下の
      // 「管理AIへの相談(admin_units)」ブロックで別途行う。
      adminConsults: 0,
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
      adminConsults: 0, // 行が無いので admin_units / row_units とも0
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

  it("LB-3: Starterの billedQuantity は480(¥9,600)で頭打ちになるが、billableUnitsは実数のまま残る", async () => {
    // 600会話 = ¥12,000相当だが、Standard(¥9,800)を上回らないよう480で丸める。
    // サービス自体は止まらないことの確認として billableUnits は実数(600)のままにする。
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
      SELECT 't1', 's-' || g, 2 FROM generate_series(1, 600) AS g
    `);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      SELECT 't1', 'r-' || g, 's-' || g, 'chat', 1.0, '2026-03-05' FROM generate_series(1, 600) AS g
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(600);
    expect(result.billedQuantity).toBe(480);
  });

  it("LB-3: Starterでも480会話未満なら丸めずそのまま請求する(境界の直前)", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
      SELECT 't1', 's-' || g, 2 FROM generate_series(1, 479) AS g
    `);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      SELECT 't1', 'r-' || g, 's-' || g, 'chat', 1.0, '2026-03-05' FROM generate_series(1, 479) AS g
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(479);
    expect(result.billedQuantity).toBe(479);
  });

  it("LB-3: 上限はStarter専用。Growthは同じ会話数でも丸めない(込み枠プランの超過を静かに握りつぶさない)", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
      SELECT 't1', 's-' || g, 2 FROM generate_series(1, 600) AS g
    `);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      SELECT 't1', 'r-' || g, 's-' || g, 'chat', 1.5, '2026-03-05' FROM generate_series(1, 600) AS g
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.billableUnits).toBe(600);
    expect(result.billedQuantity).toBe(900); // 600 * 1.5、480での丸めなし
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

  // ───────────────────────────────────────────────────────────────────────────
  // [A2A-1a] agent_search(外部エージェント連携API)。usageTracker.ts の
  // FeatureUsed コメント: 'chat' から 'agent_search' へ分離した際、この
  // text_units 集計SQLへ追加し忘れると Growth/Standard の agent_search 利用分が
  // Stripe請求から丸ごと消える。ここではモックDBではなく実Postgresに対して
  // computeExpectedBilling() を実行し、SQL文の `feature_used IN ('chat',
  // 'agent_search')` が退行したら直接落ちるようにする
  // (stripeSync.test.ts はDBをモックしてtext_unitsを決め打ちで返すため、
  // SQL自体の集計ロジックはここでしか検証できない)。
  //
  // ★このスイートを動かすには CHECK 制約に agent_search が必要★
  // SCRIPTS/ci-billing-schema.sh の FILES に migration_agent_search_feature.sql を
  // 追加済み(=「migration適用後」の状態を検証する)。本番はまだ未適用のままで、
  // その状態でのtrackUsage側の挙動(INSERT失敗時に何が起きるか)は
  // usageTracker.test.ts が別途固定している。
  // ───────────────────────────────────────────────────────────────────────────
  it("agent_search単独の利用が textUnits に乗る(session_idを持たないため1行=1単位)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      SELECT 't1', 'as'||g, 'agent_search', 1.5, '2026-03-05'::timestamptz FROM generate_series(1,3) g;
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.textUnits).toBe(3);
    // avatar 次元には一切乗らない(次元が混ざらない)
    expect(result.avatarMinutes).toBe(0);
  });

  it("chat(会話)とagent_searchが混在しても合算される(片方だけ数える退行を検知)", async () => {
    await insertSession("t1", "s-1", 4);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','c1','s-1','chat', 1.5, '2026-03-05'),
        ('t1','c2','s-1','chat', 1.5, '2026-03-05');
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','as1','agent_search', 1.5, '2026-03-06'),
        ('t1','as2','agent_search', 1.5, '2026-03-06');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    // chatは会話1件 + agent_search 2行 = 3。
    // 'chat'しか数えない退行なら1、'agent_search'しか数えない退行なら2になる
    // (どちらの片落ちも検知できるよう、両方が非ゼロの構成にしてある)。
    expect(result.textUnits).toBe(3);
    expect(result.textUnits).not.toBe(1); // agent_search が抜け落ちた場合の値
    expect(result.textUnits).not.toBe(2); // chat が抜け落ちた場合の値
  });

  it("agent_searchはbilledQuantity(加重合計・純従量経路)にも通常どおり乗る(billable=trueのまま)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','as1','agent_search', 1.0, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "starter");
    expect(result.billableUnits).toBe(1);
    expect(result.billedQuantity).toBe(1);
    expect(result.totalRequests).toBe(1);
  });

  it("agent_searchがbillable=falseで記録された場合はtextUnits/billedQuantityどちらにも乗らない(billable設計を壊していないことの対照)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, plan_multiplier, billable, created_at)
      VALUES ('t1','as1','agent_search', 1.0, false, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.textUnits).toBe(0);
    expect(result.billedQuantity).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 管理AIへの相談(admin_units) — 課金の第3次元(docs/ADMIN_AGENT_COST_REQUIREMENTS.md)。
  //
  // `DISTINCT ON (r.session_id, (r.created_at AT TIME ZONE 'Asia/Tokyo')::date)` は
  // AT TIME ZONE と DISTINCT ON の実挙動に依存するため、モックDBでは一切検証できない
  // (CLAUDE.md 禁止16「本番でのみズレ、数値はもっともらしく出る」の典型)。ここでは
  // 実Postgresに対して実行し、特にJST暦日の境界(UTCで数えると壊れる形)を固定する。
  // ───────────────────────────────────────────────────────────────────────────
  it("同一session_idの管理AI相談が同じJST暦日に3件あれば1単位(ターン数ではなく相談数)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','m1','copilot-1','admin_agent', 1.5, '2026-03-10 09:00:00+00'),
        ('t1','m2','copilot-1','admin_agent', 1.5, '2026-03-10 10:00:00+00'),
        ('t1','m3','copilot-1','admin_agent', 1.5, '2026-03-10 11:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    // 3ターンだが同一相談として1単位。ターン単位で数えると3になる(課題C: 長く
    // 相談するほど高くなると、Copilot UIの利用そのものを避けさせてしまう)。
    expect(result.adminConsults).toBe(1);
    expect(result.billableUnits).toBe(1);
    expect(result.billedQuantity).toBe(2); // ceil(1単位 × 1.5)
  });

  it("同一session_idでもJST暦日が違えば2単位(日をまたぐと別の相談)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','m1','copilot-1','admin_agent', 1.0, '2026-03-10 09:00:00+00'),
        ('t1','m2','copilot-1','admin_agent', 1.0, '2026-03-11 09:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.adminConsults).toBe(2);
  });

  // ★本命の検査★ UTC暦日では同じ2026-03-02のままだが、JSTでは03-02→03-03を
  // またぐペア。UTC基準で数えていたら1になる(=このテストがそれを検知する)。
  it("JST暦日の境界をまたぐと、UTC上は同じ日でも別の相談として数える(AT TIME ZONEの向きの検査)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','m1','copilot-1','admin_agent', 1.0, '2026-03-02T14:30:00Z'), -- JST 2026-03-02 23:30
        ('t1','m2','copilot-1','admin_agent', 1.0, '2026-03-02T15:30:00Z')  -- JST 2026-03-03 00:30
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.adminConsults).toBe(2);
    expect(result.adminConsults).not.toBe(1); // UTC暦日で数えた場合に出る誤った値
  });

  it("session_idがNULLの管理AI行(配線前の既存行)は1行=1単位でrow_units側に残り、adminConsultsに合流する(黙って請求から消えない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','m1', NULL, 'admin_agent', 1.0, '2026-03-05'),
        ('t1','m2', NULL, 'admin_agent', 1.0, '2026-03-05')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.adminConsults).toBe(2);
    expect(result.billableUnits).toBe(2);
  });

  it("session_idを持つ管理AI行はrow_units側で二重計上されない(admin_unitsとの合算がそのまま件数になる)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        -- 相談A: 同日3ターン → 1単位
        ('t1','a1','copilot-a','admin_agent', 1.0, '2026-03-05 09:00:00+00'),
        ('t1','a2','copilot-a','admin_agent', 1.0, '2026-03-05 10:00:00+00'),
        ('t1','a3','copilot-a','admin_agent', 1.0, '2026-03-05 11:00:00+00'),
        -- 相談B(別session_id): 1ターン → 1単位
        ('t1','b1','copilot-b','admin_agent', 1.0, '2026-03-06 09:00:00+00'),
        -- session_idなしの既存行 → 1行=1単位
        ('t1','c1', NULL,       'admin_agent', 1.0, '2026-03-07 09:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    // A(1) + B(1) + legacy(1) = 3。二重計上ならA単体で3(row_unitsにも残る)になり
    // 合計が5以上に膨らむ。
    expect(result.adminConsults).toBe(3);
    expect(result.billableUnits).toBe(3);
    expect(result.totalRequests).toBe(5); // 原価可視化の生リクエスト数は畳まない
  });

  it("管理AIの相談も月の半開区間で数える(月またぎを二重計上・取りこぼししない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','before','admin-before','admin_agent', 1.0, '2026-02-28 23:59:59+00'),
        ('t1','start','admin-start',  'admin_agent', 1.0, '2026-03-01 00:00:00+00'),
        ('t1','end','admin-end',      'admin_agent', 1.0, '2026-03-31 23:59:59+00'),
        ('t1','after','admin-after',  'admin_agent', 1.0, '2026-04-01 00:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    // start・end のみ(before/afterは対象月の外)。session_idが異なるので各1単位。
    expect(result.adminConsults).toBe(2);
  });

  it("相談内でplan_multiplierが割れたら、その相談(session_id, JST暦日)内で最初の行(created_at昇順)の倍率を採る", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES
        ('t1','m2','copilot-1','admin_agent', 2.5, '2026-03-05 10:05:00+00'),
        ('t1','m1','copilot-1','admin_agent', 1.0, '2026-03-05 10:00:00+00')
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    // 相談開始時点は倍率1.0。後から倍率が上がっても遡って高くならない。
    expect(result.adminConsults).toBe(1);
    expect(result.billedQuantity).toBe(1); // ceil(1 * 1.0)、2.5だとceil(2.5)=3になる
  });

  it("次元が混ざらない: 管理AIの相談がテキスト会話数(textUnits)やアバター分数(avatarMinutes)に入らない", async () => {
    await insertSession("t1", "s-1", 2);
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','c1','s-1','chat', 1.0, '2026-03-05');
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('t1','m1','copilot-1','admin_agent', 1.0, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.textUnits).toBe(1);
    expect(result.avatarMinutes).toBe(0);
    expect(result.adminConsults).toBe(1);
  });

  it("billable=falseの管理AI行はadminConsultsにもbilledQuantityにも入らない", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, billable, created_at)
      VALUES ('t1','m1','copilot-1','admin_agent', 1.0, false, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.adminConsults).toBe(0);
    expect(result.billedQuantity).toBe(0);
  });

  it("他テナントの管理AI相談は数えない(テナント境界)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, created_at)
      VALUES ('other','m1','copilot-1','admin_agent', 1.0, '2026-03-05');
    `);

    const result = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    expect(result.adminConsults).toBe(0);
  });

  it("管理AIの相談も絶対値の再計算は冪等(同じ入力で何度呼んでも同じ値)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, plan_multiplier, billing_status, created_at)
      VALUES
        ('t1','m1','copilot-1','admin_agent', 1.0, 'reported', '2026-03-05 09:00:00+00'),
        ('t1','m2','copilot-1','admin_agent', 1.0, 'pending',  '2026-03-05 10:00:00+00')
    `);

    const first  = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");
    const second = await computeExpectedBilling(db, "t1", "2026-03-01", "2026-04-01", "growth");

    expect(second).toEqual(first);
    expect(first.adminConsults).toBe(1);
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

// ---------------------------------------------------------------------------
// UX-D(2026-08-26): free_ad の月次上限判定(会話数)の集計SQLを実Postgresで検証する。
//
// route.freeAdQuota.test.ts はモックDBで「返ってきた数値」しか固定できず、この
// クエリ特有のJOIN条件・DISTINCT ONの意味論は実行してみないと壊れていても
// 気づけない(上のcomputeExpectedBillingセクションと同じ理由)。
// ---------------------------------------------------------------------------

d("countFreeAdBillableConversations（実 Postgres に対する free_ad 会話数集計）", () => {
  let db: Pool;

  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE usage_logs, stripe_usage_reports, stripe_subscriptions, chat_sessions RESTART IDENTITY CASCADE"
    );
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, plan) VALUES ('t1', 't1', 'free_ad'), ('other', 'other', 'free_ad')`
    );
  });

  const RANGE = ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"].map((s) => new Date(s)) as [Date, Date];

  it("1往復以上(message_count>=2)の会話は、行数に関わらず1件と数える", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',6);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      SELECT 't1', 'r'||g, 'chat', 's1', '2026-03-05'::timestamptz FROM generate_series(1,6) g;
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(1);
  });

  it("message_count=1(開いただけ・応答なし)の会話は数えない", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',1);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      VALUES ('t1','r1','chat','s1', '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0);
  });

  it("message_count=0(ウィジェットを開いただけ)の会話は数えない", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',0);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      VALUES ('t1','r1','chat','s1', '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0);
  });

  // computeExpectedBillingのconversation_unitsと同じfail-safeの向き:
  // 削除済み・記録漏れは「1往復未満と確認できなかった」として数える側に倒す。
  it("対応する chat_sessions 行が無い会話は数える(削除・記録漏れをfail-safeで拾う)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      VALUES ('t1','r1','chat','s-deleted', '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(1);
  });

  it("session_id が NULL の既存行(migration適用前)は1行=1単位で数える(黙って枠から消さない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, created_at)
      SELECT 't1', 'r'||g, 'chat', '2026-03-05'::timestamptz FROM generate_series(1,3) g;
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(3);
  });

  it("billable=false の行は数えない(社内テスト等が無料枠を消費しない)", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',2);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, billable, created_at)
      VALUES ('t1','r1','chat','s1', false, '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0);
  });

  it("chat以外(avatar等)の行は数えない", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, created_at)
      VALUES ('t1','a1','avatar', 60000, '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0);
  });

  // chat_sessionsの業務キーは(tenant_id, session_id)の複合。他テナントの
  // 同名session_idのmessage_countで課金可否が決まってはならない。
  it("他テナントの同名 session_id の message_count に影響されない", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',1), ('other','s1',10);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      VALUES ('t1','r1','chat','s1', '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0); // t1側はmessage_count=1なので数えない(otherの10に引っ張られない)
  });

  it("他テナントの会話は数えない(テナント境界)", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('other','s1',5);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      VALUES ('other','r1','chat','s1', '2026-03-05');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0);
  });

  it("期間の境界は半開区間(月またぎを二重計上・取りこぼししない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, created_at)
      VALUES
        ('t1','before','chat', '2026-02-28 23:59:59+00'),
        ('t1','start','chat', '2026-03-01 00:00:00+00'),
        ('t1','end','chat', '2026-03-31 23:59:59+00'),
        ('t1','after','chat', '2026-04-01 00:00:00+00');
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(2); // start・end のみ(session_id無しなので1行=1単位)
  });

  it("複数の異なる会話を正しく合算する(1往復以上2件 + 開いただけ1件除外 + legacy1行)", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
        VALUES ('t1','s1',2), ('t1','s2',4), ('t1','s3',1);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at) VALUES
        ('t1','r1','chat','s1','2026-03-05'),
        ('t1','r2','chat','s1','2026-03-05'),
        ('t1','r3','chat','s2','2026-03-06'),
        ('t1','r4','chat','s3','2026-03-07'), -- message_count=1、数えない
        ('t1','r5','chat',NULL,'2026-03-08'); -- legacy行、1単位
    `);
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(3); // s1 + s2 + legacy(r5)
  });

  it("利用が無い月は0を返し、例外を投げない", async () => {
    const count = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    expect(count).toBe(0);
  });
});

// P0-4バックストップ(2026-08-26レビュー): countFreeAdBillableConversationsが
// session_id・message_countでグルーピングするのに対し、こちらはsession_idを
// 一切信用しない生のusage_logs行数(=生リクエスト数)を数える。「常に新規の
// ランダムsession_id+単発メッセージ」という会話ベースの上限をすり抜ける
// パターンでも、このクエリでは1行=1件として素直に積み上がることを実DBで固定する。
d("countFreeAdBillableRequests（実 Postgres に対する P0-4 生リクエスト数バックストップ集計）", () => {
  let db: Pool;

  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE usage_logs, stripe_usage_reports, stripe_subscriptions, chat_sessions RESTART IDENTITY CASCADE"
    );
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, plan) VALUES ('t1', 't1', 'free_ad'), ('other', 'other', 'free_ad')`
    );
  });

  const RANGE = ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"].map((s) => new Date(s)) as [Date, Date];

  it("常に新規のsession_id+単発メッセージ(message_count=1)でも、会話数集計とは異なり1行=1件として数える", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count)
        VALUES ('t1','s1',1), ('t1','s2',1), ('t1','s3',1);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at) VALUES
        ('t1','r1','chat','s1','2026-03-05'),
        ('t1','r2','chat','s2','2026-03-06'),
        ('t1','r3','chat','s3','2026-03-07');
    `);
    // countFreeAdBillableConversationsなら message_count=1 は3件とも0件扱いだが、
    // こちらは会話グルーピングを一切見ないため3件になる(=バックストップが機能する)。
    const conversationCount = await countFreeAdBillableConversations(db, "t1", ...RANGE);
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(conversationCount).toBe(0);
    expect(requestCount).toBe(3);
  });

  it("1つの会話に複数メッセージがあれば、その行数分をそのまま数える(会話単位にまとめない)", async () => {
    await db.query(`
      INSERT INTO chat_sessions (tenant_id, session_id, message_count) VALUES ('t1','s1',6);
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, session_id, created_at)
      SELECT 't1', 'r'||g, 'chat', 's1', '2026-03-05'::timestamptz FROM generate_series(1,6) g;
    `);
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(requestCount).toBe(6); // countFreeAdBillableConversationsなら1件
  });

  it("billable=false の行は数えない", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, billable, created_at)
      VALUES ('t1','r1','chat', false, '2026-03-05');
    `);
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(requestCount).toBe(0);
  });

  it("chat以外(avatar等)の行は数えない", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, avatar_session_ms, created_at)
      VALUES ('t1','a1','avatar', 60000, '2026-03-05');
    `);
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(requestCount).toBe(0);
  });

  it("他テナントの行は数えない(テナント境界)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, created_at)
      VALUES ('other','r1','chat','2026-03-05');
    `);
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(requestCount).toBe(0);
  });

  it("期間の境界は半開区間(月またぎを二重計上・取りこぼししない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, feature_used, created_at)
      VALUES
        ('t1','before','chat', '2026-02-28 23:59:59+00'),
        ('t1','start','chat', '2026-03-01 00:00:00+00'),
        ('t1','end','chat', '2026-03-31 23:59:59+00'),
        ('t1','after','chat', '2026-04-01 00:00:00+00');
    `);
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(requestCount).toBe(2); // start・end のみ
  });

  it("利用が無い月は0を返し、例外を投げない", async () => {
    const requestCount = await countFreeAdBillableRequests(db, "t1", ...RANGE);
    expect(requestCount).toBe(0);
  });
});

// countFreeAdAdminConsults(agentRoutes.ts, S7: free_ad の管理AI月次上限)の実DB回帰。
//
// ★このテストが守っている事故★ この関数は admin_units CTE(stripeSync.ts)と同じ
// 「(session_id, JST暦日)のDISTINCT」を数えるが、実装がSQL側の
// `(created_at AT TIME ZONE 'Asia/Tokyo')::date` と、JS側の
// shiftToJstWallClock(now)+文字列整形という**2つの別々の実装**で「今日(JST)」を
// 計算し、`jst_date = $6::date` で突き合わせている。この2つが1箇所でも食い違うと、
// 「今日まだ相談していないか」の判定(countedToday)が実際のJST日と無関係な
// UTC日基準になり得る(CLAUDE.md 禁止16と同種)。stripeSync.ts の admin_units は
// Gate 4 で実Postgres検証済みだが、この関数は別実装のため未検証だった
// (mockのdb.queryでしか実行されたことがない)。
d("countFreeAdAdminConsults（実 Postgres に対する管理AI月次上限の判定SQL）", () => {
  let db: Pool;

  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE usage_logs, stripe_usage_reports, stripe_subscriptions, chat_sessions RESTART IDENTITY CASCADE"
    );
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, plan) VALUES ('t1', 't1', 'free_ad'), ('other', 'other', 'free_ad')`
    );
  });

  const RANGE_START = "2026-03-01T00:00:00Z";

  // JST(UTC+9)は UTC 16:00〜翌23:59 の間に日付が変わる。UTC暦日をそのまま使う
  // (シフト忘れの)バグだと、この時間帯のcreated_atだけ判定を取り違える。
  it("★JST日付境界: UTC上は同じ日でも、JST 0時をまたぐと『今日』の判定が変わる(AT TIME ZONEの向きの検査)★", async () => {
    // 2026-03-02T16:00:00Z = JST 2026-03-03 01:00(UTC暦日はまだ03-02のまま)
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at)
      VALUES ('t1','r1','s1','admin_agent', true, '2026-03-02T16:00:00Z');
    `);

    // now も同じ瞬間(JST 2026-03-03 01:05)。正しく実装されていれば
    // 「s1は今日(JST 03-03)すでに相談済み」と判定される。
    const same = await countFreeAdAdminConsults(db, "t1", "s1", new Date("2026-03-02T16:05:00Z"));
    expect(same.countedToday).toBe(true);

    // now を1つ前のJST暦日(JST 2026-03-02 23:00 = UTC 2026-03-02T14:00:00Z)にすると、
    // s1の相談(JST 03-03)は「今日」ではなくなる。UTC暦日だけを見る実装だと
    // 両方とも'2026-03-02'のままになり、ここが誤って true になる。
    const dayBefore = await countFreeAdAdminConsults(db, "t1", "s1", new Date("2026-03-02T14:00:00Z"));
    expect(dayBefore.countedToday).toBe(false);
  });

  it("同一session_idの同日複数行は1件、別日なら2件(admin_unitsと同じ数え方)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at) VALUES
        ('t1','r1','s1','admin_agent', true, '2026-03-05T02:00:00Z'),
        ('t1','r2','s1','admin_agent', true, '2026-03-05T05:00:00Z'),
        ('t1','r3','s1','admin_agent', true, '2026-03-06T02:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(
      db, "t1", "s1", new Date(RANGE_START)
    );
    expect(count).toBe(2); // (s1,03-05) と (s1,03-06) の2組
  });

  it("同じ相談件数でもsession_idが違えば別々に数える", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at) VALUES
        ('t1','r1','s1','admin_agent', true, '2026-03-05T02:00:00Z'),
        ('t1','r2','s2','admin_agent', true, '2026-03-05T02:00:00Z'),
        ('t1','r3','s3','admin_agent', true, '2026-03-05T02:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(db, "t1", "sX", new Date(RANGE_START));
    expect(count).toBe(3);
  });

  it("chat(管理AI以外)の行は数えない(次元の分離)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at)
      VALUES ('t1','r1','s1','chat', true, '2026-03-05T02:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(db, "t1", "s1", new Date(RANGE_START));
    expect(count).toBe(0);
  });

  it("billable=falseの行は数えない", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at)
      VALUES ('t1','r1','s1','admin_agent', false, '2026-03-05T02:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(db, "t1", "s1", new Date(RANGE_START));
    expect(count).toBe(0);
  });

  it("session_idがNULLの行は数えない(この判定は月次上限のショートカットで、rowへのフォールバックは持たない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at)
      VALUES ('t1','r1',NULL,'admin_agent', true, '2026-03-05T02:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(db, "t1", "s1", new Date(RANGE_START));
    expect(count).toBe(0);
  });

  it("他テナントの相談は数えない(テナント境界)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at)
      VALUES ('other','r1','s1','admin_agent', true, '2026-03-05T02:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(db, "t1", "s1", new Date(RANGE_START));
    expect(count).toBe(0);
  });

  // ★JST暦月の境界であって、UTC暦月の境界ではない★
  // getMonthRangeJst は「JST 3/1 00:00」〜「JST 4/1 00:00」を返す。UTCでは
  // 2026-02-28T15:00:00Z 〜 2026-03-31T15:00:00Z にあたる(JST=UTC+9のため9時間分ずれる)。
  // countFreeAdBillableRequests 等(呼び出し元がUTC境界を直接渡す関数)の
  // 境界値をそのまま流用すると9時間分ずれた誤った境界を検査してしまう。
  it("期間の境界はJST暦月の半開区間(月またぎを二重計上・取りこぼししない)", async () => {
    await db.query(`
      INSERT INTO usage_logs (tenant_id, request_id, session_id, feature_used, billable, created_at) VALUES
        ('t1','before','s-before','admin_agent', true, '2026-02-28T14:59:59Z'),
        ('t1','start','s-start','admin_agent', true, '2026-02-28T15:00:00Z'),
        ('t1','end','s-end','admin_agent', true, '2026-03-31T14:59:59Z'),
        ('t1','after','s-after','admin_agent', true, '2026-03-31T15:00:00Z');
    `);
    const { count } = await countFreeAdAdminConsults(
      db, "t1", "s-none", new Date("2026-03-15T00:00:00Z")
    );
    expect(count).toBe(2); // start(JST 3/1 00:00)・end(JST 3/31 23:59:59) のみ
  });

  it("利用が無い月は0件・countedToday falseを返し、例外を投げない", async () => {
    const { count, countedToday } = await countFreeAdAdminConsults(
      db, "t1", "s1", new Date(RANGE_START)
    );
    expect(count).toBe(0);
    expect(countedToday).toBe(false);
  });

  // ★本命: check-then-act の隙間が実際に塞がっていることの証明★
  //
  // 単純に「SELECTしてから決める」実装だと、上限(30件)ぎりぎりで多数の
  // リクエストが同時に届いた場合、全員が同じ「まだ29件」を読んで素通りし、
  // 実際の合計が30を大きく超えてしまう(連打・複数タブでの同時送信が典型)。
  // reserveAdminConsultSlotIfWithinLimit はテナント単位の pg_advisory_lock で
  // 「数える→予約行を書く」を直列化しているため、Promise.all で本当に同時に
  // 35件送っても、通過するのはちょうど30件になるはず。
  //
  // real Postgres でしか意味を持たない検証(モックDBは呼び出しを並行実行しても
  // 実際には直列にキューされるだけで、ロックの意味が無い)。
  it("★35件を本当に同時実行しても、通過するのはちょうど30件(上限超過が起きない)★", async () => {
    const now = new Date("2026-03-05T02:00:00Z"); // 全リクエスト同一のJST暦日
    const results = await Promise.all(
      Array.from({ length: 35 }, (_, i) =>
        reserveAdminConsultSlotIfWithinLimit(db, "t1", `race-session-${i}`, now)
      )
    );

    const allowed = results.filter((r) => !r.blocked).length;
    const blocked = results.filter((r) => r.blocked).length;
    expect(allowed).toBe(30);
    expect(blocked).toBe(5);

    // 予約行(billable=true, cost=0)を含めて実際にDBへ書かれた件数も30件ちょうど
    // であることを確認する(「判定は30件と返したが実は31件書き込まれていた」という
    // ロック漏れを、判定結果だけでなく実データでも検知する)。
    const { count: actualCount } = await countFreeAdAdminConsults(db, "t1", "race-session-none", now);
    expect(actualCount).toBe(30);
  });

  it("同一session_idへの同時複数リクエストは、予約行が1件に収束し重複しない(2重クリック・複数タブ)", async () => {
    const now = new Date("2026-03-05T02:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveAdminConsultSlotIfWithinLimit(db, "t1", "double-click-session", now)
      )
    );
    // 同一(session, 今日)は「今日まだ相談していないか」の判定こそ各回で走るが、
    // 予約行自体は request_id が決定的(session×JST暦日)なので ON CONFLICT で1行に収束する。
    expect(results.every((r) => !r.blocked)).toBe(true);

    const { count } = await countFreeAdAdminConsults(db, "t1", "none", now);
    expect(count).toBe(1); // 5回同時に叩いても1相談として数えられる
  });
});

// stripeWebhook.ts の _handleCheckoutSessionCompleted が発行するINSERT文の実DB回帰。
// 2026-08-26 レビュー是正: 以前は stripe_price_id に NULL を挿入しており、
// migration.sql の TEXT NOT NULL 制約に違反して新規INSERT・ON CONFLICT更新の
// 両経路とも必ず失敗し、セルフサービス決済が一度も記録されない事故になっていた。
// stripeWebhook.test.ts はモックDBのためNOT NULL制約を検証できず、この事故を
// 4PR分のレビューで検出できなかった(禁止51と同型)。ここでは実際のSQL文を
// (関数を呼ばず)そのまま実行し、スキーマ制約込みで検証する。
d("stripe_subscriptions INSERT（checkout.session.completed の実SQL回帰）", () => {
  let db: Pool;

  const UPSERT_SQL = `
    INSERT INTO stripe_subscriptions
       (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id        = EXCLUDED.stripe_price_id,
       is_active               = true,
       updated_at              = NOW()
     WHERE stripe_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
        OR NOT stripe_subscriptions.is_active
     RETURNING tenant_id`;

  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE stripe_subscriptions CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(`INSERT INTO tenants (id, name, plan) VALUES ('t1', 't1', 'growth')`);
  });

  it("新規INSERTは stripe_price_id が非NULLなら成功する(NOT NULL制約を満たす)", async () => {
    const result = await db.query(UPSERT_SQL, ["t1", "cus_1", "sub_1", "price_1"]);
    expect(result.rowCount).toBe(1);
    const row = (await db.query("SELECT * FROM stripe_subscriptions WHERE tenant_id = 't1'")).rows[0];
    expect(row.stripe_price_id).toBe("price_1");
    expect(row.is_active).toBe(true);
  });

  it("同一subscriptionの再配信(ON CONFLICT)は1行に収束し、price/customerを更新する", async () => {
    await db.query(UPSERT_SQL, ["t1", "cus_1", "sub_1", "price_1"]);
    const result = await db.query(UPSERT_SQL, ["t1", "cus_1_new", "sub_1", "price_2"]);
    expect(result.rowCount).toBe(1);
    const rows = (await db.query("SELECT * FROM stripe_subscriptions WHERE tenant_id = 't1'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_customer_id).toBe("cus_1_new");
    expect(rows[0].stripe_price_id).toBe("price_2");
  });

  it("既に別のアクティブなsubscriptionが記録済みなら上書きしない(rowCount=0、孤児防止)", async () => {
    await db.query(UPSERT_SQL, ["t1", "cus_1", "sub_1", "price_1"]);
    const result = await db.query(UPSERT_SQL, ["t1", "cus_2", "sub_2", "price_2"]);
    expect(result.rowCount).toBe(0);
    const row = (await db.query("SELECT * FROM stripe_subscriptions WHERE tenant_id = 't1'")).rows[0];
    // 先に記録された sub_1 のまま(上書きされていない)
    expect(row.stripe_subscription_id).toBe("sub_1");
  });

  it("既存行が is_active=false(解約済み)なら、別のsubscriptionでも上書きを許す(再契約)", async () => {
    await db.query(UPSERT_SQL, ["t1", "cus_1", "sub_1", "price_1"]);
    await db.query("UPDATE stripe_subscriptions SET is_active = false WHERE tenant_id = 't1'");
    const result = await db.query(UPSERT_SQL, ["t1", "cus_2", "sub_2", "price_2"]);
    expect(result.rowCount).toBe(1);
    const row = (await db.query("SELECT * FROM stripe_subscriptions WHERE tenant_id = 't1'")).rows[0];
    expect(row.stripe_subscription_id).toBe("sub_2");
    expect(row.is_active).toBe(true);
  });

  it("stripe_price_id に NULL を渡すと NOT NULL 制約違反で例外を投げる(退行の直接検知)", async () => {
    await expect(
      db.query(UPSERT_SQL, ["t1", "cus_1", "sub_1", null])
    ).rejects.toThrow(/null value in column "stripe_price_id"/);
  });
});

/**
 * trackUsage の INSERT を実スキーマに対して実行する。
 *
 * usageTracker.test.ts はDBをモックして「SQL文字列と引数」だけを見ているため、
 * 列が実在するか・プレースホルダ数が合っているかを一切検証できない。
 * この種の食い違いは 42703 でフォールバック経路に落ち、
 * 「記録は続くが原価だけ永久に NULL」という静かな事故になる
 * （migration 未適用による同型事故がこのリポジトリで既に2回起きている）。
 */
d("trackUsage の INSERT（実 Postgres・cost_base_cents の記録）", () => {
  let db: Pool;
  const silentLogger = {
    warn: () => {}, error: () => {}, debug: () => {}, info: () => {},
  } as never;

  /**
   * trackUsage は fire-and-forget かつ内部でプラン解決のDB往復を挟むため、
   * 固定回数の setImmediate では着地を待ちきれずフレークになる
   * （実際に3件目だけ落ちるのを観測した）。行が現れるまでポーリングする。
   */
  const waitForRow = async (requestId: string) => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.query(
        "SELECT 1 FROM usage_logs WHERE request_id = $1", [requestId]
      );
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`usage_logs に ${requestId} が現れなかった（INSERT が落ちている可能性）`);
  };

  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
    initUsageTracker(db, silentLogger);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE usage_logs CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(`INSERT INTO tenants (id, name, plan) VALUES ('t1', 't1', 'growth')`);
  });

  it("★フォールバックに落ちず主 INSERT が通り、cost_base_cents が実際に入る★", async () => {
    trackUsage({
      tenantId: "t1",
      requestId: "req-base-cost-1",
      model: "llama-3.1-8b-instant",
      inputTokens: 100_000,
      outputTokens: 50_000,
      featureUsed: "chat",
    });
    await waitForRow("req-base-cost-1");

    const { rows } = await db.query(
      `SELECT cost_base_cents, cost_total_cents, plan, plan_multiplier
         FROM usage_logs WHERE request_id = 'req-base-cost-1'`
    );
    expect(rows).toHaveLength(1);

    // NULL なら「列はあるがフォールバック経路で書かれた」ことを意味する。
    expect(rows[0].cost_base_cents).not.toBeNull();
    // plan/plan_multiplier も入っている = 主 INSERT が通った証拠
    // （42703 フォールバックはこの2列を書かない）。
    expect(rows[0].plan).toBe("growth");

    const expectedBase = calculateBaseCostCents({
      model: "llama-3.1-8b-instant", inputTokens: 100_000, outputTokens: 50_000, featureUsed: "chat",
    });
    expect(rows[0].cost_base_cents).toBe(expectedBase);
  });

  it("マージン前なので cost_total_cents 以下になる（粗利が原価割れしない）", async () => {
    trackUsage({
      tenantId: "t1",
      requestId: "req-base-cost-2",
      model: "llama-3.1-8b-instant",
      inputTokens: 200_000,
      outputTokens: 100_000,
      featureUsed: "chat",
    });
    await waitForRow("req-base-cost-2");

    const { rows } = await db.query(
      `SELECT cost_base_cents, cost_total_cents FROM usage_logs WHERE request_id = 'req-base-cost-2'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_base_cents).toBeLessThanOrEqual(rows[0].cost_total_cents);
  });

  it("管理系機能(margin=1)では原価と請求額が一致する", async () => {
    trackUsage({
      tenantId: "t1",
      requestId: "req-base-cost-3",
      model: "llama-3.1-8b-instant",
      inputTokens: 100_000,
      outputTokens: 50_000,
      featureUsed: "admin_tuning",
    });
    await waitForRow("req-base-cost-3");

    const { rows } = await db.query(
      `SELECT cost_base_cents, cost_total_cents FROM usage_logs WHERE request_id = 'req-base-cost-3'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_base_cents).toBe(rows[0].cost_total_cents);
    expect(rows[0].cost_total_cents).toBe(
      calculateBillingAmountCents({
        model: "llama-3.1-8b-instant", inputTokens: 100_000, outputTokens: 50_000, featureUsed: "admin_tuning",
      })
    );
  });
});

/**
 * 原価導出SQL(BASE_COST_EXPR)を実 Postgres で検証する。
 *
 * この式は CASE / GREATEST / CEIL / FILTER を組み合わせており、
 * TypeScript のユニットテストでは一行も実行されない。
 * ここが間違っていると粗利が黙って MARGIN_MULTIPLIER 倍ずれる。
 */
d("tenantEconomics の原価導出（実 Postgres）", () => {
  let db: Pool;

  // 売上側は本テストの対象外なので固定値を返すスタブを注入する
  // （売上の正しさは computeExpectedBilling 側のテストで担保済み）。
  const stubSnapshot: BillingSnapshotFn = async () => ({
    plan: "growth", textUnits: 0, avatarMinutes: 0, revenueEstimateJpy: 100_000,
  });

  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    _clearEconomicsCache();
    await db.query("TRUNCATE usage_logs CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(`INSERT INTO tenants (id, name, plan) VALUES ('t1','t1','growth')`);
  });

  /** 2026-09 の JST 暦月に確実に入る時刻。 */
  const IN_SEPT = "2026-09-15T00:00:00Z";

  const insertRow = (o: {
    id: string; feature: string | null; total: number; llm: number;
    base: number | null; billable?: boolean;
  }) =>
    db.query(
      `INSERT INTO usage_logs
         (tenant_id, request_id, feature_used, cost_total_cents, cost_llm_cents,
          cost_base_cents, billable, created_at)
       VALUES ('t1', $1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [o.id, o.feature, o.total, o.llm, o.base, o.billable ?? true, IN_SEPT]
    );

  const baseCostOf = async () => {
    const res = await fetchTenantEconomics(db, "202609", stubSnapshot);
    return res.tenants[0]!;
  };

  it("①記録済み: cost_base_cents をそのまま使う（逆算しない）", async () => {
    // total=5000 だが base=777 が実測されているので 777 を採るべき
    await insertRow({ id: "r1", feature: "chat", total: 5000, llm: 100, base: 777 });
    const row = await baseCostOf();
    expect(row.cost_base_usd_cents).toBe(777);
    expect(row.estimation_method).toBe("recorded");
  });

  it("②未記録 + end-user機能: cost_total_cents をマージンで割り戻す", async () => {
    const total = 1000;
    await insertRow({ id: "r2", feature: "chat", total, llm: 10, base: null });
    const row = await baseCostOf();
    expect(row.cost_base_usd_cents).toBe(Math.ceil(total / MARGIN_MULTIPLIER));
    expect(row.estimation_method).toBe("derived");
  });

  it("③未記録 + 管理系機能: margin=1 で記録されているので割り戻さない", async () => {
    // admin_tuning は NON_BILLABLE かつ margin=1。割り戻すと原価を 1/margin に過小評価する。
    await insertRow({ id: "r3", feature: "admin_tuning", total: 1000, llm: 10, base: null, billable: false });
    const row = await baseCostOf();
    expect(row.cost_nonbillable_usd_cents).toBe(1000);
  });

  it("★④未記録 + marginOverride:1 の行: cost_llm_cents の下限クランプが救う★", async () => {
    // marginOverride:1 で書かれた end-user 機能の行。total は原価そのもの(margin=1)。
    // 素朴に割り戻すと total/margin まで落ちるが、cost_llm_cents はマージン非適用の
    // 実原価なので「真の原価の厳密な下限」として GREATEST が拾い上げる。
    const total = 1000;
    const llm = 900;
    await insertRow({ id: "r4", feature: "chat", total, llm, base: null });
    const row = await baseCostOf();
    const naive = Math.ceil(total / MARGIN_MULTIPLIER);
    expect(naive).toBeLessThan(llm);              // 素朴な割り戻しは過小
    expect(row.cost_base_usd_cents).toBe(llm);    // クランプが効いている
  });

  it("★feature_used は NOT NULL（原価導出に NULL 分岐を置かない根拠）★", async () => {
    // calculateBillingAmountCents は featureUsed === undefined を end-user 扱いするが、
    // DB 側は NOT NULL なのでその分岐は到達しない。BASE_COST_EXPR から
    // NULL 分岐を外している根拠がこれ。制約が外れたらこのテストが落ちて気づける。
    await expect(
      insertRow({ id: "r5", feature: null, total: 1000, llm: 0, base: null })
    ).rejects.toThrow(/not-null|null value/i);

    const { rows } = await db.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'usage_logs' AND column_name = 'feature_used'`
    );
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("billable=false の原価は粗利の分子から外れ、別枠で出る", async () => {
    await insertRow({ id: "r6", feature: "chat", total: 500, llm: 0, base: 500 });
    await insertRow({ id: "r7", feature: "sai_agent", total: 300, llm: 0, base: 300, billable: false });
    const row = await baseCostOf();
    expect(row.cost_base_usd_cents).toBe(500);
    expect(row.cost_nonbillable_usd_cents).toBe(300);
  });

  it("記録済みと未記録が混在すると mixed になる（移行期を隠さない）", async () => {
    await insertRow({ id: "r8", feature: "chat", total: 1000, llm: 0, base: 200 });
    await insertRow({ id: "r9", feature: "chat", total: 1000, llm: 0, base: null });
    const row = await baseCostOf();
    expect(row.estimation_method).toBe("mixed");
    expect(row.recorded_row_ratio).toBe(0.5);
    expect(row.cost_base_usd_cents).toBe(200 + Math.ceil(1000 / MARGIN_MULTIPLIER));
  });

  it("★JST 暦月の境界: 9/1 00:00 JST の直前直後で月が分かれる★", async () => {
    // 2026-08-31 23:59 JST = 2026-08-31T14:59Z → 8月扱い
    // 2026-09-01 00:01 JST = 2026-08-31T15:01Z → 9月扱い
    await db.query(
      `INSERT INTO usage_logs (tenant_id, request_id, feature_used, cost_total_cents, cost_base_cents, billable, created_at)
       VALUES ('t1','aug','chat',9999,111,true,'2026-08-31T14:59:00Z'::timestamptz),
              ('t1','sep','chat',9999,222,true,'2026-08-31T15:01:00Z'::timestamptz)`
    );
    const sep = await baseCostOf();
    expect(sep.cost_base_usd_cents).toBe(222);   // 8月の行は入らない

    _clearEconomicsCache();
    const augRes = await fetchTenantEconomics(db, "202608", stubSnapshot);
    expect(augRes.tenants[0]!.cost_base_usd_cents).toBe(111);
  });

  it("利用が無いテナントは一覧に出ない（Stripe への無駄な往復を作らない）", async () => {
    await db.query(`INSERT INTO tenants (id, name, plan) VALUES ('idle','idle','starter')`);
    await insertRow({ id: "r10", feature: "chat", total: 100, llm: 0, base: 100 });
    const res = await fetchTenantEconomics(db, "202609", stubSnapshot);
    expect(res.tenants.map((t) => t.tenant_id)).toEqual(["t1"]);
  });
});
