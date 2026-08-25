/**
 * billingHealthCheck — 課金パイプラインの「壊れているのに誰も気づかない」を防ぐ定期監視。
 *
 * staging が無いため、これらの不変条件はテストではなく本番の定期チェックで守る。
 * alertEngine.ts(60秒周期・prom-clientメトリクス由来)とは対象もタイムスケールも
 * 別なので独立モジュールにする。ここはDBに直接問い合わせる、日単位で動く事象を扱う。
 *
 * ■ チェック1: stuckPendingRows（CRITICAL）
 * reportUsageToStripe は「当月」の pending 行しか対象にしない
 * (getPeriodYyyyMm/periodToDateRange が現在月の範囲しか作らない)。
 * 月をまたいで pending のまま残っている行は、現在のアーキテクチャでは
 * 二度と拾われない＝恒久的に未請求のまま残る(Asana 1217808138968200)。
 * 1件でも見つかったら即 CRITICAL とする(untestedで直接収益に効くため)。
 *
 * ■ チェック2: unstampedRatio（WARNING）
 * usage_logs.plan_multiplier は利用時点で焼き付けられる(usageTracker.ts)。
 * migration適用後・queryTenantPlanResult が正常なら、直近の billable 行の
 * unstamped(NULL)比率はほぼ0のはず。しきい値を超えたまま高止まりしている場合、
 * 焼き付けが機能していない(queryTenantPlanResult の障害・tenants行の欠損等)。
 * サンプル数が少ない時間帯の誤検知を避けるため最小サンプル数を設ける。
 */
import type pino from "pino";
import { sendSlackAlert, type AlertLevel } from "../alerts/slackNotifier";
import { getPeriodYyyyMm, periodToDateRange } from "./stripeSync";

export interface BillingHealthViolation {
  id: string;
  level: AlertLevel;
  message: string;
}

const UNSTAMPED_RATIO_THRESHOLD = 0.05; // 5%
const UNSTAMPED_MIN_SAMPLE = 20; // これ未満のサンプル数では判定しない(低トラフィック時の誤検知防止)
const UNSTAMPED_WINDOW = "24 hours";

/**
 * 現時点の不変条件を評価する。副作用(Slack送信)を持たない純粋な検査関数。
 * `db` は `{ query }` を持つ最小限のインターフェース(pg.Pool 相当)。
 */
export async function checkBillingHealth(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  _logger: pino.Logger
): Promise<BillingHealthViolation[]> {
  const violations: BillingHealthViolation[] = [];

  // ── チェック1: 月をまたいで pending のまま残っている行 ──────────────────
  const { startDate: currentMonthStart } = periodToDateRange(getPeriodYyyyMm());
  const stuckResult = await db.query(
    `SELECT COUNT(*)::integer AS cnt, MIN(created_at) AS oldest
       FROM usage_logs
      WHERE billing_status = 'pending'
        AND billable = true
        AND created_at < $1`,
    [currentMonthStart]
  );
  const stuckCount = stuckResult.rows[0]?.cnt ?? 0;
  if (stuckCount > 0) {
    violations.push({
      id: "billing_stuck_pending_rows",
      level: "CRITICAL",
      message:
        `usage_logs に月をまたいで pending のまま残っている行が ${stuckCount} 件あります。` +
        `現在の集計は「当月」しか対象にしないため、これらは今後も自動では請求されません` +
        `（最古: ${stuckResult.rows[0]?.oldest ?? "不明"}）。` +
        `SCRIPTS/report-stripe-usage.ts --period=YYYYMM で対象月を手動指定して再実行してください。`,
    });
  }

  // ── チェック2: 直近の焼き付け失敗率 ──────────────────────────────────
  const unstampedResult = await db.query(
    `SELECT
       COUNT(*)::integer AS total,
       COUNT(*) FILTER (WHERE plan_multiplier IS NULL)::integer AS unstamped
     FROM usage_logs
     WHERE billable = true
       AND created_at >= NOW() - INTERVAL '${UNSTAMPED_WINDOW}'`
  );
  const total = unstampedResult.rows[0]?.total ?? 0;
  const unstamped = unstampedResult.rows[0]?.unstamped ?? 0;
  if (total >= UNSTAMPED_MIN_SAMPLE) {
    const ratio = unstamped / total;
    if (ratio > UNSTAMPED_RATIO_THRESHOLD) {
      violations.push({
        id: "billing_unstamped_ratio_high",
        level: "WARNING",
        message:
          `直近${UNSTAMPED_WINDOW}の課金対象行のうち ${(ratio * 100).toFixed(1)}%` +
          `(${unstamped}/${total}件)がプラン未確定(plan_multiplier NULL)のまま記録されています。` +
          `usageTracker の queryTenantPlanResult がテナントのプランを解決できていません` +
          `（DB障害・tenants行の欠損・migration未適用の可能性）。` +
          `未確定行は tenants.plan 由来のフォールバック倍率で請求されるため、` +
          `月中にプラン変更があったテナントの請求が遡及して不正確になっています。`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 定期実行ラッパー。alertEngine.ts と同じ「FIRING/RESOLVED・cooldown」の
// 発想を踏襲するが、日単位で動く事象を対象にするため評価間隔は別に持つ。
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1時間ごと(日単位でしか動かない事象のため60秒周期は不要)
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 同一違反の再送は6時間間隔

class BillingHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastFiredAt = new Map<string, number>();
  private currentlyFiring = new Set<string>();

  start(
    db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    logger: pino.Logger
  ): void {
    if (this.timer) return; // 二重起動防止(CLAUDE.md 禁止30: 費用が発生する定期処理の多重起動)
    const tick = () => {
      void this.evaluate(db, logger);
    };
    this.timer = setInterval(tick, CHECK_INTERVAL_MS);
    // 起動直後に1回評価する(次の1時間を待たない)
    tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** テスト専用: FIRING/cooldown状態をリセットする（シングルトンのため状態がテスト間で残る）。 */
  _resetForTest(): void {
    this.lastFiredAt.clear();
    this.currentlyFiring.clear();
  }

  private async evaluate(
    db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    logger: pino.Logger
  ): Promise<void> {
    let violations: BillingHealthViolation[];
    try {
      violations = await checkBillingHealth(db, logger);
    } catch (err) {
      logger.error({ err }, "[billingHealthCheck] evaluation failed");
      return;
    }

    const firingIds = new Set(violations.map((v) => v.id));

    for (const v of violations) {
      const now = Date.now();
      const last = this.lastFiredAt.get(v.id) ?? 0;
      if (now - last < COOLDOWN_MS) continue; // cooldown中は送らない
      this.lastFiredAt.set(v.id, now);
      this.currentlyFiring.add(v.id);
      await sendSlackAlert({
        ruleId: v.id,
        name: v.id,
        level: v.level,
        status: "FIRING",
        details: v.message,
      }).catch((err) => logger.warn({ err, ruleId: v.id }, "[billingHealthCheck] slack send failed"));
    }

    // 解消したものは RESOLVED を送る(cooldownの対象外・解消は即時通知)
    for (const id of Array.from(this.currentlyFiring)) {
      if (firingIds.has(id)) continue;
      this.currentlyFiring.delete(id);
      this.lastFiredAt.delete(id);
      await sendSlackAlert({
        ruleId: id,
        name: id,
        level: "INFO",
        status: "RESOLVED",
        details: "条件が解消しました。",
      }).catch((err) => logger.warn({ err, ruleId: id }, "[billingHealthCheck] slack send failed"));
    }
  }
}

export const billingHealthMonitor = new BillingHealthMonitor();
