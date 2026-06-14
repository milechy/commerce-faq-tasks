// admin-ui/src/components/AdminAgent/AdminAgentMessage.tsx
import type { AgentMessage } from "./useAdminAgent";

const TOOL_LABEL: Record<string, string> = {
  list_faqs: "FAQ一覧取得",
  add_faq: "FAQ追加",
  update_faq: "FAQ更新",
  delete_faq: "FAQ削除",
  list_tenants: "テナント一覧取得",
  get_tenant: "テナント情報取得",
  update_tenant: "テナント更新",
  list_knowledge: "ナレッジ一覧取得",
  add_knowledge: "ナレッジ追加",
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
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          textAlign: "left",
        }}
      >
        {message.content}
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
