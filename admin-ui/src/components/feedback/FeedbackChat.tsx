// admin-ui/src/components/feedback/FeedbackChat.tsx
// Client Admin用フローティングチャットUI

import { useState, useEffect, useRef, useCallback } from "react";
import { useLang } from "../../i18n/LangContext";
import { authFetch, API_BASE } from "../../lib/api";

interface Message {
  id: number;
  tenant_id: string;
  sender_role: "client_admin" | "super_admin";
  sender_email: string | null;
  content: string;
  is_read: boolean;
  created_at: string;
}

interface FeedbackChatProps {
  tenantId: string;
}

export default function FeedbackChat({ tenantId }: FeedbackChatProps) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const locale = lang === "en" ? "en-US" : "ja-JP";

  const fetchMessages = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback?tenant=${encodeURIComponent(tenantId)}`);
      if (!res.ok) return;
      const data = await res.json() as { messages: Message[] };
      setMessages(data.messages ?? []);
      setUnreadCount(0); // 開いたら既読
    } catch { /* silent */ }
  }, [tenantId]);

  const fetchUnread = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback/unread-count`);
      if (!res.ok) return;
      const data = await res.json() as { count: number };
      setUnreadCount(data.count);
    } catch { /* silent */ }
  }, []);

  // 閉じている間は未読数をポーリング
  useEffect(() => {
    void fetchUnread();
    const interval = setInterval(() => { void fetchUnread(); }, 30000);
    return () => clearInterval(interval);
  }, [fetchUnread]);

  // 開いたらメッセージを取得
  useEffect(() => {
    if (open) void fetchMessages();
  }, [open, fetchMessages]);

  // 新メッセージが来たら下にスクロール
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setInput("");
        void fetchMessages();
      } else {
        console.error("[feedback] send failed:", res.status);
      }
    } catch (err) {
      console.error("[feedback] send error:", err);
    } finally {
      setSending(false);
    }
  };

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      {/* FABボタン */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 9000,
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: "none",
          background: "linear-gradient(135deg, #3b82f6, #6366f1)",
          color: "#fff",
          fontSize: 22,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 20px rgba(59,130,246,0.5)",
        }}
        title={t("feedback.support_button")}
      >
        💬
        {unreadCount > 0 && (
          <span style={{
            position: "absolute",
            top: -4, right: -4,
            width: 20, height: 20,
            borderRadius: "50%",
            background: "#ef4444",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid #0f172a",
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* チャットウィンドウ */}
      {open && (
        <div style={{
          position: "fixed",
          bottom: 90,
          right: 24,
          zIndex: 9000,
          width: 340,
          maxHeight: 520,
          borderRadius: 16,
          border: "1px solid #1f2937",
          background: "#0f172a",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* ヘッダー */}
          <div style={{
            padding: "14px 16px",
            background: "linear-gradient(135deg, #1e3a5f, #1e1b4b)",
            borderBottom: "1px solid #1f2937",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb" }}>
              💬 {t("feedback.support_button")}
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </div>

          {/* メッセージ一覧 */}
          <div style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: 200,
            maxHeight: 360,
          }}>
            {/* ウェルカムメッセージ（常に先頭に表示） */}
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 4 }}>
              <div style={{
                background: "rgba(75, 85, 99, 0.8)",
                borderRadius: 12,
                padding: "8px 12px",
                maxWidth: "80%",
                color: "#f9fafb",
                fontSize: 13,
                lineHeight: 1.6,
                textAlign: "left",
              }}>
                <p style={{ margin: 0 }}>こんにちは！RAJIUCE管理画面のサポートです。</p>
                <p style={{ margin: "4px 0 0" }}>改善のご要望や使い方のご質問など、お気軽にどうぞ。</p>
              </div>
            </div>
            {messages.map((msg) => {
              const isMe = msg.sender_role === "client_admin";
              return (
                <div key={msg.id} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                  <div style={{
                    display: "flex",
                    justifyContent: isMe ? "flex-end" : "flex-start",
                    width: "100%",
                  }}>
                    <div style={{
                      maxWidth: "80%",
                      padding: "9px 13px",
                      borderRadius: isMe ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                      background: isMe ? "rgba(59,130,246,0.25)" : "rgba(75,85,99,0.8)",
                      border: isMe ? "1px solid rgba(59,130,246,0.4)" : "1px solid #374151",
                      color: "#f9fafb",
                      fontSize: 14,
                      lineHeight: 1.5,
                      wordBreak: "break-word",
                      textAlign: "left",
                    }}>
                      {msg.content}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                    {formatTime(msg.created_at)}
                  </span>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* 入力欄 */}
          <div style={{
            padding: "10px 12px",
            borderTop: "1px solid #1f2937",
            display: "flex",
            gap: 8,
          }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={t("feedback.placeholder")}
              rows={2}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                fontFamily: "inherit",
                resize: "none",
                outline: "none",
              }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || sending}
              style={{
                padding: "8px 14px",
                borderRadius: 10,
                border: "none",
                background: input.trim() && !sending
                  ? "linear-gradient(135deg, #3b82f6, #6366f1)"
                  : "rgba(59,130,246,0.3)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: input.trim() && !sending ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
                alignSelf: "flex-end",
              }}
            >
              {sending ? "..." : t("feedback.send")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
