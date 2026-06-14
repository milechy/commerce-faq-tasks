// admin-ui/src/components/AdminAgent/useAdminAgent.ts
import { useState, useCallback } from "react";
import { authFetch, API_BASE } from "../../lib/api";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  actions?: { tool: string; result: string }[];
  needsConfirmation?: boolean;
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

    // optimistic にユーザーメッセージを追加
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);

    try {
      const body: { message: string; sessionId: string; targetTenantId?: string } = {
        message: text,
        sessionId,
      };
      if (targetTenantId) {
        body.targetTenantId = targetTenantId;
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
        actions: { tool: string; result: string }[];
      };

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply,
          actions: data.actions,
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
  }, [isLoading, sessionId]);

  return {
    messages,
    isOpen,
    isLoading,
    sessionId,
    setIsOpen,
    sendMessage,
  };
}
