// src/middleware/outputGuard.ts
// Phase48 Pane 4: L8 Output Guard

import { logger } from '../lib/logger';
import { isSecurityLayerEnabled } from './securityLayerConfig';
import { EMAIL_PATTERN } from '../lib/security/piiPatterns';

export interface OutputGuardResult {
  safe: boolean;
  sanitizedResponse: string;
  redactions: string[]; // 何をredactしたかのリスト
}

const DEFAULT_SYSTEM_SNIPPETS: string[] = [
  'Security First',
  'ragExcerpt.slice(0, 200)',
  'tenantId from JWT only',
  'Mobile First',
  'Touch targets',
  'Anti-Slop',
];

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: 'phone_hyphen',
    pattern: /\d{2,4}-\d{2,4}-\d{4}/g,
    replacement: '[個人情報のため非表示]',
  },
  {
    name: 'phone_plain',
    pattern: /0\d{9,10}/g,
    replacement: '[個人情報のため非表示]',
  },
  {
    name: 'email',
    pattern: EMAIL_PATTERN,
    replacement: '[個人情報のため非表示]',
  },
  {
    name: 'postal_code',
    pattern: /\d{3}-\d{4}/g,
    replacement: '[個人情報のため非表示]',
  },
];

/**
 * 対外的に出さない社内用語。フレームワーク名を含む節ごと一般表現に置き換える。
 * 「〜の法則」まで飲み込まないと「独自の考え方の法則」のような壊れた文が残るため、
 * 呼称のゆれ(英字/カナ/表記ゆれ)と後続の「の法則」をまとめて 1 パターンで畳む。
 */
const INTERNAL_TERM_REPLACEMENT = '独自の考え方';

const INTERNAL_TERM_PATTERNS: RegExp[] = [
  /(?:RAJIUSEC|RAJIUCE|ラジューセック|ラジウセック|ラジウス)\s*(?:の法則性|の法則|法則)?/gi,
  /(?:ARCSTRA|ARCSTORA|アクストラ)\s*(?:の法則性|の法則|法則)?/gi,
  // ストリーミングでは呼称だけが先に確定し「の法則」が後続チャンクで届くため、
  // 置換済みの語に後から続いた「の法則」を畳む。
  new RegExp(`${INTERNAL_TERM_REPLACEMENT}\\s*(?:の法則性|の法則|法則)`, 'g'),
];

/**
 * ストリーミング時に送信を保留すべき末尾文字数。
 * 最長パターン「RAJIUSECの法則性」(12文字)に余裕を持たせた値。
 */
export const INTERNAL_TERM_HOLD_CHARS = 16;

/**
 * 社内用語を伏せる。OUTPUT_GUARD_ENABLED に依存せず常に適用する
 * (フラグ無効化で社内用語が素通りする状態を作らないため)。
 */
export function redactInternalTerms(text: string): { text: string; redacted: boolean } {
  let result = text;
  for (const pattern of INTERNAL_TERM_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, INTERNAL_TERM_REPLACEMENT);
  }
  return { text: result, redacted: result !== text };
}

function getMaxRagExcerptLength(): number {
  const envVal = process.env['MAX_RAG_EXCERPT_LENGTH'];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return 200;
}

function isOutputGuardEnabled(): boolean {
  return isSecurityLayerEnabled('OUTPUT_GUARD_ENABLED');
}

logger.info(`[outputGuard] L8 Output Guard enabled=${isOutputGuardEnabled()}`);

export function guardOutput(
  llmResponse: string,
  systemPromptSnippets?: string[]
): OutputGuardResult {
  // Enabled check — fast path
  if (!isOutputGuardEnabled()) {
    return { safe: true, sanitizedResponse: llmResponse, redactions: [] };
  }

  const redactions: string[] = [];
  let sanitizedResponse = llmResponse;

  // Rule 1: System prompt leak check
  const allSnippets = [...DEFAULT_SYSTEM_SNIPPETS, ...(systemPromptSnippets ?? [])];
  let systemPromptLeakDetected = false;
  for (const snippet of allSnippets) {
    if (sanitizedResponse.includes(snippet)) {
      sanitizedResponse = sanitizedResponse.split(snippet).join('[内部情報が検出されたため非表示]');
      systemPromptLeakDetected = true;
    }
  }
  if (systemPromptLeakDetected) {
    redactions.push('system_prompt_leak');
  }

  // Rule 2: PII leak check
  // Apply patterns in order (phone_hyphen, phone_plain, email, postal_code)
  // phone patterns are applied before postal_code so more specific ones take priority
  for (const { name, pattern, replacement } of PII_PATTERNS) {
    // Reset lastIndex in case pattern is reused
    pattern.lastIndex = 0;
    const before = sanitizedResponse;
    sanitizedResponse = sanitizedResponse.replace(pattern, replacement);
    if (sanitizedResponse !== before) {
      redactions.push(name);
    }
  }

  // Rule 3: RAG excerpt exceeded check (final gate)
  const maxLength = getMaxRagExcerptLength();
  // Split by sentence delimiters and newlines to find long uninterrupted blocks
  // Delimiters: 。\n (and \n alone)
  const blocks = sanitizedResponse.split(/(。|\n)/);
  let result = '';
  let ragExcerptExceeded = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // Delimiter tokens (。 or \n) — pass through as-is
    if (block === '。' || block === '\n') {
      result += block;
      continue;
    }
    if (block.length > maxLength) {
      result += block.slice(0, maxLength) + '...';
      ragExcerptExceeded = true;
    } else {
      result += block;
    }
  }

  if (ragExcerptExceeded) {
    redactions.push('rag_excerpt_exceeded');
    sanitizedResponse = result;
  }

  return {
    safe: redactions.length === 0,
    sanitizedResponse,
    redactions,
  };
}
