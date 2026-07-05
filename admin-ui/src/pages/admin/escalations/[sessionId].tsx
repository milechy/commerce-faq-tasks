// admin-ui/src/pages/admin/escalations/[sessionId].tsx
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション — 会話詳細+返信

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { MessageList } from "../chat-history/MessageList";
import type { Message } from "../chat-history/types";

const POLL_INTERVAL_MS = 5000;

export default function EscalationDetailPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { t, lang } = useLang();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const locale = lang === "en" ? "en-US" : "ja-JP";

  const loadMessages = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/chat-history/sessions/${sessionId}/messages`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { messages: Message[] };
      setMessages(data.messages ?? []);
      setError(null);
    } catch {
      setError("会話の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadMessages();
    const timer = setInterval(() => void loadMessages(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleSend = async () => {
    if (!sessionId || !replyText.trim() || sending) return;
    setSending(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/chat-history/sessions/${sessionId}/reply`, {
        method: "POST",
        body: JSON.stringify({ content: replyText.trim() }),
      });
      if (!res.ok) throw new Error();
      setReplyText("");
      await loadMessages();
    } catch {
      showToast("❌ 送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const handleResolve = async () => {
    if (!sessionId || resolving) return;
    setResolving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/chat-history/sessions/${sessionId}/resolve-escalation`, {
        method: "PATCH",
      });
      if (!res.ok) throw new Error();
      showToast("✅ 対応完了にしました");
      setTimeout(() => navigate("/admin/escalations"), 800);
    } catch {
      showToast("❌ 対応完了の記録に失敗しました");
      setResolving(false);
    }
  };

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "24px 20px",
        maxWidth: 700,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin/escalations")}
            style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            ← 対応中会話一覧に戻る
          </button>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            🙋 有人対応中の会話
          </h1>
        </div>
        <LangSwitcher />
      </header>

      <button
        onClick={() => void handleResolve()}
        disabled={resolving}
        style={{
          alignSelf: "flex-end",
          marginBottom: 16,
          padding: "10px 18px",
          minHeight: 44,
          borderRadius: 10,
          border: "none",
          background: resolving ? "#166534" : "linear-gradient(135deg, #22c55e, #4ade80)",
          color: "#022c22",
          fontSize: 14,
          fontWeight: 700,
          cursor: resolving ? "not-allowed" : "pointer",
        }}
      >
        {resolving ? "処理中..." : "✅ 対応完了にする"}
      </button>

      {error && (
        <div style={{ marginBottom: 16, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 300,
          maxHeight: "55vh",
          overflowY: "auto",
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: "var(--card)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>
            <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
            {t("chat_history.loading")}
          </div>
        ) : (
          <>
            <MessageList messages={messages} formatTime={formatTime} handleCreateRule={() => {}} />
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="お客様への返信を入力してください..."
          rows={2}
          style={{
            flex: 1,
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--muted)",
            color: "var(--foreground)",
            fontSize: 15,
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
        <button
          onClick={() => void handleSend()}
          disabled={sending || !replyText.trim()}
          style={{
            padding: "12px 22px",
            minHeight: 48,
            borderRadius: 12,
            border: "none",
            background: sending || !replyText.trim() ? "#1e3a5f" : "linear-gradient(135deg, #1d4ed8, #3b82f6)",
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            cursor: sending || !replyText.trim() ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {sending ? "送信中..." : "送信"}
        </button>
      </div>

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            padding: "14px 24px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.95)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
            fontSize: 15,
            fontWeight: 600,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
