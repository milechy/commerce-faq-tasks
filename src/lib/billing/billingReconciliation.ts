/**
 * billingReconciliation — 月次の請求突合ジョブ(内部二者突合)。
 *
 * B-1(usage_logs.plan_multiplier の焼き付け)・C-2(累積set方式)は単体テストで
 * 検証済みだが、「実際に本番で正しく動き続けているか」はテストでは原理的に
 * 確認できない。ここでは各テナント・各期間について、usage_logs から
 * 期待請求量を都度まるごと再計算し、実際に stripe_usage_reports へ記録した
 * (=Stripeへ送ろうとした)値と突き合わせ、乖離を Slack へ通知する。
 *
 * ★スコープの限定★
 * 当初は usage_logs 再計算・自己記録・Stripe実値の三者突合として設計したが、
 * `stripe.subscriptionItems.createUsageRecord` / `listUsageRecordSummaries` が
 * stripe-node v17.7.0(2025-02-24)で型定義から削除されていることが判明した
 * (Asana 1217808775593302で調査依頼中)。この API が本当に機能しているか自体が
 * 未検証のため、ここでは検証可能な「内部二者突合」(usage_logs 再計算 vs
 * 自分たちの記録)のみを行う。Stripe実値との突合は上記チケットが解決してから
 * 追加する。
 *
 * ★対象期間は「閉じた月」に限定する★
 * 当月(現在進行中)は日々ズレて当然(まだ全部の利用が発生しきっていない/
 * 今日のバッチがまだ走っていない)ため、突合の対象にすると常にノイズが出る。
 * 過去に閉じた月(created_at の範囲がすべて過去)は、C-2 の累積set方式のもとでは
 * 二度と新しい行が増えないため、再計算値は安定する。乖離があれば必ず異常。
 */
import type pino from "pino";
import { computeExpectedBilling, periodToDateRange, getPeriodYyyyMm } from "./stripeSync";
import { sendSlackAlert } from "../alerts/slackNotifier";

export interface ReconciliationResult {
  tenantId: string;
  periodYyyyMm: string;
  /** usage_logs から都度まるごと再計算した、あるべき請求量 */
  expectedBilledQuantity: number;
  /** stripe_usage_reports に記録されている、直近で送信成功(status='sent')した請求量。無ければ null */
  lastReportedQuantity: number | null;
  /** expectedBilledQuantity === lastReportedQuantity か */
  matches: boolean;
}

interface DbLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * 「閉じた月」を対象に、突合が必要なテナント一覧を返す。
 * 対象: 指定期間に stripe_usage_reports 行があるテナント(=請求を試みたテナント)。
 * 一度も送信を試みていないテナント(billing_enabled=false 等)は対象外
 * (billingHealthCheck.ts の stuckPendingRows が別途検知する)。
 */
async function listTenantsToReconcile(db: DbLike, periodYyyyMm: string): Promise<string[]> {
  const result = await db.query(
    `SELECT DISTINCT tenant_id FROM stripe_usage_reports WHERE period_yyyymm = $1`,
    [periodYyyyMm]
  );
  return result.rows.map((r) => r.tenant_id as string);
}

/**
 * 1テナント・1期間の突合を行う。副作用(Slack送信)を持たない純粋な検査関数。
 */
export async function reconcileTenantPeriod(
  db: DbLike,
  _logger: pino.Logger,
  tenantId: string,
  periodYyyyMm: string
): Promise<ReconciliationResult> {
  const { startDate, endDate } = periodToDateRange(periodYyyyMm);

  const planResult = await db.query(`SELECT plan FROM tenants WHERE id = $1`, [tenantId]);
  const plan: string | null = planResult.rows[0]?.plan ?? null;

  const expected = await computeExpectedBilling(db, tenantId, startDate, endDate, plan);

  const lastSent = await db.query(
    `SELECT billed_quantity
       FROM stripe_usage_reports
      WHERE tenant_id = $1 AND period_yyyymm = $2 AND status = 'sent'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [tenantId, periodYyyyMm]
  );
  const lastReportedQuantity: number | null = lastSent.rows[0]?.billed_quantity ?? null;

  return {
    tenantId,
    periodYyyyMm,
    expectedBilledQuantity: expected.billedQuantity,
    lastReportedQuantity,
    matches: expected.billedQuantity === lastReportedQuantity,
  };
}

/**
 * 指定期間(省略時は先月)について、送信を試みた全テナントを突合し、
 * 乖離があれば1本にまとめて Slack へ通知する。
 *
 * @param periodYyyyMm 省略時は「先月」(=閉じている月)。当月を指定しても動くが、
 *   前述のとおり日々ズレて当然なのでノイズになる。呼び出し側の判断に委ねる。
 */
export async function reconcileMonth(
  db: DbLike,
  logger: pino.Logger,
  periodYyyyMm?: string
): Promise<ReconciliationResult[]> {
  const period = periodYyyyMm ?? previousPeriodYyyyMm();
  const tenantIds = await listTenantsToReconcile(db, period);

  const results: ReconciliationResult[] = [];
  for (const tenantId of tenantIds) {
    try {
      results.push(await reconcileTenantPeriod(db, logger, tenantId, period));
    } catch (err) {
      logger.error({ err, tenantId, period }, "[billingReconciliation] tenant check failed");
    }
  }

  const mismatches = results.filter((r) => !r.matches);
  if (mismatches.length > 0) {
    const lines = mismatches
      .map(
        (r) =>
          `・${r.tenantId}: 再計算=${r.expectedBilledQuantity} / 記録済み送信=${r.lastReportedQuantity ?? "(送信履歴なし)"}`
      )
      .join("\n");
    await sendSlackAlert({
      ruleId: "billing_reconciliation_mismatch",
      name: "billing_reconciliation_mismatch",
      level: "CRITICAL",
      status: "FIRING",
      details:
        `${period} の請求突合で ${mismatches.length}/${results.length} テナントに乖離があります。\n` +
        `usage_logs から再計算した金額と、Stripeへ送信を記録した金額が一致していません。\n` +
        `${lines}\n` +
        `SCRIPTS/reconcile-billing.ts --period=${period} で再実行し、原因を確認してください。`,
    }).catch((err) => logger.warn({ err }, "[billingReconciliation] slack send failed"));
  }

  logger.info(
    { period, totalTenants: results.length, mismatches: mismatches.length },
    "[billingReconciliation] reconciliation completed"
  );

  return results;
}

/** 「先月」の YYYYMM を UTC 基準で返す(getPeriodYyyyMm と同じ暦の考え方)。 */
function previousPeriodYyyyMm(now: Date = new Date()): string {
  const prevMonthAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return getPeriodYyyyMm(prevMonthAnchor);
}
