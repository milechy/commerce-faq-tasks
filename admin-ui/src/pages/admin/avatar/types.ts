import type * as React from "react";

// ─── 型（studio.tsx から移動） ────────────────────────────────────────────────

export interface VoiceRecommendation {
  id: string;
  title: string;
  description: string;
  score: number;
}

// ─── 型（index.tsx から移動） ─────────────────────────────────────────────────

export interface AvatarConfig {
  id: string;
  tenant_id: string;
  tenant_name?: string;
  name: string;
  image_url: string | null;
  lemonslice_agent_id: string | null;
  is_active: boolean;
  is_default: boolean;
  created_at: string;
  avatar_provider: string | null;
}

export type SortKey = "name_asc" | "created_desc" | "created_asc" | "active_first" | "inactive_first" | "default_first";
export type TypeFilter = "all" | "default" | "custom";
export type StatusFilter = "all" | "active" | "inactive";

export interface WarningTarget { id: string; tenantId: string; name: string }

// ─── スタイル定数（studio.tsx から移動） ──────────────────────────────────────

export const BG = "var(--background)";

export const SECTION_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "var(--card)",
  padding: "20px 22px",
  marginBottom: 20,
};

export const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--muted-foreground)",
  marginBottom: 6,
};

export const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "rgba(30,41,59,0.8)",
  color: "var(--foreground)",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

export const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  resize: "vertical",
  minHeight: 90,
  fontFamily: "inherit",
  lineHeight: 1.5,
};

export const BTN_PRIMARY: React.CSSProperties = {
  padding: "10px 20px",
  minHeight: 44,
  borderRadius: 10,
  border: "none",
  background: "linear-gradient(135deg, #3b82f6, #6366f1)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

export const BTN_SECONDARY: React.CSSProperties = {
  padding: "10px 18px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--muted-foreground)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
