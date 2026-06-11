import { useLang } from "../../../i18n/LangContext";
import type { Message } from "./types";

// ─── メッセージ一覧（吹き出し + ルール作成ボタン） ─────────────────────────────

export function MessageList({
  messages,
  formatTime,
  handleCreateRule,
}: {
  messages: Message[];
  formatTime: (iso: string) => string;
  handleCreateRule: (assistantMsg: Message) => void;
}) {
  const { t } = useLang();
  return (
    <>
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
              color: "var(--muted-foreground)",
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
                    : "1px solid var(--border)",
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
                        color: "var(--muted-foreground)",
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
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--muted-foreground)",
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
    </>
  );
}
