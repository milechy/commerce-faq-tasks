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
 *
 * ★この監視は「有効化されるまで沈黙する」★
 * チェック1は `tenants.billing_enabled = true` のテナントだけを対象にする
 * (billing_enabled のデフォルトは false。migration_billing.sql)。つまり
 * billing_enabled=true のテナントが1つも無い間は stuckPendingRows は常に0件で
 * 沈黙し続ける。billingReconciliation.ts(月次突合)も stripe_usage_reports に
 * 行があるテナントだけを対象にするため、一度も送信を試みていない環境では
 * 対象0件のまま沈黙する。「オオカミ少年を防ぐ」ための設計だが、裏を返すと
 * 「監視があるから安心」と誤解してはいけない、ということでもある。
 * この2本が実際に異常を拾えるのは、billing_enabled=true のテナントが
 * 存在し、かつ請求送信が試みられて初めて。有効化前は「異常が無い」のではなく
 * 「まだ何も見ていない」。
 *
 * ■ チェック3: schemaMissingColumns（CRITICAL）
 * 2026-08-25 の収益監査で判明: 課金スキーマの欠落を検知する schemaHealth.ts の
 * fetchSchemaHealth は既に実装済みだったが、呼び出し元が管理画面のAPIルート
 * 1箇所だけで、起動時にもこの定期監視にも配線されていなかった。
 * migration_stripe_usage_reports_billed_quantity.sql が本番未適用のまま
 * 何ヶ月も気づかれなかったのはこれが原因（検出器はあったが鳴らす場所が無かった）。
 * チェック1・2と違い、これは billing_enabled のテナント有無に関係なく常時評価する
 * （スキーマの欠落はテナントの利用状況とは独立した事実であり、対象0件で沈黙してよい
 * 理由が無い）。
 *
 * ■ チェック4: staleReportedRows（WARNING）
 * PR-4(2026-08-25収益監査): invoice.payment_succeeded/payment_failed は
 * billing_status を 'reported' → 'paid'/'failed' に遷移させる(stripeWebhook.ts)。
 * この遷移が効いていれば 'reported' は短期間で解消されるはず。長期間
 * 'reported' のまま残っている行は、webhookが届いていない
 * (エンドポイント未登録・署名不一致・tenant_id解決失敗・stripe_subscriptions
 * の対応行欠落等)可能性が高い。billing_enabled のテナント有無とは無関係に
 * 常時評価する(チェック3と同じ理由)。
 *
 * ■ チェック5: fixedCostQuota（WARNING、A2A-0i）
 * LemonSlice($100/月・込み15,000クレジット)とLiveKit($50/月)は、上げ下げの
 * 判断ができないと「気づいたら大幅超過」か「使っていないのに払い続ける」の
 * どちらかに倒れる固定費。fetchFixedCostQuotaStatus が当月消費率を計算し、
 * 80%到達で「上げるべきか」のWARNINGを鳴らす(上げ方向は敏感に)。
 * 「下げられるか」のシグナル(直近3ヶ月連続で50%未満)はここでは鳴らさず、
 * /admin/monitoring の表示カードでのみ提示する(下げ方向は慎重に・数ヶ月続く
 * 状態をSlackで6時間おきに鳴らし続けるのは事故対応向けのこのチャンネルに合わない)。
 * env未設定のクォータ(現状LiveKitの既定)は「有効化されるまで沈黙する」
 * (チェック1・2と同じ設計思想)。
 */
import type { Pool } from "pg";
import type pino from "pino";
import { sendSlackAlert, type AlertLevel } from "../alerts/slackNotifier";
import { fetchSchemaHealth } from "../../api/admin/analytics/schemaHealth";
import { getPeriodYyyyMm, periodToDateRange } from "./stripeSync";
import { LIVEKIT_ROOM_TOKEN_MODEL } from "./costCalculator";

export interface BillingHealthViolation {
  id: string;
  level: AlertLevel;
  message: string;
}

const UNSTAMPED_RATIO_THRESHOLD = 0.05; // 5%
const UNSTAMPED_MIN_SAMPLE = 20; // これ未満のサンプル数では判定しない(低トラフィック時の誤検知防止)
const UNSTAMPED_WINDOW = "24 hours";
// Stripeのメータードビリング請求は通常、月次サイクルの確定から数日内に確定・決済される。
// 30日は1サイクル分の猶予を見た値(進行中の請求サイクルを誤検知しないため)。
const STALE_REPORTED_DAYS = 30;

// ---------------------------------------------------------------------------
// A2A-0i: 固定費(LemonSlice/LiveKit)クォータ監視
//
// 「上げやすく下げにくい」固定費の性質に合わせ、閾値を非対称にする:
//   - 上げ方向は敏感に: 当月消費が込み枠の80%に達したら即座に示唆する。
//   - 下げ方向は慎重に: 直近3ヶ月連続で50%未満のときだけ示唆する
//     (1ヶ月だけ利用が少ない状態を「下げどき」と誤判定しないため)。
// 従量課金ポリシー([[project_usage_based_billing_no_caps]])上、これは
// 上限(ハードキャップ)ではなく判断材料としての通知に留める。
// ---------------------------------------------------------------------------

const QUOTA_UP_THRESHOLD_RATIO = 0.8;
const QUOTA_DOWN_THRESHOLD_RATIO = 0.5;
const QUOTA_DOWN_SIGNAL_MONTHS = 3;

// LemonSlice $100/月プランの込みクレジット数(team提供の実際の契約内容)。
// env未設定時のデフォルトとして使う。明示的に不正な値が来た場合もこれにフォールバックする
// (checkSaiMonthlyCostCeiling と同じ fail-safe 方針。options/routes.ts:100-113 参照)。
const LEMONSLICE_CREDIT_QUOTA_DEFAULT = 15000;

export interface FixedCostQuotaLine {
  /** 当月の消費量(LemonSlice=クレジット、LiveKit=room発行件数) */
  used: number;
  /** 込み枠。envで未設定・解決不能なら null(=このクォータの監視は無効) */
  quota: number | null;
  /** used / quota。quota が null または 0 なら null */
  ratio: number | null;
  /** 上げるべきかもしれない(ratio >= 80%) */
  upSignal: boolean;
  /** 下げられるかもしれない(直近3ヶ月連続で50%未満) */
  downSignal: boolean;
  /** downSignal判定に使えた完了月数。3未満ならdownSignalは常にfalse(母数不足) */
  historyMonths: number;
}

export interface FixedCostQuotaStatus {
  lemonslice: FixedCostQuotaLine;
  livekit: FixedCostQuotaLine;
  asOf: string;
}

// fetchFixedCostQuotaStatus は checkBillingHealth(pino.Logger)と
// analytics/routes.ts(lib/logger.tsのAppLoggerラッパー)の両方から呼ばれる。
// warn()しか使わないので、両方を満たす最小限の構造的インターフェースにする
// (db側をPool具象型ではなく`{query}`最小型にしているのと同じ考え方)。
interface MinimalLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * 固定費クォータのenv値を解決する。fail-safe(不正な設定ならデフォルトへ
 * フォールバック)であるべきで、fail-open(不正な設定で誤って監視が無効になる)を
 * 避ける — checkSaiMonthlyCostCeiling(options/routes.ts)と同じ方針。
 *
 * defaultValue が null の項目(現状LiveKit)は、env が未設定である限り
 * 「このクォータの実際の込み枠が判明していない」ことを意味し、監視は沈黙する
 * (チェック1・2と同じ「有効化されるまで沈黙する」設計)。
 */
function resolveQuotaEnv(
  envValue: string | undefined,
  defaultValue: number | null,
  label: string,
  logger: MinimalLogger,
): number | null {
  if (envValue === undefined) return defaultValue;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      { envValue, label, fallback: defaultValue },
      `[fixedCostQuota] invalid ${label} value — falling back to default (fail-safe, not fail-open)`,
    );
    return defaultValue;
  }
  return parsed;
}

interface MonthlyQuotaQueryOpts {
  currentMonthSql: string;
  currentMonthParams?: unknown[];
  historySql: string;
  historyParams?: unknown[];
  quotaEnvValue: string | undefined;
  quotaDefault: number | null;
  quotaLabel: string;
}

async function _monthlyQuotaLine(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  logger: MinimalLogger,
  opts: MonthlyQuotaQueryOpts,
): Promise<FixedCostQuotaLine> {
  const quota = resolveQuotaEnv(opts.quotaEnvValue, opts.quotaDefault, opts.quotaLabel, logger);

  const currentResult = await db.query(opts.currentMonthSql, opts.currentMonthParams);
  const used = parseInt(currentResult.rows[0]?.used ?? "0", 10);

  const ratio = quota !== null && quota > 0 ? used / quota : null;
  const upSignal = ratio !== null && ratio >= QUOTA_UP_THRESHOLD_RATIO;

  let downSignal = false;
  let historyMonths = 0;
  // quota が未確定(null)のときは「下げられるか」を判断できない(比較対象が無い)ので、
  // 履歴クエリ自体を発行しない(沈黙する)。
  if (quota !== null && quota > 0) {
    const historyResult = await db.query(opts.historySql, opts.historyParams);
    historyMonths = historyResult.rows.length;
    if (historyMonths >= QUOTA_DOWN_SIGNAL_MONTHS) {
      downSignal = historyResult.rows
        .slice(-QUOTA_DOWN_SIGNAL_MONTHS)
        .every((r: any) => parseInt(r.used ?? "0", 10) / quota < QUOTA_DOWN_THRESHOLD_RATIO);
    }
  }

  return { used, quota, ratio, upSignal, downSignal, historyMonths };
}

/**
 * LemonSlice/LiveKitの当月固定費消費状況を計算する。副作用なし(Slack送信は
 * checkBillingHealth 側の責務)。/admin/monitoring の表示カード(analytics/routes.ts)
 * と billingHealthMonitor(Slack通知)の両方から呼ばれる、計算ロジックの唯一の出どころ。
 */
export async function fetchFixedCostQuotaStatus(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  logger: MinimalLogger,
): Promise<FixedCostQuotaStatus> {
  const [lemonslice, livekit] = await Promise.all([
    _monthlyQuotaLine(db, logger, {
      currentMonthSql: `-- fixed_cost_quota:lemonslice:current
                         SELECT COALESCE(SUM(avatar_credits), 0) AS used
                           FROM usage_logs
                          WHERE feature_used = 'avatar'
                            AND created_at >= date_trunc('month', NOW())`,
      historySql: `-- fixed_cost_quota:lemonslice:history
                    SELECT date_trunc('month', created_at) AS month, COALESCE(SUM(avatar_credits), 0) AS used
                     FROM usage_logs
                    WHERE feature_used = 'avatar'
                      AND created_at >= date_trunc('month', NOW()) - INTERVAL '${QUOTA_DOWN_SIGNAL_MONTHS} months'
                      AND created_at < date_trunc('month', NOW())
                    GROUP BY 1 ORDER BY 1`,
      quotaEnvValue: process.env.LEMONSLICE_MONTHLY_CREDIT_QUOTA,
      quotaDefault: LEMONSLICE_CREDIT_QUOTA_DEFAULT,
      quotaLabel: "LEMONSLICE_MONTHLY_CREDIT_QUOTA",
    }),
    _monthlyQuotaLine(db, logger, {
      currentMonthSql: `-- fixed_cost_quota:livekit:current
                         SELECT COUNT(*) AS used
                           FROM usage_logs
                          WHERE feature_used = 'avatar'
                            AND model = $1
                            AND created_at >= date_trunc('month', NOW())`,
      currentMonthParams: [LIVEKIT_ROOM_TOKEN_MODEL],
      historySql: `-- fixed_cost_quota:livekit:history
                    SELECT date_trunc('month', created_at) AS month, COUNT(*) AS used
                     FROM usage_logs
                    WHERE feature_used = 'avatar'
                      AND model = $1
                      AND created_at >= date_trunc('month', NOW()) - INTERVAL '${QUOTA_DOWN_SIGNAL_MONTHS} months'
                      AND created_at < date_trunc('month', NOW())
                    GROUP BY 1 ORDER BY 1`,
      historyParams: [LIVEKIT_ROOM_TOKEN_MODEL],
      // LiveKitの実際の込み枠(分数・room数等)は現時点で未確定のため、SAIのような
      // 推定デフォルトを置かない。env設定まではこのクォータの監視は沈黙する。
      quotaEnvValue: process.env.LIVEKIT_MONTHLY_ROOM_QUOTA,
      quotaDefault: null,
      quotaLabel: "LIVEKIT_MONTHLY_ROOM_QUOTA",
    }),
  ]);

  return { lemonslice, livekit, asOf: new Date().toISOString() };
}

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
  //
  // tenants.billing_enabled はデフォルト false（migration_billing.sql）。
  // _reportTenantUsage は billing_enabled=false のテナントの usage_logs には
  // 一切触れない(集計にも到達しない)ため、そうしたテナントの行は「意図的に
  // 永久 pending」であり故障ではない。ここを除外しないと、billing_enabled=false
  // のテナントが1つでもいるだけで毎時間 CRITICAL が鳴り、本物の異常を
  // 見逃す「オオカミ少年」化を招く（無料期間中のテナントも同様の性質を持つが、
  // 無料期間の履歴は追えないため対象外。Asana 1217808138968200 の範囲）。
  const { startDate: currentMonthStart } = periodToDateRange(getPeriodYyyyMm());
  const stuckResult = await db.query(
    `SELECT COUNT(*)::integer AS cnt, MIN(u.created_at) AS oldest
       FROM usage_logs u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.billing_status = 'pending'
        AND u.billable = true
        AND u.created_at < $1
        AND t.billing_enabled = true`,
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

  // ── チェック3: 課金スキーマの欠落列 ──────────────────────────────────
  // billing_enabled のテナント有無とは独立に常時評価する（対象0件で沈黙する
  // 理由が無い）。fetchSchemaHealth の判定ロジックは書き写さず呼び出すだけ
  // （単一の出どころ。集計SQLを書き写すのと同じ理由で禁止）。
  const schemaHealth = await fetchSchemaHealth(db as unknown as Pool);
  if (schemaHealth.missing.length > 0) {
    const detail = schemaHealth.missing
      .map((m) =>
        m.tableMissing
          ? `${m.table}(テーブルごと欠落)`
          : `${m.table}.${m.columns.join(",")}`
      )
      .join(" / ");
    violations.push({
      id: "billing_schema_missing_columns",
      level: "CRITICAL",
      message:
        `本番DBに課金スキーマの必須列が欠落しています: ${detail}。` +
        `migration が未適用の可能性があります。該当する migration_*.sql を ` +
        `SCRIPTS/ci-billing-schema.sh の FILES 配列で確認し、人間が適用してください` +
        `（migration の自動実行は禁止）。欠落したまま運用すると INSERT が無言で` +
        `失敗し、利用記録・請求が静かに止まります。`,
    });
  }

  // ── チェック4: 決済webhookが反映されないまま滞留している行 ──────────────
  const staleReportedResult = await db.query(
    `SELECT COUNT(*)::integer AS cnt, MIN(created_at) AS oldest
       FROM usage_logs
      WHERE billing_status = 'reported'
        AND created_at < NOW() - INTERVAL '${STALE_REPORTED_DAYS} days'`
  );
  const staleReportedCount = staleReportedResult.rows[0]?.cnt ?? 0;
  if (staleReportedCount > 0) {
    violations.push({
      id: "billing_stale_reported_rows",
      level: "WARNING",
      message:
        `usage_logs に 'reported' のまま${STALE_REPORTED_DAYS}日以上滞留している行が ` +
        `${staleReportedCount}件あります（最古: ${staleReportedResult.rows[0]?.oldest ?? "不明"}）。` +
        `invoice.payment_succeeded/payment_failed webhook が届いていない可能性があります` +
        `（Stripe側のエンドポイント登録・署名検証・stripe_subscriptions の対応行を確認してください）。`,
    });
  }

  // ── チェック5: 固定費(LemonSlice/LiveKit)クォータの消費率(A2A-0i) ──────────
  // 「下げられるか」のシグナル(downSignal)はここでは鳴らさない(コメント冒頭参照)。
  // /admin/monitoring の表示カードでのみ提示する。
  const fixedCostQuota = await fetchFixedCostQuotaStatus(db, _logger);
  if (fixedCostQuota.lemonslice.upSignal) {
    const { used, quota, ratio } = fixedCostQuota.lemonslice;
    violations.push({
      id: "fixed_cost_quota_lemonslice_high",
      level: "WARNING",
      message:
        `LemonSlice($100/月・込み${quota}クレジット)の当月消費が${used}クレジット` +
        `(${((ratio ?? 0) * 100).toFixed(1)}%)に達しています。込み枠の引き上げを検討してください。` +
        `※この数値はavatar-agent(agent.py)のセッション終了時1回きりの送信(リトライなし)を` +
        `元にしており、クラッシュ・OOM・強制killで計上漏れが起き得ます。実際の消費率はこれより` +
        `高い可能性があります(過小に出る方向にのみ誤差がある)。`,
    });
  }
  if (fixedCostQuota.livekit.upSignal) {
    const { used, quota, ratio } = fixedCostQuota.livekit;
    violations.push({
      id: "fixed_cost_quota_livekit_high",
      level: "WARNING",
      message:
        `LiveKit($50/月・込み${quota}room/月)の当月消費が${used}room` +
        `(${((ratio ?? 0) * 100).toFixed(1)}%)に達しています。込み枠の引き上げを検討してください。`,
    });
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
