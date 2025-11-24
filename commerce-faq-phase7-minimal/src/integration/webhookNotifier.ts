// src/integration/webhookNotifier.ts
import type pino from "pino";

export type RagStats = {
  search_ms?: number;
  rerank_ms?: number;
  rerank_engine?: string;
  total_ms?: number;
};

export type AgentWebhookEvent = {
  type:
    | "agent.dialog.completed"
    | "agent.dialog.fallback"
    | "agent.dialog.error"
    | "agent.search.completed"
    | "agent.search.error";
  timestamp: string;
  endpoint: "/agent.dialog" | "/agent.search";
  latencyMs?: number;
  // 今後 tenantId / requestId などを増やす余地を残しておく
  tenantId?: string;
  requestId?: string;

  meta?: {
    orchestratorMode?: string;
    route?: string;
    groq429Fallback?: boolean;
    hasLanggraphError?: boolean;
    groqBackoffRemainingMs?: number | null;
    ragStats?: RagStats;
    needsClarification?: boolean;
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
        "failed to send webhook event to n8n (ignored)"
      );
    }
  }
}
