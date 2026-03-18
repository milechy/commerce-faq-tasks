import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface SessionInfo {
  id: string;
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
}

async function fetchMessages(
  sessionDbId: string,
  tenantId?: string
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (tenantId) params.set("tenant", tenantId);
  const res = await authFetch(
    `${API_BASE}/v1/admin/chat-history/sessions/${sessionDbId}/messages?${params}`
  );
  if (!res.ok) throw new Error("Failed to fetch messages");
  const data = await res.json();
  return data.messages as Message[];
}

export default function ChatHistorySessionPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { t, lang } = useLang();
  const { user, isSuperAdmin } = useAuth();
  const location = useLocation();

  const sessionFromState = (location.state as { session?: SessionInfo } | null)?.session ?? null;

  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(sessionFromState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const tenantId = isSuperAdmin ? undefined : (user?.tenantId ?? undefined);

  const loadMessages = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMessages(sessionId, tenantId);
      setMessages(data);
      // If session info wasn't passed via nav state, fill in what we can
      if (!sessionInfo) {
        setSessionInfo({
          id: sessionId,
          tenant_id: tenantId ?? "",
          session_id: sessionId,
          started_at: data[0]?.created_at ?? new Date().toISOString(),
          last_message_at: data[data.length - 1]?.created_at ?? new Date().toISOString(),
          message_count: data.length,
        });
      }
    } catch {
      setError("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [sessionId, tenantId, sessionInfo]);

  useEffect(() => {
    void loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });

  const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleCreateRule = (assistantMsg: Message) => {
    const msgIndex = messages.findIndex((m) => m.id === assistantMsg.id);
    const userMsg =
      msgIndex > 0 && messages[msgIndex - 1].role === "user"
        ? messages[msgIndex - 1].content
        : "";

    const params = new URLSearchParams({
      create: "1",
      userMsg,
      assistantMsg: assistantMsg.content,
    });
    navigate(`/admin/tuning?${params.toString()}`);
  };

  if (!loading && error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
          color: "#e5e7eb",
          padding: "24px 20px",
          maxWidth: 900,
          margin: "0 auto",
        }}
      >
        <button
          onClick={() => navigate("/admin/chat-history")}
          style={{
            background: "none",
            border: "none",
            color: "#9ca3af",
            fontSize: 14,
            cursor: "pointer",
            padding: 0,
            marginBottom: 24,
            display: "block",
          }}
        >
          {t("chat_history.back_to_list")}
        </button>
        <div
          style={{
            padding: "32px 20px",
            borderRadius: 14,
            border: "1px solid rgba(248,113,113,0.3)",
            background: "rgba(127,29,29,0.2)",
            color: "#fca5a5",
            textAlign: "center",
            fontSize: 15,
          }}
        >
          <p style={{ margin: "0 0 16px" }}>{error}</p>
          <button
            onClick={() => void loadMessages()}
            style={{
              padding: "10px 20px",
              minHeight: 44,
              borderRadius: 10,
              border: "1px solid rgba(248,113,113,0.4)",
              background: "rgba(248,113,113,0.1)",
              color: "#fca5a5",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <header style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <button
            onClick={() => navigate("/admin/chat-history")}
            style={{
              background: "none",
              border: "none",
              color: "#9ca3af",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              marginBottom: 8,
              display: "block",
            }}
          >
            {t("chat_history.back_to_list")}
          </button>
          <LangSwitcher />
        </div>

        <div
          style={{
            borderRadius: 14,
            border: "1px solid #1f2937",
            background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
            padding: "18px 20px",
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "center",
          }}
        >
          {sessionInfo && (
            <>
              <span
                style={{
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: "rgba(34,197,94,0.15)",
                  border: "1px solid rgba(34,197,94,0.3)",
                  color: "#4ade80",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {sessionInfo.tenant_id}
              </span>
              <span style={{ fontSize: 13, color: "#6b7280" }}>
                🕐 {formatDateTime(sessionInfo.started_at)}
              </span>
            </>
          )}
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            💬{" "}
            {t("chat_history.message_count").replace(
              "{n}",
              String(messages.length)
            )}
          </span>
          {sessionInfo && (
            <span style={{ fontSize: 11, color: "#4b5563", fontFamily: "monospace", marginLeft: "auto" }}>
              {sessionInfo.session_id.slice(0, 8)}…
            </span>
          )}
        </div>
      </header>

      {/* Loading */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("chat_history.loading")}
        </div>
      ) : (
        /* Messages */
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              {/* Role label */}
              <span
                style={{
                  fontSize: 12,
                  color: "#6b7280",
                  marginBottom: 4,
                  paddingLeft: msg.role === "user" ? 0 : 4,
                  paddingRight: msg.role === "user" ? 4 : 0,
                }}
              >
                {msg.role === "user"
                  ? t("chat_history.user_message")
                  : t("chat_history.assistant_message")}
                {" · "}
                {formatTime(msg.created_at)}
              </span>

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 8,
                  flexDirection: msg.role === "user" ? "row-reverse" : "row",
                  maxWidth: "80%",
                }}
              >
                {/* Bubble */}
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                    background:
                      msg.role === "user"
                        ? "linear-gradient(135deg, #2563eb, #3b82f6)"
                        : "rgba(31,41,55,0.9)",
                    border:
                      msg.role === "user"
                        ? "none"
                        : "1px solid #374151",
                    color: msg.role === "user" ? "#fff" : "#e5e7eb",
                    fontSize: 15,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    boxShadow: msg.role === "user"
                      ? "0 4px 12px rgba(37,99,235,0.3)"
                      : "0 4px 12px rgba(0,0,0,0.2)",
                  }}
                >
                  {msg.content}

                  {/* Metadata badges for assistant */}
                  {msg.role === "assistant" && msg.metadata && (
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      {typeof msg.metadata.model === "string" && (
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "rgba(55,65,81,0.8)",
                            border: "1px solid #4b5563",
                            color: "#9ca3af",
                            fontSize: 11,
                            fontFamily: "monospace",
                          }}
                        >
                          {msg.metadata.model}
                        </span>
                      )}
                      {typeof msg.metadata.route === "string" && (
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "rgba(34,197,94,0.1)",
                            border: "1px solid rgba(34,197,94,0.25)",
                            color: "#4ade80",
                            fontSize: 11,
                          }}
                        >
                          {msg.metadata.route}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Create rule button for assistant messages */}
                {msg.role === "assistant" && (
                  <button
                    onClick={() => handleCreateRule(msg)}
                    title={t("chat_history.create_rule")}
                    style={{
                      padding: "6px 10px",
                      minHeight: 44,
                      borderRadius: 10,
                      border: "1px solid #374151",
                      background: "rgba(15,23,42,0.8)",
                      color: "#9ca3af",
                      fontSize: 13,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      transition: "border-color 0.15s, color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      const btn = e.currentTarget as HTMLButtonElement;
                      btn.style.borderColor = "#4b5563";
                      btn.style.color = "#e5e7eb";
                    }}
                    onMouseLeave={(e) => {
                      const btn = e.currentTarget as HTMLButtonElement;
                      btn.style.borderColor = "#374151";
                      btn.style.color = "#9ca3af";
                    }}
                  >
                    🎛️
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
