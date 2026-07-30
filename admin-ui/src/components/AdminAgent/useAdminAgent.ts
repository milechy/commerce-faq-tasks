// admin-ui/src/components/AdminAgent/useAdminAgent.ts
import { useState, useCallback, useEffect } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import {
  CHAT_SESSION_SURFACE_PANEL,
  restoreChatSession,
  saveChatSession,
} from "../../lib/chatSessionStore";

export type AnsweredFrom = "faq_list" | "tool_action" | "general";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  actions?: { tool: string; result: string }[];
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
  // リロード・ブラウザバック・モバイルのタブ破棄で会話が丸ごと消えないよう、同一タブに
  // 保存された会話を復元する。全画面UI(/copilot-preview)とは別キーのため、2面の会話は
  // 互いに独立している(lib/chatSessionStore.ts 参照)。
  const [restored] = useState(() => restoreChatSession<AgentMessage>(CHAT_SESSION_SURFACE_PANEL));
  const [messages, setMessages] = useState<AgentMessage[]>(restored?.messages ?? []);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // セッションIDはコンポーネントのライフタイム中に一度だけ生成(復元できた場合はその続き)
  const [sessionId] = useState<string>(() => restored?.sessionId ?? crypto.randomUUID());

  useEffect(() => {
    if (messages.length === 0) return;
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, { sessionId, messages });
  }, [messages, sessionId]);

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
        actions: { tool: string; result: string }[];
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
