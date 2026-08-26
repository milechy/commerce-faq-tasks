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
 *
 * ★この監視も「有効化されるまで沈黙する」★
 * 対象は stripe_usage_reports に行があるテナントのみ(listTenantsToReconcile参照)。
 * billing_enabled=true のテナントが1つも無い、または実際に請求送信を試みていない
 * 環境では対象0件のまま常に「乖離なし」と等価な結果になる。この監視が拾えるのは
 * 送信が実際に試みられて初めてであり、billingHealthCheck.ts と同じ理由・同じ設計
 * (詳細はそちらのファイル冒頭コメント参照)。
 */
import type pino from "pino";
import { computeExpectedBilling, periodToDateRange, getPeriodYyyyMm } from "./stripeSync";
import { computeQuotaOverage } from "./planQuota";
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

  // ★込み枠プラン(Standard/Growth)は次元ごとに別々の数量を送っている★
  // 送信側(stripeSync.ts の _reportQuotaOverageUsage)は、テキスト超過と
  // アバター超過を別々の subscription item へ、別々の stripe_usage_reports 行として
  // 記録する。ここで従来どおり「直近1行の billed_quantity」を読むと、たまたま最後に
  // 書かれた片方の次元だけを全体と比較することになり、**毎月かならず乖離と報告し続ける**
  // (CLAUDE.md 禁止50「壊れているときに何も言わない」の裏返しで、常に鳴り続けて
  // 誰も見なくなる方の失敗)。次元ごとに突き合わせる。
  const overage = computeQuotaOverage(plan, expected.textUnits, expected.avatarMinutes);
  if (overage) {
    // 次元ごとに直近の送信成功行を引く。
    const sentByDimension = await db.query(
      `SELECT DISTINCT ON (dimension) dimension, billed_quantity
         FROM stripe_usage_reports
        WHERE tenant_id = $1 AND period_yyyymm = $2 AND status = 'sent'
        ORDER BY dimension, updated_at DESC`,
      [tenantId, periodYyyyMm]
    );
    const reported = new Map<string, number | null>(
      sentByDimension.rows.map((r) => [r.dimension as string, (r.billed_quantity ?? null) as number | null])
    );
    const textReported = reported.get('text') ?? null;
    const avatarReported = reported.get('avatar') ?? null;

    // 一度も送信していない次元は null。null と 0 を同一視しない
    // (「0と報告済み」と「まだ何も送っていない」は別の状態で、後者は調査対象)。
    const matches =
      textReported === overage.textConversations && avatarReported === overage.avatarMinutes;

    // 表示用の合計。どちらの次元がズレたかは matches=false の調査で
    // 上の2値を見れば分かるため、結果の形は純従量プランと共通のまま保つ。
    const anyReported = textReported !== null || avatarReported !== null;
    return {
      tenantId,
      periodYyyyMm,
      expectedBilledQuantity: overage.textConversations + overage.avatarMinutes,
      lastReportedQuantity: anyReported ? (textReported ?? 0) + (avatarReported ?? 0) : null,
      matches,
    };
  }

  // ── 純従量プラン(Starter / free_ad / Enterprise): 従来どおり単一数量で突合 ──
  // dimension 列を読まないので、migration 未適用の環境でも既存テナントの突合は
  // これまでどおり動き続ける。
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
  // ★テナント単位の失敗を可視化する★
  // 導入時は catch → logger.error のみで、失敗したテナントは results から
  // 単純に消えるだけだった。「壊れているのに気づけないのをテストではなく
  // 検知で守る」ためのジョブ自身に、気づけない経路が残っていた
  // (DB接続不調などで一部テナントだけ突合できていない状態がサイレントになる)。
  const failedTenants: Array<{ tenantId: string; error: string }> = [];
  for (const tenantId of tenantIds) {
    try {
      results.push(await reconcileTenantPeriod(db, logger, tenantId, period));
    } catch (err) {
      logger.error({ err, tenantId, period }, "[billingReconciliation] tenant check failed");
      failedTenants.push({ tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const mismatches = results.filter((r) => !r.matches);
  if (mismatches.length > 0 || failedTenants.length > 0) {
    const mismatchLines = mismatches
      .map(
        (r) =>
          `・${r.tenantId}: 再計算=${r.expectedBilledQuantity} / 記録済み送信=${r.lastReportedQuantity ?? "(送信履歴なし)"}`
      )
      .join("\n");
    const failureLines = failedTenants
      .map((f) => `・${f.tenantId}: 突合そのものが失敗(${f.error})`)
      .join("\n");

    const parts: string[] = [
      `${period} の請求突合で ${tenantIds.length} テナント中、` +
        `乖離 ${mismatches.length} 件・突合失敗 ${failedTenants.length} 件があります。`,
    ];
    if (mismatches.length > 0) {
      parts.push(
        `usage_logs から再計算した金額と、Stripeへ送信を記録した金額が一致していません。\n${mismatchLines}`
      );
    }
    if (failedTenants.length > 0) {
      // 突合失敗は「乖離が無い」とは別物。DB接続不調などでこのテナントの
      // 実態が不明なだけであり、実際には請求ズレがあっても検知できていない。
      parts.push(`以下のテナントは突合自体が実行できませんでした（実態不明）:\n${failureLines}`);
    }
    parts.push(`SCRIPTS/reconcile-billing.ts --period=${period} で再実行し、原因を確認してください。`);

    await sendSlackAlert({
      ruleId: "billing_reconciliation_mismatch",
      name: "billing_reconciliation_mismatch",
      level: "CRITICAL",
      status: "FIRING",
      details: parts.join("\n\n"),
    }).catch((err) => logger.warn({ err }, "[billingReconciliation] slack send failed"));
  }

  logger.info(
    { period, totalTenants: tenantIds.length, mismatches: mismatches.length, failed: failedTenants.length },
    "[billingReconciliation] reconciliation completed"
  );

  return results;
}

/** 「先月」の YYYYMM を UTC 基準で返す(getPeriodYyyyMm と同じ暦の考え方)。 */
function previousPeriodYyyyMm(now: Date = new Date()): string {
  const prevMonthAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return getPeriodYyyyMm(prevMonthAnchor);
}

// ---------------------------------------------------------------------------
// 定期実行ラッパー。
//
// ★導入時、このジョブは SCRIPTS/reconcile-billing.ts のCLIからしか呼ばれず、
// cron/systemd timer のいずれにも登録されていなかった(厳格レビューで発覚)。
// 「壊れているのに誰も気づかない」を防ぐために作ったジョブ自身が、
// 動線として閉じていなかった(CLAUDE.md 禁止15)。
//
// billingHealthCheck.ts の BillingHealthMonitor と同じ形(DI・二重起動防止・
// stop())を踏襲する。対象は「先月」という閉じた期間なので、
// report-stripe-usage.ts の日次バッチと同じ 24h 周期で十分
// (先月は月が変わるまで結果が変わらないため、日次実行は「毎日同じ答えを
// 再確認する」意味になる。乖離が起きた場合、直るまで日次でSlackが鳴り
// 続けるのは意図的 — 一度鳴って忘れられるより、直るまで毎日思い出させる
// 方を選んだ。cooldownは付けない)。
// ---------------------------------------------------------------------------

const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間ごと(report-stripe-usage.tsと同じ周期)

class BillingReconciliationMonitor {
  private timer: NodeJS.Timeout | null = null;

  start(db: DbLike, logger: pino.Logger): void {
    if (this.timer) return; // 二重起動防止(CLAUDE.md 禁止30)
    const tick = () => {
      reconcileMonth(db, logger).catch((err) => {
        logger.error({ err }, "[billingReconciliation] scheduled run failed");
      });
    };
    this.timer = setInterval(tick, RECONCILE_INTERVAL_MS);
    // 起動直後に1回実行する(次の24hを待たない。billingHealthMonitorと同じ方針)。
    tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const billingReconciliationMonitor = new BillingReconciliationMonitor();
