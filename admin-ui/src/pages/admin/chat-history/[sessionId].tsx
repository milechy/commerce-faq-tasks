import { useNavigate, useParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata?: {
    model?: string;
    route?: string;
  };
}

interface SessionDetail {
  id: string;
  tenant_id: string;
  tenant_name: string;
  session_id: string;
  started_at: string;
  messages: Message[];
}

const MOCK_SESSION_DETAILS: Record<string, SessionDetail> = {
  "mock-session-1": {
    id: "mock-session-1",
    tenant_id: "carnation",
    tenant_name: "カーネーション自動車",
    session_id: "abc-123",
    started_at: "2026-03-14T10:30:00Z",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "在庫はどのくらいありますか？",
        created_at: "2026-03-14T10:30:15Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content:
          "現在、約50台の在庫がございます。セダン、SUV、軽自動車など幅広い車種を取り揃えております。詳しい車種や価格については、お気軽にお問い合わせください。",
        created_at: "2026-03-14T10:30:18Z",
        metadata: { model: "qwen-qwq-32b", route: "rag" },
      },
      {
        id: "msg-3",
        role: "user",
        content: "SUVの在庫はありますか？予算は300万円以内で。",
        created_at: "2026-03-14T10:31:00Z",
      },
      {
        id: "msg-4",
        role: "assistant",
        content:
          "300万円以内のSUVにつきまして、現在以下の車種をご用意しております：\n\n• 2023年式 RAV4 ハイブリッド（280万円）\n• 2022年式 CH-R（245万円）\n• 2024年式 ヤリスクロス（260万円）\n\nご希望に合わせてご提案いたします。試乗もお気軽にどうぞ。",
        created_at: "2026-03-14T10:31:05Z",
        metadata: { model: "qwen-qwq-32b", route: "rag" },
      },
      {
        id: "msg-5",
        role: "user",
        content: "RAV4の詳細を教えてください",
        created_at: "2026-03-14T10:32:10Z",
      },
      {
        id: "msg-6",
        role: "assistant",
        content:
          "RAV4ハイブリッドの詳細です：\n\n年式：2023年式\n走行距離：12,000km\n車体色：ホワイトパールクリスタルシャイン\n修復歴：なし\n車検：2025年12月まで\n価格：280万円（税込）\n\nご不明な点はお気軽にお申し付けください。",
        created_at: "2026-03-14T10:32:15Z",
        metadata: { model: "qwen-qwq-32b", route: "rag" },
      },
    ],
  },
  "mock-session-2": {
    id: "mock-session-2",
    tenant_id: "carnation",
    tenant_name: "カーネーション自動車",
    session_id: "def-456",
    started_at: "2026-03-15T14:20:00Z",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "今月のキャンペーンはありますか？",
        created_at: "2026-03-15T14:20:05Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content:
          "はい！3月の特別キャンペーンをご用意しております。3月31日までにご成約いただいたお客様に、カーナビまたはドライブレコーダーをプレゼントいたします。ぜひこの機会にご検討ください。",
        created_at: "2026-03-15T14:20:09Z",
        metadata: { model: "qwen-qwq-32b", route: "rag" },
      },
      {
        id: "msg-3",
        role: "user",
        content: "ローンの審査は厳しいですか？",
        created_at: "2026-03-15T14:21:30Z",
      },
      {
        id: "msg-4",
        role: "assistant",
        content:
          "審査基準については個別のご状況によって異なります。まずはお気軽にご相談ください。複数のローン会社と提携しており、お客様に合ったプランをご提案できる場合がございます。",
        created_at: "2026-03-15T14:21:35Z",
        metadata: { model: "qwen-qwq-32b", route: "clarify" },
      },
    ],
  },
  "mock-session-3": {
    id: "mock-session-3",
    tenant_id: "demo-tenant",
    tenant_name: "デモテナント",
    session_id: "ghi-789",
    started_at: "2026-03-16T09:00:00Z",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "こんにちは",
        created_at: "2026-03-16T09:00:10Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content:
          "こんにちは！何かお手伝いできることはありますか？在庫情報やキャンペーン、ローンのご相談など、お気軽にどうぞ。",
        created_at: "2026-03-16T09:00:13Z",
        metadata: { model: "qwen-qwq-32b", route: "clarify" },
      },
    ],
  },
  "mock-session-4": {
    id: "mock-session-4",
    tenant_id: "demo-tenant",
    tenant_name: "デモテナント",
    session_id: "jkl-012",
    started_at: "2026-03-16T11:10:00Z",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "軽自動車の在庫はありますか？",
        created_at: "2026-03-16T11:10:05Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "軽自動車は現在10台在庫がございます。ご予算やご希望の用途をお聞かせいただけますか？",
        created_at: "2026-03-16T11:10:08Z",
        metadata: { model: "qwen-qwq-32b", route: "clarify" },
      },
      {
        id: "msg-3",
        role: "user",
        content: "通勤用で、燃費重視です。予算は150万くらいで。",
        created_at: "2026-03-16T11:11:20Z",
      },
      {
        id: "msg-4",
        role: "assistant",
        content:
          "通勤用・燃費重視で150万円のご予算であれば、スズキ スペーシア（2023年式、135万円）やダイハツ タント（2022年式、128万円）がおすすめです。両車種ともにハイブリッド対応で燃費は20km/L超えです。",
        created_at: "2026-03-16T11:11:25Z",
        metadata: { model: "qwen-qwq-32b", route: "rag" },
      },
      {
        id: "msg-5",
        role: "user",
        content: "スペーシアの試乗は可能ですか？",
        created_at: "2026-03-16T11:13:00Z",
      },
      {
        id: "msg-6",
        role: "assistant",
        content:
          "はい、もちろん試乗いただけます！ご来店の際にお申し付けください。事前にご予約いただくとスムーズです。ご予約はお電話またはWebフォームから承っております。",
        created_at: "2026-03-16T11:13:05Z",
        metadata: { model: "qwen-qwq-32b", route: "answer" },
      },
      {
        id: "msg-7",
        role: "user",
        content: "営業時間を教えてください",
        created_at: "2026-03-16T11:15:10Z",
      },
      {
        id: "msg-8",
        role: "assistant",
        content:
          "営業時間は月〜土曜日 10:00〜19:00、日曜・祝日 10:00〜18:00 です。毎週水曜日は定休日となっております。お気軽にお越しください。",
        created_at: "2026-03-16T11:15:14Z",
        metadata: { model: "qwen-qwq-32b", route: "rag" },
      },
    ],
  },
};

// TODO: Replace with actual API call
// const res = await fetch(`${apiBase}/v1/admin/chat-history/sessions/${sessionId}`);
async function fetchSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  return MOCK_SESSION_DETAILS[sessionId] ?? null;
}

export default function ChatHistorySessionPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { t, lang } = useLang();

  const session = sessionId ? MOCK_SESSION_DETAILS[sessionId] ?? null : null;

  // fetchSessionDetail is here to signal future API integration
  void fetchSessionDetail;

  const locale = lang === "en" ? "en-US" : "ja-JP";

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
    if (!session) return;
    // 直前のユーザーメッセージを取得
    const msgIndex = session.messages.findIndex((m) => m.id === assistantMsg.id);
    const userMsg =
      msgIndex > 0 && session.messages[msgIndex - 1].role === "user"
        ? session.messages[msgIndex - 1].content
        : "";

    const params = new URLSearchParams({
      create: "1",
      userMsg,
      assistantMsg: assistantMsg.content,
    });
    navigate(`/admin/tuning?${params.toString()}`);
  };

  if (!session) {
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
            padding: "48px 24px",
            textAlign: "center",
            color: "#6b7280",
            fontSize: 15,
          }}
        >
          Session not found: {sessionId}
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
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            🕐 {formatDateTime(session.started_at)}
          </span>
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            💬{" "}
            {t("chat_history.message_count").replace(
              "{n}",
              String(session.messages.length)
            )}
          </span>
        </div>

        {/* Mock notice */}
        <div
          style={{
            marginTop: 10,
            padding: "8px 14px",
            borderRadius: 8,
            background: "rgba(234,179,8,0.1)",
            border: "1px solid rgba(234,179,8,0.3)",
            color: "#fbbf24",
            fontSize: 12,
          }}
        >
          {t("chat_history.mock_notice")}
        </div>
      </header>

      {/* Messages */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {session.messages.map((msg) => (
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
                    {msg.metadata.model && (
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
                    {msg.metadata.route && (
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
    </div>
  );
}
