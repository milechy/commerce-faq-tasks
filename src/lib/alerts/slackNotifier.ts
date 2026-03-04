/**
 * Slack Incoming Webhook 通知クライアント
 *
 * 制約:
 *   - SLACK_WEBHOOK_URL は環境変数から取得（コードにハードコード禁止）
 *   - PII・書籍内容をメッセージに含めない
 *   - Webhook 未設定時はサイレントスキップ
 */

export type AlertLevel = "CRITICAL" | "WARNING" | "INFO";
export type AlertStatus = "FIRING" | "RESOLVED";

export interface AlertMessage {
  ruleId: string;
  name: string;
  level: AlertLevel;
  status: AlertStatus;
  details: string;
}

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  CRITICAL: "🚨",
  WARNING: "⚠️",
  INFO: "ℹ️",
};

export async function sendSlackAlert(message: AlertMessage): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  const emoji =
    message.status === "RESOLVED" ? "✅" : LEVEL_EMOJI[message.level];

  const text = [
    `${emoji} *[${message.level}] ${message.name}* — ${message.status}`,
    message.details,
  ].join("\n");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(
      `Slack webhook failed: ${response.status} ${response.statusText}`
    );
  }
}
