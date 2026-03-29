// src/middleware/outputGuard.ts
// Phase48 Pane 4: L8 Output Guard

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
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[個人情報のため非表示]',
  },
  {
    name: 'postal_code',
    pattern: /\d{3}-\d{4}/g,
    replacement: '[個人情報のため非表示]',
  },
];

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

export function guardOutput(
  llmResponse: string,
  systemPromptSnippets?: string[]
): OutputGuardResult {
  // Enabled check — fast path
  if (process.env['OUTPUT_GUARD_ENABLED'] !== 'true') {
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
