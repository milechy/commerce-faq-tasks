import type { CSSProperties } from "react";

export interface TenantFeatures {
  avatar: boolean;
  voice: boolean;
  rag: boolean;
  deep_research?: boolean;
}

export interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
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
