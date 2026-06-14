// admin-ui/src/components/AdminAgent/AdminAgentButton.tsx
// 既存 AdminAIChat ボタンは right:88px bottom:24px (z-index:900)
// 本ボタンは right:24px bottom:24px (z-index:902) で衝突しない

interface AdminAgentButtonProps {
  onClick: () => void;
  isOpen: boolean;
}

export default function AdminAgentButton({ onClick, isOpen }: AdminAgentButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-label={isOpen ? "AIアシスタントを閉じる" : "AIアシスタントを開く"}
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        width: 48,
        height: 48,
        borderRadius: "50%",
        border: "none",
        background: "linear-gradient(135deg, #6366f1, #4f46e5)",
        color: "#fff",
        fontSize: 20,
        cursor: "pointer",
        boxShadow: "0 4px 20px rgba(99,102,241,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 902,
        transition: "transform 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.1)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 6px 24px rgba(99,102,241,0.7)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 4px 20px rgba(99,102,241,0.5)";
      }}
    >
      {isOpen ? "✕" : "✨"}
    </button>
  );
}
