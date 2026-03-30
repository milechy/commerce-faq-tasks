import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface Session {
  id: string;
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  first_message_preview: string;
  overallScore?: number;
}

function ScoreBadge({ score }: { score: number }) {
  const cfg =
    score >= 80
      ? { bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.3)", color: "#4ade80", label: "良好" }
      : score >= 60
      ? { bg: "rgba(251,191,36,0.15)", border: "rgba(251,191,36,0.3)", color: "#fbbf24", label: "許容" }
      : { bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)", color: "#f87171", label: "要改善" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        color: cfg.color,
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      {score} <span style={{ fontSize: 10, opacity: 0.8 }}>{cfg.label}</span>
    </span>
  );
}

async function fetchSessions(tenantId?: string): Promise<Session[]> {
  const params = new URLSearchParams();
  if (tenantId) params.set("tenant", tenantId);
  params.set("limit", "50");
  const res = await authFetch(`${API_BASE}/v1/admin/chat-history/sessions?${params}`);
  if (!res.ok) throw new Error("Failed to fetch sessions");
  const data = await res.json();
  return data.sessions as Session[];
}

export default function ChatHistoryPage() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { user, isSuperAdmin } = useAuth();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const tenantId = isSuperAdmin ? undefined : (user?.tenantId ?? undefined);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSessions(tenantId);
      setSessions(data);

      // Fetch evaluations to get scores for badge display
      const params = new URLSearchParams();
      if (tenantId) params.set("tenant_id", tenantId);
      params.set("days", "365");
      params.set("limit", "200");
      const evalRes = await authFetch(`${API_BASE}/v1/admin/evaluations?${params}`);
      if (evalRes.ok) {
        const evalData = (await evalRes.json()) as {
          evaluations?: Array<{ session_id?: string; overall_score?: number; score: number }>;
        };
        const scoreMap = new Map<string, number>();
        for (const ev of evalData.evaluations ?? []) {
          if (ev.session_id) scoreMap.set(ev.session_id, ev.overall_score ?? ev.score);
        }
        setSessions((prev) =>
          prev.map((s) => ({ ...s, overallScore: scoreMap.get(s.session_id) }))
        );
      }
    } catch {
      setError("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

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

      {/* Error */}
      {error && (
        <div
          style={{
            marginBottom: 20,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => void loadSessions()}
            style={{
              padding: "8px 16px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid rgba(248,113,113,0.4)",
              background: "rgba(248,113,113,0.1)",
              color: "#fca5a5",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Section title */}
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
        {t("chat_history.sessions")}
      </h2>

      {/* Loading */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("chat_history.loading")}
        </div>
      ) : sessions.length === 0 ? (
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
                {/* Tenant badge + score badge */}
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
                    {session.tenant_id}
                  </span>
                  {session.overallScore != null ? (
                    <span onClick={() => navigate(`/admin/evaluations?tenant_id=${session.tenant_id}`)}>
                      <ScoreBadge score={session.overallScore} />
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: "#4b5563" }}>—</span>
                  )}
                </div>

                {/* First question preview (primary) */}
                {session.first_message_preview && (
                  <span
                    style={{
                      fontSize: 15,
                      color: "#e5e7eb",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {session.first_message_preview}
                  </span>
                )}

                {/* Date + message count + UUID (auxiliary) */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    🕐 {formatDate(session.last_message_at)}
                  </span>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    💬{" "}
                    {t("chat_history.message_count").replace(
                      "{n}",
                      String(session.message_count)
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: "#4b5563", fontFamily: "monospace" }}>
                    {session.session_id.slice(0, 8)}…
                  </span>
                </div>
              </div>

              {/* Detail button */}
              <button
                onClick={() => navigate(`/admin/chat-history/${session.id}`, { state: { session } })}
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
