// admin-ui/src/components/AdminAgent/AdminAgentMessage.tsx
import type { AgentMessage } from "./useAdminAgent";
import AgentMarkdown from "../markdown/AgentMarkdown";

// このパネル面(components/AdminAgent/)は凍結方針(admin-ui/CLAUDE.md)のため、
// 全画面UI(pages/copilot-preview/)が追加した新ツールのラベルはここに追加しない。
// 未登録のツール名は toolLabel() の `?? tool` フォールバックで生の英語名のまま
// 表示される(意図的な劣化。パネル面は今後増えないため許容している)。
const TOOL_LABEL: Record<string, string> = {
  add_faq: "FAQ追加",
  update_faq: "FAQ更新",
  delete_faq: "FAQ削除",
};

function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool;
}

interface AdminAgentMessageProps {
  message: AgentMessage;
}

export default function AdminAgentMessage({ message }: AdminAgentMessageProps) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      {/* メッセージ本文 */}
      <div
        style={{
          maxWidth: "85%",
          padding: "9px 13px",
          borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
          background: isUser
            ? "rgba(99,102,241,0.15)"
            : "var(--card, rgba(30,41,59,0.9))",
          border: isUser ? "1px solid rgba(99,102,241,0.3)" : "1px solid rgba(255,255,255,0.08)",
          color: "var(--foreground, #f9fafb)",
          fontSize: 14,
          lineHeight: 1.6,
          wordBreak: "break-word",
          textAlign: "left",
          ...(isUser ? { whiteSpace: "pre-wrap" } : {}),
        }}
      >
        {/* 自分自身の発話はMarkdown解釈させない。AI発話のみAgentMarkdownで描画する */}
        {isUser ? message.content : <AgentMarkdown content={message.content} />}
      </div>

      {/* アクションバブル */}
      {message.actions && message.actions.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxWidth: "85%",
          }}
        >
          {message.actions.map((action, i) => (
            <div
              key={i}
              style={{
                padding: "5px 10px",
                borderRadius: 8,
                background: "rgba(16,185,129,0.1)",
                border: "1px solid rgba(16,185,129,0.2)",
                color: "rgba(209,250,229,0.85)",
                fontSize: 12,
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {"✅"} {toolLabel(action.tool)}: {action.result}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
