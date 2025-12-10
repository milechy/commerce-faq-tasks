// src/agent/tools/synthesisTool.ts

import type { RerankItem } from '../types';

export interface SynthesisInput {
  query: string;
  items: RerankItem[];
  maxChars?: number;
}

export interface SynthesisOutput {
  answer: string;
}

const DEFAULT_MAX_CHARS = 420;

/**
 * 将来 LLM をここに差し替える。
 * 今はトップ1〜3件をもとに 300〜500文字程度の要約風メッセージを合成。
 */
export function synthesizeAnswer(input: SynthesisInput): SynthesisOutput {
  const { query, items, maxChars = DEFAULT_MAX_CHARS } = input;

  if (!items.length) {
    const msg =
      'ご質問の内容に完全に一致するFAQは見つかりませんでした。' +
      'キーワード（商品名・機能名・「返品」「送料」など）を含めて、もう一度お試しください。';
    return { answer: truncate(msg, maxChars) };
  }

  // 箇条書きは 2 件までに制限して、よりタイトな回答にする
  const top = items.slice(0, 2);
  const bullets = top
    .map((it) => `・${sanitizeText(it.text)}`)
    .join('\n');

  let answer =
    `ご質問「${query}」に対して、関連性の高いFAQから要点をまとめました。\n` +
    `${bullets}\n\n` +
    '具体的な手順や最新の条件は、各FAQ本文をご確認ください。';

  answer = truncate(answer, maxChars);

  return { answer };
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + '…';
}

function sanitizeText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}