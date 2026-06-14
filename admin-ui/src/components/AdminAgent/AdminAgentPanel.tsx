// admin-ui/src/components/AdminAgent/AdminAgentPanel.tsx
import { useRef, useEffect, useState, useCallback } from "react";
import { useAdminAgent } from "./useAdminAgent";
import AdminAgentMessage from "./AdminAgentMessage";

interface AdminAgentPanelProps {
  isOpen: boolean;
  onClose: () => void;
  tenantId: string | null;
  isSuperAdmin: boolean;
}

const INITIAL_MESSAGE = "こんにちは！設定の変更やFAQの追加など、何でもお手伝いします。";

export default function AdminAgentPanel({
  isOpen,
  onClose,
  tenantId,
  isSuperAdmin,
}: AdminAgentPanelProps) {
  const { messages, isLoading, sendMessage } = useAdminAgent();
  const [input, setInput] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 最新メッセージへ自動スクロール
  useEffect(() => {
    if (isOpen) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  // パネルが開いたら入力欄にフォーカス
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    // super_admin のみ targetTenantId を送る
    const targetTenantId = isSuperAdmin ? (tenantId ?? undefined) : undefined;
    await sendMessage(text, targetTenantId);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [input, isLoading, isSuperAdmin, tenantId, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault();
      void handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 80,
        right: 24,
        width: 380,
        height: 600,
        borderRadius: 16,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(15,23,42,0.98)",
        backdropFilter: "blur(12px)",
        display: "flex",
        flexDirection: "column",
        zIndex: 902,
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        overflow: "hidden",
        // モバイル 390px 対応: 画面幅が狭い場合は width を調整
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 18 }}>{"✨"}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f9fafb" }}>
            R2C AIアシスタント
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="閉じる"
          style={{
            background: "none",
            border: "none",
            color: "#6b7280",
            fontSize: 18,
            cursor: "pointer",
            padding: 4,
            minHeight: 44,
            minWidth: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
          }}
        >
          {"✕"}
        </button>
      </div>

      {/* メッセージエリア */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {/* 初期メッセージ */}
        <AdminAgentMessage
          message={{ role: "assistant", content: INITIAL_MESSAGE }}
        />

        {messages.map((msg, i) => (
          <AdminAgentMessage key={i} message={msg} />
        ))}

        {isLoading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                padding: "9px 13px",
                borderRadius: "12px 12px 12px 4px",
                background: "var(--card, rgba(30,41,59,0.9))",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#9ca3af",
                fontSize: 14,
              }}
            >
              考え中...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 入力エリア */}
      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          flexShrink: 0,
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder="質問を入力… (Enterで送信、Shift+Enterで改行)"
          rows={1}
          disabled={isLoading}
          style={{
            flex: 1,
            resize: "none",
            background: "rgba(30,41,59,0.8)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            color: "#f9fafb",
            fontSize: 14,
            padding: "10px 12px",
            outline: "none",
            fontFamily: "inherit",
            lineHeight: 1.5,
            minHeight: 44,
            maxHeight: 100,
          }}
        />
        <button
          onClick={() => void handleSend()}
          disabled={isLoading || !input.trim()}
          aria-label="送信"
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 10,
            border: "none",
            background:
              isLoading || !input.trim()
                ? "rgba(99,102,241,0.3)"
                : "linear-gradient(135deg, #6366f1, #4f46e5)",
            color: "#fff",
            fontSize: 18,
            cursor: isLoading || !input.trim() ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {"↑"}
        </button>
      </div>
    </div>
  );
}
