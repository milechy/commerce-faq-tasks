// admin-ui/src/components/AdminAgent/useAdminAgent.ts
import { useState, useCallback, useEffect } from "react";
import {
  CHAT_SESSION_SURFACE_PANEL,
  restoreChatSession,
  saveChatSession,
} from "../../lib/chatSessionStore";
import { useAgentChatTransport } from "../../lib/useAgentChatTransport";
import type { AgentAction, AnsweredFrom } from "../../lib/useAgentChatTransport";

// transport 層(sessionId / 履歴ウィンドウ / targetTenantId 導出 / エラー文言)と
// レスポンス型は、全画面UI(/copilot-preview)と共有する lib/useAgentChatTransport.ts が持つ。
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
  // リロード・ブラウザバック・モバイルのタブ破棄で会話が丸ごと消えないよう、同一タブに
  // 保存された会話を復元する。全画面UI(/copilot-preview)とは別キーのため、2面の会話は
  // 互いに独立している(lib/chatSessionStore.ts 参照)。
  const [restored] = useState(() => restoreChatSession<AgentMessage>(CHAT_SESSION_SURFACE_PANEL));
  const [messages, setMessages] = useState<AgentMessage[]>(restored?.messages ?? []);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const { sessionId, send } = useAgentChatTransport({
    surface: "panel",
    initialSessionId: restored?.sessionId,
  });

  useEffect(() => {
    if (messages.length === 0) return;
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, { sessionId, messages });
  }, [messages, sessionId]);

  const sendMessage = useCallback(async (text: string, targetTenantId?: string) => {
    if (!text.trim() || isLoading) return;

    // このターンで追加するユーザーメッセージより前の履歴を渡す(件数・文字数の上限は transport 側)
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    // optimistic にユーザーメッセージを追加
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);

    try {
      const result = await send(text, { history, targetTenantId });

      setMessages((prev) => [
        ...prev,
        result.ok
          ? {
              role: "assistant",
              content: result.data.reply,
              actions: result.data.actions,
              answeredFrom: result.data.answered_from,
            }
          : { role: "assistant", content: result.message, actions: [] },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, messages, send]);

  return {
    messages,
    isOpen,
    isLoading,
    sessionId,
    setIsOpen,
    sendMessage,
  };
}
