// src/agent/openclaw/heartbeatHandler.ts
// Phase47-D: OpenClaw Heartbeat — flow セッション統計を 30 分周期で監視し、
// stall / abort レートが閾値を超えたら Slack へアラートする。
//
// 制約:
//   - アラートにはカウントとレートのみ含める（会話内容・PII・テナント固有情報は禁止）
//   - Slack 送信失敗は non-blocking（catch して logger.warn、throw しない）
//   - cooldown: 前回発火から 30 分未満は再発火しない

import pino from "pino";
import { snapshotFlowSessionMetas } from "../dialog/flowContextStore";
import { sendSlackAlert } from "../../lib/alerts/slackNotifier";

const logger = pino({ name: "openclaw-heartbeat" });

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30分
const COOLDOWN_MS = 30 * 60 * 1000; // 30分

const STALL_RATE_THRESHOLD = 0.2;
const ABORT_RATE_THRESHOLD = 0.3;

let intervalHandle: NodeJS.Timeout | null = null;
let lastAlertAt: number | null = null;

/**
 * グローバル Flag 判定（featureFlag.ts のマスタースイッチと同一ロジック）。
 * heartbeat はテナント横断のため OPENCLAW_TENANTS は見ない。
 */
function isGloballyEnabled(): boolean {
  return process.env.OPENCLAW_ENABLED === "true";
}

export async function evaluateHeartbeat(): Promise<void> {
  const terminated = snapshotFlowSessionMetas().filter(
    (meta) => meta.terminalReason !== undefined
  );
  const total = terminated.length;
  if (total === 0) return; // ゼロ除算・空アラート防止

  const stallCount = terminated.filter(
    (meta) => meta.terminalReason === "aborted_loop_detected"
  ).length;
  const abortCount = terminated.filter(
    (meta) =>
      meta.terminalReason === "aborted_user" ||
      meta.terminalReason === "aborted_budget" ||
      meta.terminalReason === "failed_safe_mode"
  ).length;

  const stallRate = stallCount / total;
  const abortRate = abortCount / total;

  if (stallRate <= STALL_RATE_THRESHOLD && abortRate <= ABORT_RATE_THRESHOLD) {
    return;
  }

  const now = Date.now();
  if (lastAlertAt !== null && now - lastAlertAt < COOLDOWN_MS) {
    return; // cooldown 中は再発火しない
  }
  lastAlertAt = now;

  logger.warn({ stallRate, abortRate, total }, "openclaw.heartbeat.alert");

  try {
    // カウントとレートのみ（会話内容・PII・テナント固有情報を含めない）
    await sendSlackAlert({
      ruleId: "openclaw-heartbeat",
      name: "OpenClaw Heartbeat — flow stall/abort rate",
      level: "WARNING",
      status: "FIRING",
      details: [
        `stall_rate=${stallRate.toFixed(3)} (${stallCount}/${total}, threshold ${STALL_RATE_THRESHOLD})`,
        `abort_rate=${abortRate.toFixed(3)} (${abortCount}/${total}, threshold ${ABORT_RATE_THRESHOLD})`,
      ].join("\n"),
    });
  } catch (err) {
    logger.warn({ err }, "openclaw.heartbeat.slack_send_failed");
  }
}

export function startOpenClawHeartbeat(): void {
  if (!isGloballyEnabled()) return; // グローバル Flag オフは no-op
  if (intervalHandle) return; // 二重起動ガード

  intervalHandle = setInterval(() => {
    evaluateHeartbeat().catch((err) => {
      logger.warn({ err }, "openclaw.heartbeat.evaluate_failed");
    });
  }, HEARTBEAT_INTERVAL_MS);
  intervalHandle.unref(); // プロセス終了 / jest をブロックしない
}

export function stopOpenClawHeartbeat(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  lastAlertAt = null;
}
