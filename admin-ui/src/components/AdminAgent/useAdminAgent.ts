// admin-ui/src/components/AdminAgent/useAdminAgent.ts
import { useState, useCallback } from "react";
import { authFetch, API_BASE } from "../../lib/api";

export type AnsweredFrom = "faq_list" | "tool_action" | "general";

// バックエンド(actionExecutor.ts の LegacyLinkCardPayload)が自然文に添えて返す
// 構造化カード。現時点で card を返すのは get_legacy_ui_link だけで、他のツールは
// 従来どおり result の自然文のみ。このパネル(Surface A)はまだ card を描画しないが、
// /copilot-preview と同じレスポンスを消費するため型は共通にしておく。
export type AgentActionCard = {
  kind: "legacy_link";
  label: string;
  url: string;
  description: string;
};

export type AgentAction = { tool: string; result: string; card?: AgentActionCard };

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  actions?: AgentAction[];
  needsConfirmation?: boolean;
  answeredFrom?: AnsweredFrom;
}

interface UseAdminAgentResult {
  messages: AgentMessage[];
  isOpen: boolean;
  isLoading: boolean;
  sessionId: string;
  setIsOpen: (open: boolean) => void;
  sendMessage: (text: string, targetTenantId?: string) => Promise<void>;
}

export function useAdminAgent(): UseAdminAgentResult {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // セッションIDはコンポーネントのライフタイム中に一度だけ生成
  const [sessionId] = useState<string>(() => crypto.randomUUID());

  const sendMessage = useCallback(async (text: string, targetTenantId?: string) => {
    if (!text.trim() || isLoading) return;

    // G2: サーバはステートレスなので、直近の会話履歴を毎回送ってマルチターンの文脈を持たせる
    // （このターンで追加するユーザーメッセージより前の履歴。直近20件・各4000字までに制限）
    const history = messages
      .filter((m) => m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    // optimistic にユーザーメッセージを追加
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);

    try {
      const body: { message: string; sessionId: string; targetTenantId?: string; history?: typeof history } = {
        message: text,
        sessionId,
      };
      if (targetTenantId) {
        body.targetTenantId = targetTenantId;
      }
      if (history.length > 0) {
        body.history = history;
      }

      const res = await authFetch(`${API_BASE}/v1/admin/agent/chat`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "うまく送信できませんでした。少し時間をおいてお試しください。",
            actions: [],
          },
        ]);
        return;
      }

      const data = (await res.json()) as {
        reply: string;
        actions: AgentAction[];
        answered_from?: AnsweredFrom;
      };

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply,
          actions: data.actions,
          answeredFrom: data.answered_from,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "うまく送信できませんでした。少し時間をおいてお試しください。",
          actions: [],
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, sessionId, messages]);

  return {
    messages,
    isOpen,
    isLoading,
    sessionId,
    setIsOpen,
    sendMessage,
  };
}
