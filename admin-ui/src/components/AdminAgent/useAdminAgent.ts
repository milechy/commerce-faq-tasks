// admin-ui/src/components/AdminAgent/useAdminAgent.ts
//
// 【機能凍結】パネル(Surface A)側のチャット状態フック。新しい機能は足さず、全画面UI
// (pages/copilot-preview/index.tsx = Surface B)側だけに実装する。
// 根拠: docs/CHAT_SURFACE_DECISION.md が採択した選択肢(c)「パネルは橋。旧UIページの
// 閉鎖に合わせて畳む」。凍結の対象は「面固有の新機能」であって、共有層
// (lib/useAgentChatTransport.ts, lib/chatSessionStore.ts)のバグ修正は対象外。
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

// tenantId は super_adminのプレビュー切替で変わりうる。省略(undefined)した場合は
// chatSessionStore 側でテナント検証をスキップする(テナント概念を持たない呼び出しとの
// 後方互換。本番の唯一の呼び出し元 AdminAgentPanel は常に string | null を渡す)。
export function useAdminAgent(tenantId?: string | null): UseAdminAgentResult {
  // リロード・ブラウザバック・モバイルのタブ破棄で会話が丸ごと消えないよう、同一タブに
  // 保存された会話を復元する。全画面UI(/copilot-preview)とは別キーのため、2面の会話は
  // 互いに独立している。これは意図的な決定で、理由は lib/chatSessionStore.ts のヘッダと
  // docs/CHAT_SURFACE_DECISION.md 「§5 補記」にある。
  //
  // tenantId を渡して復元時に検証する — super_adminがプレビュー中に別テナントへ切り替えた
  // 場合、キーはsurfaceのみでテナントを区別しないため、検証しないと前テナントの会話が
  // 「復元成功」として通ってしまう(全画面UI側で発覚した同型のバグの回避)。
  const [restored] = useState(() => restoreChatSession<AgentMessage>(CHAT_SESSION_SURFACE_PANEL, tenantId));
  const [messages, setMessages] = useState<AgentMessage[]>(restored?.messages ?? []);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const { sessionId, send } = useAgentChatTransport({
    surface: "panel",
    initialSessionId: restored?.sessionId,
  });

  useEffect(() => {
    if (messages.length === 0) return;
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, { sessionId, messages, tenantId });
  }, [messages, sessionId, tenantId]);

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
