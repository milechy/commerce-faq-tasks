// admin-ui/src/pages/admin/avatar/AvatarFeatureToggle.tsx
// index.tsx から抽出 — アバター機能 ON/OFF トグル（Client Adminのみ）（機能変更なし）

export function AvatarFeatureToggle({
  avatarEnabled,
  toggleLoading,
  tenantFeatures,
  handleAvatarToggle,
  toggleToast,
}: {
  avatarEnabled: boolean;
  toggleLoading: boolean;
  tenantFeatures: { avatar: boolean; voice: boolean; rag: boolean } | null;
  handleAvatarToggle: () => Promise<void>;
  toggleToast: string | null;
}) {
  return (
    <div style={{
      marginBottom: 24,
      padding: "20px 24px",
      borderRadius: 14,
      border: avatarEnabled
        ? "1px solid rgba(74,222,128,0.35)"
        : "1px solid rgba(107,114,128,0.3)",
      background: avatarEnabled
        ? "rgba(34,197,94,0.07)"
        : "rgba(255,255,255,0.03)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>🤖 AIアバター機能</h2>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "6px 0 0" }}>
            ONにすると、チャットウィジェットにAIアバターが表示されます
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void handleAvatarToggle(); }}
          disabled={toggleLoading || tenantFeatures === null}
          style={{
            padding: "12px 28px",
            minHeight: 48,
            minWidth: 120,
            borderRadius: 10,
            border: avatarEnabled
              ? "1px solid rgba(74,222,128,0.5)"
              : "1px solid rgba(107,114,128,0.4)",
            background: avatarEnabled
              ? "rgba(34,197,94,0.22)"
              : "rgba(107,114,128,0.18)",
            color: avatarEnabled ? "#4ade80" : "#9ca3af",
            fontSize: 16,
            fontWeight: 700,
            cursor: toggleLoading || tenantFeatures === null ? "not-allowed" : "pointer",
            opacity: toggleLoading || tenantFeatures === null ? 0.6 : 1,
            transition: "all 0.15s",
          }}
        >
          {toggleLoading ? "保存中..." : avatarEnabled ? "✅ ON" : "⏸️ OFF"}
        </button>
      </div>
      {toggleToast && (
        <div style={{
          marginTop: 12,
          padding: "10px 14px",
          borderRadius: 8,
          background: toggleToast.startsWith("❌")
            ? "rgba(239,68,68,0.12)"
            : "rgba(34,197,94,0.12)",
          color: toggleToast.startsWith("❌") ? "#fca5a5" : "#86efac",
          fontSize: 14,
        }}>
          {toggleToast}
        </div>
      )}
    </div>
  );
}
