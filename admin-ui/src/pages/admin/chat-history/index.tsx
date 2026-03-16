import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";

interface Session {
  id: string;
  tenant_id: string;
  tenant_name: string;
  session_id: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
}

const MOCK_SESSIONS: Session[] = [
  {
    id: "mock-session-1",
    tenant_id: "carnation",
    tenant_name: "カーネーション自動車",
    session_id: "abc-123",
    started_at: "2026-03-14T10:30:00Z",
    ended_at: "2026-03-14T10:45:00Z",
    message_count: 6,
  },
  {
    id: "mock-session-2",
    tenant_id: "carnation",
    tenant_name: "カーネーション自動車",
    session_id: "def-456",
    started_at: "2026-03-15T14:20:00Z",
    ended_at: "2026-03-15T14:35:00Z",
    message_count: 4,
  },
  {
    id: "mock-session-3",
    tenant_id: "demo-tenant",
    tenant_name: "デモテナント",
    session_id: "ghi-789",
    started_at: "2026-03-16T09:00:00Z",
    ended_at: null,
    message_count: 2,
  },
  {
    id: "mock-session-4",
    tenant_id: "demo-tenant",
    tenant_name: "デモテナント",
    session_id: "jkl-012",
    started_at: "2026-03-16T11:10:00Z",
    ended_at: "2026-03-16T11:22:00Z",
    message_count: 8,
  },
];

// TODO: Replace with actual API call
// const res = await fetch(`${apiBase}/v1/admin/chat-history/sessions?tenant=${tenantId}&limit=50`);
async function fetchSessions(tenantId?: string): Promise<Session[]> {
  void tenantId;
  return MOCK_SESSIONS;
}

export default function ChatHistoryPage() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const [sessions] = useState<Session[]>(MOCK_SESSIONS);

  const locale = lang === "en" ? "en-US" : "ja-JP";

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  // fetchSessions is used to signal future API integration
  void fetchSessions;

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
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 32,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <button
            onClick={() => navigate("/admin")}
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
            {t("chat_history.back")}
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("chat_history.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("chat_history.subtitle")}
          </p>
        </div>
        <LangSwitcher />
      </header>

      {/* Mock data notice */}
      <div
        style={{
          marginBottom: 20,
          padding: "10px 16px",
          borderRadius: 10,
          background: "rgba(234,179,8,0.1)",
          border: "1px solid rgba(234,179,8,0.3)",
          color: "#fbbf24",
          fontSize: 13,
        }}
      >
        {t("chat_history.mock_notice")}
      </div>

      {/* Section title */}
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
        {t("chat_history.sessions")}
      </h2>

      {/* Session list */}
      {sessions.length === 0 ? (
        <div
          style={{
            padding: "48px 24px",
            textAlign: "center",
            color: "#6b7280",
            fontSize: 15,
            borderRadius: 14,
            border: "1px solid #1f2937",
            background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          }}
        >
          {t("chat_history.no_sessions")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sessions.map((session) => (
            <div
              key={session.id}
              style={{
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                padding: "18px 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                {/* Tenant badge + session ID */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
                    {session.tenant_name}
                  </span>
                  <span style={{ fontSize: 13, color: "#9ca3af", fontFamily: "monospace" }}>
                    {session.session_id}
                  </span>
                </div>

                {/* Date + message count */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    🕐 {formatDate(session.started_at)}
                  </span>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    💬{" "}
                    {t("chat_history.message_count").replace(
                      "{n}",
                      String(session.message_count)
                    )}
                  </span>
                </div>
              </div>

              {/* Detail button */}
              <button
                onClick={() => navigate(`/admin/chat-history/${session.id}`)}
                style={{
                  padding: "10px 18px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "rgba(15,23,42,0.8)",
                  color: "#e5e7eb",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#4b5563";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#374151";
                }}
              >
                {t("chat_history.view_detail")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
