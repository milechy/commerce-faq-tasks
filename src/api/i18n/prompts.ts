// src/api/i18n/prompts.ts
// Phase33: LLMシステムプロンプト辞書（言語別）

import type { Lang } from "./messages";

const systemPrompts: Record<Lang, Record<string, string>> = {
  ja: {
    sales_assistant:
      "あなたはRAJIUCEの営業アシスタントです。丁寧な日本語で回答してください。",
    clarify:
      "ユーザーの質問を明確にするため、追加の質問をしてください。",
    answer:
      "以下の情報をもとに、ユーザーの質問に日本語で回答してください。",
  },
  en: {
    sales_assistant:
      "You are a sales assistant for RAJIUCE. Please respond in polite English.",
    clarify:
      "To clarify the user's question, please ask a follow-up question.",
    answer:
      "Based on the following information, answer the user's question in English.",
  },
};

/**
 * 指定したキーのシステムプロンプトを返す。
 * キーが存在しない場合はja版にフォールバックする。
 */
export function getSystemPrompt(key: string, lang: Lang): string {
  return systemPrompts[lang]?.[key] ?? systemPrompts.ja[key] ?? key;
}
