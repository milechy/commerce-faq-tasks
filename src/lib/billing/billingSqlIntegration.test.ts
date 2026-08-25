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

const DB_URL = process.env.BILLING_SQL_TEST_DATABASE_URL;

// env未設定時はスキップする(describe.skip ではなく it.skip 相当にするため
// describe 自体を切り替える。CIのPostgresジョブでのみ実行される)。
const d = DB_URL ? describe : describe.skip;

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
    await db.query("TRUNCATE usage_logs, stripe_usage_reports, stripe_subscriptions RESTART IDENTITY CASCADE");
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
});
