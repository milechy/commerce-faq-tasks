import type * as React from "react";
import type { CSSProperties } from "react";

// プラン定義（バックエンド planValues と一致: starter/growth/enterprise）
export type TenantPlan = "starter" | "growth" | "enterprise";

export const PLAN_OPTIONS: { value: TenantPlan; label: string; multiplier: number; desc: string }[] = [
  { value: "starter",    label: "Starter",    multiplier: 1.0, desc: "小規模サイト向け（〜500対話/月）" },
  { value: "growth",     label: "Growth",     multiplier: 1.5, desc: "成長期のビジネス向け（〜3,000対話/月）" },
  { value: "enterprise", label: "Enterprise", multiplier: 2.5, desc: "大規模・高品質要求向け（無制限）" },
];

export interface TenantFeatures {
  avatar: boolean;
  voice: boolean;
  rag: boolean;
  deep_research?: boolean;
  pre_dispatch?: boolean;
}

export interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  plan: TenantPlan;
  status: "active" | "inactive";
  createdAt: string;
  widgetTitle: string;
  widgetColor: string;
  allowed_origins: string[];
  system_prompt?: string | null;
  billing_enabled: boolean;
  billing_free_from: string | null;
  billing_free_until: string | null;
  features: TenantFeatures;
  lemonslice_agent_id: string | null;
  conversion_types: string[];
  // Phase A: GA4連携
  ga4_property_id?: string | null;
  ga4_status?: "not_configured" | "pending" | "connected" | "error" | "timeout" | "permission_revoked" | null;
  ga4_connected_at?: string | null;
  ga4_last_sync_at?: string | null;
  ga4_error_message?: string | null;
  tenant_contact_email?: string | null;
}

export interface ApiKey {
  id: string;
  maskedKey: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

export const CARD_STYLE: CSSProperties = {
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "var(--card)",
  padding: "20px 18px",
};

// ─── タブID（[id].tsx から移動） ──────────────────────────────────────────────

export type TabId = "settings" | "apikeys" | "embed" | "avatar" | "ai-report" | "ab-test" | "objection-patterns" | "conversion" | "deep-research" | "tuning" | "test" | "ga4" | "posthog" | "analytics" | "billing-info" | "notification-prefs" | "settings-history";

// ─── スタイル定数（[id].tsx から移動） ────────────────────────────────────────

export const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--foreground)",
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
};

export const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--muted-foreground)",
  marginBottom: 6,
};
