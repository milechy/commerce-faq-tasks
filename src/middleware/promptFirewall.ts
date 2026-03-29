// src/middleware/promptFirewall.ts
// Phase48 Pane 2: L7 Prompt Firewall

export interface FirewallResult {
  allowed: boolean;
  sanitizedMessage: string; // 有害パターンを除去した安全なメッセージ
  detections: string[]; // 検出されたパターン名のリスト
  userFacingMessage?: string; // ブロック時にユーザーに返すメッセージ
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface StripPattern {
  name: string;
  pattern: RegExp;
}

// Group 1: System prompt extraction attempts
const SYSTEM_PROMPT_PATTERNS: StripPattern[] = [
  { name: 'system_prompt_en', pattern: /system\s*prompt/gi },
  { name: 'system_prompt_ja', pattern: /システムプロンプト/g },
  { name: 'initial_instruction', pattern: /初期指示/g },
  { name: 'reveal_settings', pattern: /設定を教えて/g },
  { name: 'your_instructions', pattern: /あなたの?指示(は|を)/g },
  { name: 'repeat_above', pattern: /repeat\s*(the\s*)?(above|previous|initial)/gi },
  { name: 'ignore_previous', pattern: /ignore\s*(all\s*)?(previous|above)/gi },
  { name: 'ignore_ja', pattern: /上の指示を(無視|繰り返)/g },
  { name: 'print_instructions', pattern: /print\s*your\s*(instructions|prompt|rules)/gi },
];

// Group 2: Role override attempts
const ROLE_OVERRIDE_PATTERNS: StripPattern[] = [
  { name: 'role_override_en', pattern: /^(you are|act as|pretend|from now on|forget)\b/gim },
  {
    name: 'role_override_ja',
    pattern: /^(あなたは|ふりをして|なりきって|今から|これから|忘れて|リセット)/gm,
  },
  { name: 'dan_jailbreak', pattern: /\b(DAN|jailbreak)\b/gi },
];

// Group 3: Role marker injection
const ROLE_MARKER_PATTERNS: Array<{ pattern: RegExp }> = [
  { pattern: /^(System|Assistant|Human|User):\s*/gim },
  { pattern: /^(システム|アシスタント)[:：]\s*/gim },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeWhitespace(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function applyPromptFirewall(message: string): FirewallResult {
  // Enabled check — fast path
  if (process.env['PROMPT_FIREWALL_ENABLED'] !== 'true') {
    return { allowed: true, sanitizedMessage: message, detections: [] };
  }

  const detections: string[] = [];
  let working = message;

  // --- Group 1: System prompt extraction ---
  for (const { name, pattern } of SYSTEM_PROMPT_PATTERNS) {
    const before = working;
    working = working.replace(pattern, '');
    if (working !== before) {
      detections.push(name);
    }
  }

  // --- Group 2: Role overrides ---
  for (const { name, pattern } of ROLE_OVERRIDE_PATTERNS) {
    const before = working;
    working = working.replace(pattern, '');
    if (working !== before) {
      detections.push(name);
    }
  }

  // --- Group 3: Role markers ---
  let roleMarkerFound = false;
  for (const { pattern } of ROLE_MARKER_PATTERNS) {
    const before = working;
    working = working.replace(pattern, '');
    if (working !== before) {
      roleMarkerFound = true;
    }
  }
  if (roleMarkerFound) {
    detections.push('role_marker');
  }

  // --- Normalize whitespace ---
  const sanitizedMessage = normalizeWhitespace(working);

  // --- Empty result → blocked ---
  if (sanitizedMessage.length === 0) {
    return {
      allowed: false,
      sanitizedMessage: '',
      detections,
      userFacingMessage:
        'その質問にはお答えできません。商品やサービスについてお気軽にお聞きください。',
    };
  }

  return {
    allowed: true,
    sanitizedMessage,
    detections,
  };
}
