// src/agent/config/ragLimits.ts
// 書籍著作権保護: RAG抜粋のLLM渡し制限定数

/** 1チャンクあたりの最大文字数（書籍内容保護） */
export const RAG_EXCERPT_MAX_CHARS = 200;

/** LLMに渡す最大チャンク数 */
export const RAG_MAX_EXCERPTS = 3;

/** LLMに渡す合計最大文字数（RAG_MAX_EXCERPTS × RAG_EXCERPT_MAX_CHARS） */
export const RAG_TOTAL_MAX_CHARS = RAG_MAX_EXCERPTS * RAG_EXCERPT_MAX_CHARS;
