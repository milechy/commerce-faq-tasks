// admin-ui/src/data/industryFaqTemplates.ts
// GID 1216274591838389: 初回ログインオンボーディングの業種選択肢。
// テンプレ本文(INDUSTRY_FAQ_TEMPLATES)はオンボ 是正C-1で撤去した(旧UIの
// OnboardingModal専用だった。チャット版はバックエンドの
// src/api/admin/agent/industryFaqTemplates.ts を使う)。

export type OnboardingIndustry = "auto" | "beauty" | "food" | "realestate" | "retail" | "other";

export const ONBOARDING_INDUSTRIES: { value: OnboardingIndustry; label: string; icon: string }[] = [
  { value: "auto", label: "自動車販売・整備", icon: "🚗" },
  { value: "beauty", label: "美容・サロン", icon: "💇" },
  { value: "food", label: "飲食", icon: "🍽️" },
  { value: "realestate", label: "不動産", icon: "🏠" },
  { value: "retail", label: "小売・EC", icon: "🛍️" },
  { value: "other", label: "その他", icon: "📋" },
];
