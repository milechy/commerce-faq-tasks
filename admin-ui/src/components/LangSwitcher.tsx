import { useLang } from "../i18n/LangContext";

export default function LangSwitcher() {
  const { lang, setLang } = useLang();

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 14px",
    minHeight: 44,
    borderRadius: 999,
    border: `1px solid ${active ? "#4ade80" : "#374151"}`,
    background: active ? "rgba(34,197,94,0.15)" : "transparent",
    color: active ? "#4ade80" : "#9ca3af",
    fontSize: 14,
    fontWeight: active ? 700 : 500,
    cursor: "pointer",
  });

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <button onClick={() => setLang("ja")} style={btnStyle(lang === "ja")}>
        🇯🇵 日本語
      </button>
      <button onClick={() => setLang("en")} style={btnStyle(lang === "en")}>
        🇺🇸 English
      </button>
    </div>
  );
}
