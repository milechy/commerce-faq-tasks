// admin-ui/src/pages/admin/avatar/utils.ts
// index.tsx から移動 — pure ヘルパー（機能変更なし）

export const toggleBtnStyle = (active: boolean) => ({
  padding: "8px 14px",
  minHeight: 44,
  borderRadius: 8,
  border: active ? "1px solid rgba(99,102,241,0.6)" : "1px solid var(--border)",
  background: active ? "rgba(99,102,241,0.2)" : "transparent",
  color: active ? "#a5b4fc" : "#9ca3af",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
});
