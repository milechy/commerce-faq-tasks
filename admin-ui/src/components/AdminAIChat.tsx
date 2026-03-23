// admin-ui/src/components/AdminAIChat.tsx
// Phase43 P1: 管理画面サポートAI — フローティングチャットパネル

import { useState, useRef, useEffect, useCallback } from "react";
import { authFetch, API_BASE } from "../lib/api";

type Intent = "admin_guide" | "business_faq";

interface Message {
  role: "user" | "assistant";
  content: string;
  unanswered?: boolean;
  intent?: Intent;
}

const PANEL_W = 320;
const PANEL_H = 420;
// FeedbackChat が bottom:24 right:24 (56px幅) に固定されているため
// AdminAIChat はその左隣に配置する (24 + 56 + 8 = 88)
const FAB_RIGHT = 88;
const PANEL_RIGHT = 88;

export default function AdminAIChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // スクロールを末尾に保つ
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  // パネル外クリックで閉じる
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const res = await authFetch(`${API_BASE}/v1/admin/ai-assist/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "エラーが発生しました。しばらくしてから再度お試しください。" },
        ]);
        return;
      }

      const data = await res.json() as { answer: string; ai_answered: boolean; feedback_id: string | null; intent?: Intent };
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer, unanswered: !data.ai_answered, intent: data.intent },
      ]);

    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "通信エラーが発生しました。" },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <>
      {/* フローティングボタン */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="AIサポートを開く"
        style={{
          position: "fixed",
          bottom: 24,
          right: FAB_RIGHT,
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: "none",
          background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
          color: "#fff",
          fontSize: 22,
          cursor: "pointer",
          boxShadow: "0 4px 20px rgba(124,58,237,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 900,
          transition: "transform 0.15s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.1)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
      >
        {open ? "✕" : "?"}
      </button>

      {/* チャットパネル */}
      {open && (
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            bottom: 88,
            right: PANEL_RIGHT,
            width: PANEL_W,
            height: PANEL_H,
            borderRadius: 16,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.98)",
            backdropFilter: "blur(12px)",
            display: "flex",
            flexDirection: "column",
            zIndex: 901,
            boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            overflow: "hidden",
          }}
        >
          {/* ヘッダー */}
          <div style={{
            padding: "12px 16px",
            borderBottom: "1px solid #1f2937",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f9fafb" }}>AIサポート</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>管理画面の使い方をお答えします</div>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "#6b7280",
                fontSize: 18,
                cursor: "pointer",
                padding: 4,
                minHeight: 32,
                minWidth: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>

          {/* メッセージエリア */}
          <div style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", color: "#6b7280", fontSize: 13, paddingTop: 40 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
                管理画面の使い方についてご質問ください
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div style={{
                  maxWidth: "85%",
                  padding: "9px 13px",
                  borderRadius: msg.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                  background: msg.role === "user"
                    ? "linear-gradient(135deg, #3b82f6, #6366f1)"
                    : msg.intent === "business_faq"
                    ? "rgba(16,57,40,0.9)"
                    : "rgba(30,41,59,0.9)",
                  border: msg.role === "assistant"
                    ? msg.intent === "business_faq" ? "1px solid rgba(34,197,94,0.25)" : "1px solid #1f2937"
                    : "none",
                  color: "#f9fafb",
                  fontSize: 14,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {msg.content}
                  {msg.role === "assistant" && msg.intent === "business_faq" && !msg.unanswered && (
                    <div style={{ fontSize: 11, color: "rgba(209,250,229,0.7)", marginTop: 4, fontStyle: "italic" }}>
                      ※ ご登録のFAQを参照し回答しています
                    </div>
                  )}
                  {msg.role === "assistant" && msg.intent === "business_faq" && msg.unanswered && (
                    <div style={{ fontSize: 11, color: "rgba(249,115,22,0.7)", marginTop: 4, fontStyle: "italic" }}>
                      ※ この質問に該当するFAQが見つかりませんでした
                    </div>
                  )}
                  {msg.intent !== "business_faq" && msg.unanswered && (
                    <div style={{ fontSize: 11, color: "#f97316", marginTop: 4 }}>
                      ※ フィードバックとして記録しました
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div style={{
                  padding: "9px 13px",
                  borderRadius: "12px 12px 12px 4px",
                  background: "rgba(30,41,59,0.9)",
                  border: "1px solid #1f2937",
                  color: "#9ca3af",
                  fontSize: 14,
                }}>
                  考え中...
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* 入力エリア */}
          <div style={{
            padding: "10px 12px",
            borderTop: "1px solid #1f2937",
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="質問を入力… (Enterで送信)"
              rows={1}
              style={{
                flex: 1,
                resize: "none",
                background: "rgba(30,41,59,0.8)",
                border: "1px solid #374151",
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
              disabled={loading}
            />
            <button
              onClick={() => void handleSend()}
              disabled={loading || !input.trim()}
              style={{
                minWidth: 44,
                minHeight: 44,
                borderRadius: 10,
                border: "none",
                background: loading || !input.trim()
                  ? "rgba(124,58,237,0.3)"
                  : "linear-gradient(135deg, #7c3aed, #6d28d9)",
                color: "#fff",
                fontSize: 18,
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-label="送信"
            >
              ↑
            </button>
          </div>
        </div>
      )}

    </>
  );
}
