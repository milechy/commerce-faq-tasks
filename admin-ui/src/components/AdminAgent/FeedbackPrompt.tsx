// admin-ui/src/components/AdminAgent/FeedbackPrompt.tsx
// 直近のAI回答の下に出す「解決しましたか？」の確認導線。
import { useState } from "react";
import { submitConsultation } from "./useFeedbackReplies";

interface FeedbackPromptProps {
  question: string;
}

type PromptState = "idle" | "sending" | "sent" | "dismissed";

export default function FeedbackPrompt({ question }: FeedbackPromptProps) {
  const [state, setState] = useState<PromptState>("idle");

  if (state === "dismissed") return null;

  if (state === "sent") {
    return (
      <div style={{ fontSize: 12, color: "#86efac", padding: "2px 4px" }}>
        {"✅ 担当者に伝えました。お返事はこの画面に届きます。"}
      </div>
    );
  }

  const handleNotResolved = async () => {
    setState("sending");
    const ok = await submitConsultation({ message: question });
    setState(ok ? "sent" : "idle");
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 4px", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "#6b7280" }}>このお返事で解決しましたか？</span>
      <button
        onClick={() => setState("dismissed")}
        style={{
          padding: "4px 10px",
          minHeight: 28,
          borderRadius: 999,
          border: "1px solid rgba(74,222,128,0.35)",
          background: "rgba(34,197,94,0.1)",
          color: "#86efac",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        はい
      </button>
      <button
        onClick={() => void handleNotResolved()}
        disabled={state === "sending"}
        style={{
          padding: "4px 10px",
          minHeight: 28,
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.15)",
          background: "transparent",
          color: "#9ca3af",
          fontSize: 11,
          fontWeight: 600,
          cursor: state === "sending" ? "not-allowed" : "pointer",
        }}
      >
        {state === "sending" ? "送信中..." : "うまく解決しなかった"}
      </button>
    </div>
  );
}
