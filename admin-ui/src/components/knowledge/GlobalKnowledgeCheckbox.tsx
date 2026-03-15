import { useLang } from "../../i18n/LangContext";

export default function GlobalKnowledgeCheckbox({
  isGlobal,
  onChange,
}: {
  isGlobal: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        cursor: "pointer",
        padding: "12px 14px",
        borderRadius: 10,
        border: `1px solid ${isGlobal ? "rgba(234,179,8,0.4)" : "#374151"}`,
        background: isGlobal ? "rgba(234,179,8,0.08)" : "rgba(0,0,0,0.2)",
        marginBottom: 16,
        fontSize: 14,
        color: isGlobal ? "#fbbf24" : "#9ca3af",
        fontWeight: isGlobal ? 600 : 400,
        transition: "all 0.15s",
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        checked={isGlobal}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, accentColor: "#fbbf24", cursor: "pointer" }}
      />
      📚 {t("knowledge.global_label")}
    </label>
  );
}
