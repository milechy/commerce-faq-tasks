/**
 * AlertEngine — 60秒周期で KPI を評価し、Slack アラートを送信する
 *
 * 仕様:
 *   - 60秒ごとに prom-client カウンター・ヒストグラムを読み取り
 *   - 前回スナップショットとの差分でレート計算
 *   - 条件が durationMs 継続したら FIRING アラートを送信
 *   - cooldown: 同一アラートの再送は 30 分間隔
 *   - 条件が解消したら RESOLVED を送信
 *
 * 制約: PII・書籍内容をアラートメッセージに含めない
 */

import pino from "pino";
import {
  avatarRequestsCounter,
  conversationTerminalCounter,
  httpErrorsCounter,
  killSwitchGauge,
  loopDetectedCounter,
  ragDurationHistogram,
} from "../metrics/promExporter";
import { ALERT_RULES, type AlertRule, type MetricsSnapshot } from "./alertRules";
import { sendSlackAlert } from "./slackNotifier";

const EVAL_INTERVAL_MS = 60_000;
const COOLDOWN_MS = 30 * 60 * 1000;

const logger = pino({
  name: "alert-engine",
  level: process.env.LOG_LEVEL ?? "info",
});

// ---------------------------------------------------------------------------
// 生カウンター値（差分計算用）
// ---------------------------------------------------------------------------

interface RawCounters {
  /** `${reason}:${tenantId}` → value */
  conversationTerminal: Map<string, number>;
  /** `${tenantId}` → value */
  loopDetected: Map<string, number>;
  /** `${status}:${tenantId}` → value */
  avatarRequests: Map<string, number>;
  /** `${statusCode}:${tenantId}` → value */
  httpErrors: Map<string, number>;
  /** `${reason}` → gauge value */
  killSwitch: Map<string, number>;
  /** `${le}:${tenantId}` → cumulative bucket count (search phase のみ) */
  ragSearchBuckets: Map<string, number>;
}

// ---------------------------------------------------------------------------
// ルール状態管理
// ---------------------------------------------------------------------------

interface RuleState {
  /** 条件が最初に真になった時刻（現在違反中でない場合 null） */
  violationStart: number | null;
  /** 直近の FIRING アラートを送信した時刻（未送信の場合 null） */
  lastFiredAt: number | null;
  /** 現在 FIRING 状態か（RESOLVED 送信の判定に使用） */
  isFiring: boolean;
}

// ---------------------------------------------------------------------------
// ヒストグラム p95 計算
// ---------------------------------------------------------------------------

/**
 * デルタバケット（評価ウィンドウ内の観測数）から p95 を推定する。
 * バケットはソート不要（関数内でソートする）。
 * データがない場合は null を返す。
 */
function computeP95(
  deltaBuckets: ReadonlyArray<{ le: string; count: number }>
): number | null {
  const infEntry = deltaBuckets.find((b) => b.le === "+Inf");
  const total = infEntry?.count ?? 0;
  if (total === 0) return null;

  const finiteBuckets = deltaBuckets
    .filter((b) => b.le !== "+Inf")
    .map((b) => ({ le: parseFloat(b.le), count: b.count }))
    .sort((a, b) => a.le - b.le);

  const p95target = total * 0.95;
  let prevCount = 0;
  let prevLe = 0;

  for (const { le, count } of finiteBuckets) {
    if (count >= p95target) {
      if (count === prevCount) return le;
      const frac = (p95target - prevCount) / (count - prevCount);
      return prevLe + frac * (le - prevLe);
    }
    prevCount = count;
    prevLe = le;
  }

  // p95 が最後の有限バケットを超える場合はその上限を返す
  return finiteBuckets[finiteBuckets.length - 1]?.le ?? 0;
}

// ---------------------------------------------------------------------------
// 生メトリクス収集
// ---------------------------------------------------------------------------

async function collectRawCounters(): Promise<RawCounters> {
  const [convData, loopData, avatarData, httpData, killData, ragData] =
    await Promise.all([
      conversationTerminalCounter.get(),
      loopDetectedCounter.get(),
      avatarRequestsCounter.get(),
      httpErrorsCounter.get(),
      killSwitchGauge.get(),
      ragDurationHistogram.get(),
    ]);

  const conversationTerminal = new Map<string, number>();
  for (const v of convData.values) {
    const labels = v.labels as Record<string, string | number>;
    conversationTerminal.set(
      `${labels["reason"] ?? "_"}:${labels["tenantId"] ?? "_"}`,
      v.value
    );
  }

  const loopDetected = new Map<string, number>();
  for (const v of loopData.values) {
    const labels = v.labels as Record<string, string | number>;
    loopDetected.set(String(labels["tenantId"] ?? "_"), v.value);
  }

  const avatarRequests = new Map<string, number>();
  for (const v of avatarData.values) {
    const labels = v.labels as Record<string, string | number>;
    avatarRequests.set(
      `${labels["status"] ?? "_"}:${labels["tenantId"] ?? "_"}`,
      v.value
    );
  }

  const httpErrors = new Map<string, number>();
  for (const v of httpData.values) {
    const labels = v.labels as Record<string, string | number>;
    httpErrors.set(
      `${labels["statusCode"] ?? "_"}:${labels["tenantId"] ?? "_"}`,
      v.value
    );
  }

  const killSwitch = new Map<string, number>();
  for (const v of killData.values) {
    const labels = v.labels as Record<string, string | number>;
    killSwitch.set(String(labels["reason"] ?? "_"), v.value);
  }

  // ヒストグラム: le ラベルがある（バケット）エントリのみ収集
  // sum/count エントリは metricName が設定されるため除外
  const ragSearchBuckets = new Map<string, number>();
  for (const v of ragData.values) {
    if (v.metricName !== undefined) continue; // sum/count エントリをスキップ
    const labels = v.labels as Record<string, string | number>;
    const le = labels["le"];
    if (le === undefined) continue;
    if (labels["phase"] !== "search") continue;
    ragSearchBuckets.set(
      `${String(le)}:${labels["tenantId"] ?? "_"}`,
      v.value
    );
  }

  return {
    conversationTerminal,
    loopDetected,
    avatarRequests,
    httpErrors,
    killSwitch,
    ragSearchBuckets,
  };
}

// ---------------------------------------------------------------------------
// スナップショット計算
// ---------------------------------------------------------------------------

function sumMap(map: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

/** current - prev の差分マップを返す。負値は 0 にクランプ（カウンターリセット対策） */
function deltaMap(
  current: ReadonlyMap<string, number>,
  prev: ReadonlyMap<string, number>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, value] of current) {
    result.set(key, Math.max(0, value - (prev.get(key) ?? 0)));
  }
  return result;
}

function computeSnapshot(
  current: RawCounters,
  prev: RawCounters | null
): MetricsSnapshot {
  const now = Date.now();

  // Kill Switch は常に現在のゲージ値で判定（差分不要）
  const killSwitchActive = sumMap(current.killSwitch) > 0;

  if (!prev) {
    // 初回評価: カウンター差分が取れないため KPI レートは null
    return {
      timestamp: now,
      completionRate: null,
      loopRate: null,
      avatarFallbackRate: null,
      searchP95Ms: null,
      errorRate: null,
      killSwitchActive,
    };
  }

  // --- 差分計算 ---
  const convDelta = deltaMap(current.conversationTerminal, prev.conversationTerminal);
  const loopDelta = deltaMap(current.loopDetected, prev.loopDetected);
  const avatarDelta = deltaMap(current.avatarRequests, prev.avatarRequests);
  const httpDelta = deltaMap(current.httpErrors, prev.httpErrors);
  const ragBucketDelta = deltaMap(current.ragSearchBuckets, prev.ragSearchBuckets);

  // --- 会話完了率 (%) ---
  const totalConv = sumMap(convDelta);
  let completionRate: number | null = null;
  if (totalConv > 0) {
    let completedCount = 0;
    for (const [key, count] of convDelta) {
      if (key.startsWith("completed:")) completedCount += count;
    }
    completionRate = (completedCount / totalConv) * 100;
  }

  // --- ループ検出率 (%) ---
  let loopRate: number | null = null;
  if (totalConv > 0) {
    loopRate = (sumMap(loopDelta) / totalConv) * 100;
  }

  // --- アバターフォールバック率 (%) ---
  const totalAvatar = sumMap(avatarDelta);
  let avatarFallbackRate: number | null = null;
  if (totalAvatar > 0) {
    let fallbackCount = 0;
    for (const [key, count] of avatarDelta) {
      if (key.startsWith("error:") || key.startsWith("rate_limited:")) {
        fallbackCount += count;
      }
    }
    avatarFallbackRate = (fallbackCount / totalAvatar) * 100;
  }

  // --- 検索レイテンシ p95 (ms) ---
  // テナント横断で le ごとに集計してから p95 を推定
  const leAggregated = new Map<string, number>();
  for (const [key, count] of ragBucketDelta) {
    const le = key.split(":")[0];
    leAggregated.set(le, (leAggregated.get(le) ?? 0) + count);
  }
  const bucketList = Array.from(leAggregated.entries()).map(([le, count]) => ({
    le,
    count,
  }));
  const searchP95Ms = bucketList.length > 0 ? computeP95(bucketList) : null;

  // --- HTTP エラー率 (%) ---
  // 分母: 終了会話数 + HTTP エラー数（総リクエスト数の代替指標）
  const totalErrors = sumMap(httpDelta);
  const errorDenominator = totalConv + totalErrors;
  const errorRate =
    errorDenominator > 0 ? (totalErrors / errorDenominator) * 100 : null;

  return {
    timestamp: now,
    completionRate,
    loopRate,
    avatarFallbackRate,
    searchP95Ms,
    errorRate,
    killSwitchActive,
  };
}

// ---------------------------------------------------------------------------
// AlertEngine
// ---------------------------------------------------------------------------

export class AlertEngine {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private prevCounters: RawCounters | null = null;
  private readonly ruleStates = new Map<string, RuleState>();

  constructor() {
    for (const rule of ALERT_RULES) {
      this.ruleStates.set(rule.id, {
        violationStart: null,
        lastFiredAt: null,
        isFiring: false,
      });
    }
  }

  start(): void {
    if (this.intervalId !== null) return;
    logger.info(
      { intervalMs: EVAL_INTERVAL_MS, cooldownMs: COOLDOWN_MS },
      "[alert-engine] started"
    );
    this.intervalId = setInterval(() => {
      this.evaluate().catch((err: unknown) => {
        logger.error({ err }, "[alert-engine] evaluation error");
      });
    }, EVAL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("[alert-engine] stopped");
    }
  }

  /** テスト用: 手動で評価を実行 */
  async evaluate(): Promise<void> {
    const now = Date.now();
    let current: RawCounters;

    try {
      current = await collectRawCounters();
    } catch (err: unknown) {
      logger.error({ err }, "[alert-engine] failed to collect metrics");
      return;
    }

    const snapshot = computeSnapshot(current, this.prevCounters);
    this.prevCounters = current;

    for (const rule of ALERT_RULES) {
      const state = this.ruleStates.get(rule.id);
      if (!state) continue;

      const violated = rule.evaluate(snapshot);

      if (violated) {
        if (state.violationStart === null) {
          state.violationStart = now;
          logger.debug({ ruleId: rule.id }, "[alert-engine] violation started");
        }

        const violationDurationMs = now - state.violationStart;
        const cooldownElapsed =
          state.lastFiredAt === null ||
          now - state.lastFiredAt >= COOLDOWN_MS;

        if (violationDurationMs >= rule.durationMs && cooldownElapsed) {
          await this.fireAlert(rule, snapshot, state);
        }
      } else {
        if (state.isFiring) {
          await this.resolveAlert(rule, snapshot, state);
        }
        state.violationStart = null;
      }
    }
  }

  private async fireAlert(
    rule: AlertRule,
    snapshot: MetricsSnapshot,
    state: RuleState
  ): Promise<void> {
    state.isFiring = true;
    state.lastFiredAt = Date.now();

    try {
      await sendSlackAlert({
        ruleId: rule.id,
        name: rule.name,
        level: rule.level,
        status: "FIRING",
        details: buildAlertDetails(rule.id, snapshot),
      });
      logger.info(
        { ruleId: rule.id, level: rule.level },
        "[alert-engine] FIRING alert sent"
      );
    } catch (err: unknown) {
      logger.error({ err, ruleId: rule.id }, "[alert-engine] failed to send FIRING alert");
    }
  }

  private async resolveAlert(
    rule: AlertRule,
    snapshot: MetricsSnapshot,
    state: RuleState
  ): Promise<void> {
    state.isFiring = false;
    state.violationStart = null;

    try {
      await sendSlackAlert({
        ruleId: rule.id,
        name: rule.name,
        level: rule.level,
        status: "RESOLVED",
        details: buildAlertDetails(rule.id, snapshot),
      });
      logger.info({ ruleId: rule.id }, "[alert-engine] RESOLVED alert sent");
    } catch (err: unknown) {
      logger.error({ err, ruleId: rule.id }, "[alert-engine] failed to send RESOLVED alert");
    }
  }
}

// ---------------------------------------------------------------------------
// アラートメッセージ詳細テキスト構築
// PII・書籍内容を含めない
// ---------------------------------------------------------------------------

function buildAlertDetails(ruleId: string, snapshot: MetricsSnapshot): string {
  const lines: string[] = [
    `時刻: ${new Date(snapshot.timestamp).toISOString()}`,
  ];

  switch (ruleId) {
    case "completion_rate_low":
      if (snapshot.completionRate !== null) {
        lines.push(
          `会話完了率: ${snapshot.completionRate.toFixed(1)}%（閾値: 60%）`
        );
      }
      break;
    case "loop_rate_high":
      if (snapshot.loopRate !== null) {
        lines.push(
          `ループ検出率: ${snapshot.loopRate.toFixed(1)}%（閾値: 15%）`
        );
      }
      break;
    case "avatar_fallback_high":
      if (snapshot.avatarFallbackRate !== null) {
        lines.push(
          `アバターフォールバック率: ${snapshot.avatarFallbackRate.toFixed(1)}%（閾値: 50%）`
        );
      }
      break;
    case "search_latency_p95_high":
      if (snapshot.searchP95Ms !== null) {
        lines.push(
          `検索レイテンシ p95: ${snapshot.searchP95Ms.toFixed(0)}ms（閾値: 2000ms）`
        );
      }
      break;
    case "error_rate_high":
      if (snapshot.errorRate !== null) {
        lines.push(
          `エラー率: ${snapshot.errorRate.toFixed(1)}%（閾値: 3%）`
        );
      }
      break;
    case "kill_switch_active":
      lines.push("Kill Switch が発動中です。");
      break;
    default:
      break;
  }

  return lines.join("\n");
}

/** シングルトンインスタンス */
export const alertEngine = new AlertEngine();
