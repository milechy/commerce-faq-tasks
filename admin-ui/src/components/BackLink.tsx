import { useNavigate } from "react-router-dom";

interface BackLinkProps {
  to: string;
  label: string;
}

export default function BackLink({ to, label }: BackLinkProps) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "8px 14px",
        minHeight: 44,
        borderRadius: 999,
        border: "1px solid #374151",
        background: "transparent",
        color: "#9ca3af",
        fontSize: 14,
        cursor: "pointer",
        fontWeight: 500,
      }}
    >
      {label}
    </button>
  );
}
