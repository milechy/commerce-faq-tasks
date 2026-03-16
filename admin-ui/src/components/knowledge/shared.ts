import type { CSSProperties } from "react";
import { supabase } from "../../lib/supabaseClient";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface BookMetadata {
  id: string;
  title: string;
  author: string;
  totalPages: number;
  totalChunks: number;
  uploadedAt: number;
}

export interface KnowledgeItem {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  is_published?: boolean;
  created_at: string;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface ScrapePreviewItem {
  url: string;
  faqs: FaqEntry[];
  error?: string;
}

export interface OcrJobStatus {
  status: "processing" | "done" | "failed";
  pages?: number;
  chunks?: number;
  error?: string;
}

export type DeleteState = "idle" | "confirming" | "deleting" | "success" | "error";
export type Category = "inventory" | "campaign" | "coupon" | "store_info";
export type Tab = "list" | "text" | "scrape";

// ─── ユーティリティ ───────────────────────────────────────────────────────────

export async function getAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

// 401時にリフレッシュ→リトライするfetchラッパー
export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  let token = await getAccessToken();
  if (!token) {
    const { data } = await supabase.auth.refreshSession();
    token = data.session?.access_token ?? null;
  }
  if (!token) throw new Error("__AUTH_REQUIRED__");

  const makeRequest = (t: string) =>
    fetch(url, {
      ...options,
      headers: {
        ...(options.headers as Record<string, string>),
        Authorization: `Bearer ${t}`,
      },
    });

  const res = await makeRequest(token);

  if (res.status === 401 || res.status === 403) {
    const { data } = await supabase.auth.refreshSession();
    const refreshedToken = data.session?.access_token ?? null;
    if (!refreshedToken) throw new Error("__AUTH_REQUIRED__");
    return makeRequest(refreshedToken);
  }

  return res;
}

export function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

export const CARD_STYLE: CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

export const BTN_PRIMARY: CSSProperties = {
  padding: "16px 24px",
  minHeight: 56,
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
  color: "#022c22",
  fontSize: 17,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
};

export const BTN_DANGER: CSSProperties = {
  padding: "10px 16px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid #7f1d1d",
  background: "rgba(127,29,29,0.2)",
  color: "#fca5a5",
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 500,
};

export const TEXTAREA_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 180,
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};

export const SELECT_STYLE: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  minHeight: 48,
};
