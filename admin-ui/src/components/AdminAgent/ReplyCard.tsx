// admin-ui/src/components/AdminAgent/ReplyCard.tsx
import { useState } from "react";
import type { FeedbackReply } from "./useFeedbackReplies";

interface ReplyCardProps {
  reply: FeedbackReply;
  extraCount: number;
  onResolved: () => Promise<void>;
  onNotResolved: () => Promise<void>;
}

export default function ReplyCard({ reply, extraCount, onResolved, onNotResolved }: ReplyCardProps) {
  const [busy, setBusy] = useState(false);

  const handleResolved = async () => {
    setBusy(true);
    await onResolved();
  };

  const handleNotResolved = async () => {
    setBusy(true);
    await onNotResolved();
  };

  return (
    <div
      style={{
        borderRadius: 12,
        border: "1px solid rgba(99,102,241,0.35)",
        background: "rgba(99,102,241,0.08)",
        padding: "12px 14px",
        marginBottom: 4,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "#a5b4fc" }}>
        {"💬 担当者からお返事が届きました"}
        {extraCount > 0 && (
          <span style={{ marginLeft: 6, fontWeight: 400, color: "#818cf8", fontSize: 11 }}>
            {`＋あと${extraCount}件`}
          </span>
        )}
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>あなたの質問</div>
        <div style={{ fontSize: 13, color: "#e5e7eb", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {reply.message}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>お返事</div>
        <div style={{ fontSize: 13, color: "#f9fafb", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {reply.reply_body}
        </div>
        {reply.replied_at && (
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
            {new Date(reply.replied_at).toLocaleString("ja-JP", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button
          onClick={() => void handleResolved()}
          disabled={busy}
          style={{
            flex: 1,
            padding: "9px 12px",
            minHeight: 40,
            borderRadius: 8,
            border: "none",
            background: busy ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg, #16a34a, #22c55e)",
            color: "#f0fdf4",
            fontSize: 13,
            fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          解決しました
        </button>
        <button
          onClick={() => void handleNotResolved()}
          disabled={busy}
          style={{
            flex: 1,
            padding: "9px 12px",
            minHeight: 40,
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "transparent",
            color: "#d1d5db",
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          まだ解決しません
        </button>
      </div>
    </div>
  );
}
