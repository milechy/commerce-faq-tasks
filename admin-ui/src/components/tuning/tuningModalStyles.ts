// Style constants for TuningRuleModal

export const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

export const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  resize: "vertical",
  lineHeight: 1.6,
};

export const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 15,
  fontWeight: 600,
  color: "#d1d5db",
  marginBottom: 8,
};

export const HINT_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "#6b7280",
  margin: "0 0 8px",
  lineHeight: 1.5,
};
