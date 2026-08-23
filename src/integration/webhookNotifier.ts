// src/integration/webhookNotifier.ts
import type pino from "pino";

export type RagStats = {
  plannerMs?: number;
  searchMs?: number;
  rerankMs?: number;
  answerMs?: number;
  totalMs?: number;
  rerankEngine?: string;
};

// PR-10 訂正 (2026-08-23): "agent.dialog.*" イベント種別と "/agent.dialog"
// エンドポイントは、その送信元だった AgentDialogOrchestrator/agentDialogRoute.ts
// が本番未配線の死コードと判明し削除されたため、ここでも削除した
// （コード上どこからも送信されていなかった。学習ループ監査R10/D5）。
export type AgentWebhookEvent = {
  type: "agent.search.completed" | "agent.search.error";
  timestamp: string;
  endpoint: "/agent.search";
  latencyMs?: number;
  // 今後 tenantId / requestId などを増やす余地を残しておく
  tenantId?: string;
  requestId?: string;

  meta?: {
    ragStats?: RagStats;

    // /agent.search 用フィールド
    topK?: number;
    debug?: boolean;
    useLlmPlanner?: boolean;
    stepsCount?: number;
  };

  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

export class WebhookNotifier {
  constructor(private logger: pino.Logger) {}

  async send(event: AgentWebhookEvent): Promise<void> {
    const url = process.env.N8N_WEBHOOK_URL;
    if (!url) return;

    const timeoutMs = Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || "2000");
    const extraHeader = process.env.N8N_WEBHOOK_AUTH_HEADER;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (extraHeader) {
      const [k, v] = extraHeader.split(":", 2);
      if (k && v) {
        headers[k.trim()] = v.trim();
      }
    }

    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);

      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(id);
    } catch (err) {
      this.logger.warn(
        { err, url },
        "failed to send webhook event (ignored)"
      );
    }
  }
}
