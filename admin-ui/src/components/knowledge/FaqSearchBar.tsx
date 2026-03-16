import { useLang } from "../../i18n/LangContext";

interface FaqSearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export default function FaqSearchBar({ value, onChange }: FaqSearchBarProps) {
  const { t } = useLang();

  return (
    <div style={{ position: "relative", marginBottom: 16 }}>
      <span
        style={{
          position: "absolute",
          left: 14,
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: 16,
          color: "#6b7280",
          pointerEvents: "none",
        }}
      >
        🔍
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("knowledge.search_placeholder")}
        style={{
          width: "100%",
          padding: "12px 14px 12px 44px",
          borderRadius: 10,
          border: "1px solid #374151",
          background: "rgba(15,23,42,0.8)",
          color: "#e5e7eb",
          fontSize: 16,
          minHeight: 48,
          boxSizing: "border-box",
          outline: "none",
          transition: "border-color 0.15s",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "#22c55e";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "#374151";
        }}
      />
    </div>
  );
}
