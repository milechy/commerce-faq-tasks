import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

const DEFAULT_CONVERSION_TYPES = ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"];

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
  const [outcome, setOutcome] = useState<string | null>(null);
  const [outcomeRecordedAt, setOutcomeRecordedAt] = useState<string | null>(null);
  const [outcomeRecordedBy, setOutcomeRecordedBy] = useState<string | null>(null);
  const [conversionTypes, setConversionTypes] = useState<string[]>(DEFAULT_CONVERSION_TYPES);
  const [outcomeSubmitting, setOutcomeSubmitting] = useState(false);
  const [outcomeToast, setOutcomeToast] = useState<string | null>(null);

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

  // テナントのconversion_typesを取得
  useEffect(() => {
    const fetchConversionTypes = async () => {
      try {
        const endpoint = isSuperAdmin && sessionInfo?.tenant_id
          ? `${API_BASE}/v1/admin/tenants/${sessionInfo.tenant_id}`
          : `${API_BASE}/v1/admin/my-tenant`;
        const res = await authFetch(endpoint);
        if (!res.ok) return;
        const data = (await res.json()) as { conversion_types?: string[] };
        if (Array.isArray(data.conversion_types) && data.conversion_types.length > 0) {
          setConversionTypes(data.conversion_types);
        }
      } catch {
        // フォールバック: デフォルトを使用
      }
    };
    void fetchConversionTypes();
  }, [isSuperAdmin, sessionInfo?.tenant_id]);

  // sessionFromStateにoutcome情報があれば復元
  useEffect(() => {
    const s = sessionFromState as (typeof sessionFromState & { outcome?: string | null; outcome_recorded_at?: string | null; outcome_recorded_by?: string | null }) | null;
    if (s?.outcome) {
      setOutcome(s.outcome);
      setOutcomeRecordedAt(s.outcome_recorded_at ?? null);
      setOutcomeRecordedBy(s.outcome_recorded_by ?? null);
    }
  }, []);

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

  const handleOutcome = async (value: string) => {
    if (!sessionId) return;
    setOutcomeSubmitting(true);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/chat-history/sessions/${sessionId}/outcome`,
        { method: "PATCH", body: JSON.stringify({ outcome: value }) },
      );
      const data = (await res.json()) as { outcome?: string; recorded_at?: string; recorded_by?: string; error?: string };
      if (!res.ok) {
        setOutcomeToast(data.error ?? "保存に失敗しました。もう一度お試しください 🙏");
        setTimeout(() => setOutcomeToast(null), 3000);
        return;
      }
      setOutcome(value);
      setOutcomeRecordedAt(data.recorded_at ?? new Date().toISOString());
      setOutcomeRecordedBy(data.recorded_by ?? null);
      setOutcomeToast(`✅ 「${value}」として記録しました`);
      setTimeout(() => setOutcomeToast(null), 3000);
    } catch {
      setOutcomeToast("保存に失敗しました。もう一度お試しください 🙏");
      setTimeout(() => setOutcomeToast(null), 3000);
    } finally {
      setOutcomeSubmitting(false);
    }
  };

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
    if (sessionInfo?.tenant_id) params.set("presetTenantId", sessionInfo.tenant_id);
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

      {/* 営業結果トースト */}
      {outcomeToast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "14px 24px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.98)",
            border: "1px solid #22c55e",
            color: "#4ade80",
            fontSize: 15,
            fontWeight: 600,
            zIndex: 2000,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
          {outcomeToast}
        </div>
      )}

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
          {/* 営業結果入力（Client Adminのみ表示） */}
          {!isSuperAdmin && <div
            style={{
              marginTop: 8,
              padding: "20px 18px",
              borderRadius: 14,
              border: "1px solid #1f2937",
              background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
            }}
          >
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 15,
                fontWeight: 700,
                color: "#e5e7eb",
              }}
            >
              この会話の営業結果を記録
            </p>
            {/* 記録済み情報 */}
            {outcome && outcomeRecordedAt && (
              <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(5,46,22,0.4)", border: "1px solid rgba(74,222,128,0.2)", fontSize: 12, color: "#86efac" }}>
                ✓ 記録済み: {new Date(outcomeRecordedAt).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {outcomeRecordedBy && ` by ${outcomeRecordedBy}`}
                <button
                  onClick={() => { setOutcome(null); setOutcomeRecordedAt(null); setOutcomeRecordedBy(null); }}
                  style={{ marginLeft: 8, background: "none", border: "none", color: "#4ade80", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  変更
                </button>
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 10,
              }}
            >
              {conversionTypes.map((value) => (
                <button
                  key={value}
                  onClick={() => void handleOutcome(value)}
                  disabled={outcomeSubmitting}
                  style={{
                    padding: "14px 12px",
                    minHeight: 52,
                    borderRadius: 10,
                    border:
                      outcome === value
                        ? "1px solid rgba(74,222,128,0.5)"
                        : "1px solid #374151",
                    background:
                      outcome === value
                        ? "rgba(34,197,94,0.2)"
                        : "rgba(31,41,55,0.5)",
                    color: outcome === value ? "#4ade80" : "#9ca3af",
                    fontSize: 15,
                    fontWeight: outcome === value ? 700 : 500,
                    cursor: outcomeSubmitting ? "not-allowed" : "pointer",
                    opacity: outcomeSubmitting && outcome !== value ? 0.6 : 1,
                    transition: "all 0.15s",
                    width: "100%",
                  }}
                >
                  {outcome === value ? `✓ ${value}` : value}
                </button>
              ))}
            </div>
          </div>}
        </div>
      )}
    </div>
  );
}
