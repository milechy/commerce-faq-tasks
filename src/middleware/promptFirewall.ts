// src/middleware/promptFirewall.ts
// Phase48 Pane 2: L7 Prompt Firewall

import { logger } from '../lib/logger';

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

// Shadowモード専用: ROLE_OVERRIDE_PATTERNS と同じ語彙だが、行頭アンカー(^)を
// 「文字列先頭 or 文末記号+空白の直後」に緩めたバージョン。
// 「よろしくお願いします。act as a pirate」のような文中埋め込みインジェクションを拾う。
// ブロック判定・文字列除去には一切使わず、検出頻度の計測(ログ出力のみ)に用いる
// （'forget'/'あなたは'は「パスワードを忘れました」等の正常な問い合わせにも頻出するため、
// 誤検知でエンドユーザーの会話を壊すコストの方が高い可能性があり、即ブロック昇格はしない）。
const ROLE_OVERRIDE_SHADOW_PATTERNS: StripPattern[] = [
  {
    name: 'role_override_en_shadow',
    pattern: /(?:^|[.!?。！？]\s*)(you are|act as|pretend|from now on|forget)\b/gim,
  },
  {
    name: 'role_override_ja_shadow',
    pattern: /(?:^|[.!?。！？]\s*)(あなたは|ふりをして|なりきって|今から|これから|忘れて|リセット)/gm,
  },
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

// production は既定ON（未設定/'false'以外はON）。development/test は既定OFF（明示的'true'時のみON）。
function isPromptFirewallEnabled(): boolean {
  const flag = process.env['PROMPT_FIREWALL_ENABLED'];
  if (process.env['NODE_ENV'] === 'production') return flag !== 'false';
  return flag === 'true';
}

// shadowモード: ブロックには使わず、緩めたパターンの発火頻度をログのみで計測する。
// 誤検知率を実トラフィックで確認してからブロック昇格を判断するための計測スイッチ。
function isPromptFirewallShadowEnabled(): boolean {
  const flag = process.env['PROMPT_FIREWALL_SHADOW_ENABLED'];
  if (process.env['NODE_ENV'] === 'production') return flag !== 'false';
  return flag === 'true';
}

logger.info(`[promptFirewall] L7 Prompt Firewall enabled=${isPromptFirewallEnabled()}`);
logger.info(`[promptFirewall] shadow detection enabled=${isPromptFirewallShadowEnabled()}`);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * shadowパターンで元メッセージを検査し、マッチしたパターン名をログ出力するのみ。
 * 本番の判定（allowed/sanitizedMessage/detections）には一切影響しない。
 * メッセージ本文はログに出さない（Anti-Slop: RAGコンテンツ・PIIをログに出さない方針）。
 */
function logShadowDetections(message: string): void {
  if (!isPromptFirewallShadowEnabled()) return;
  const shadowDetections: string[] = [];
  for (const { name, pattern } of ROLE_OVERRIDE_SHADOW_PATTERNS) {
    // 各パターンは stateful(g フラグ) な RegExp なので lastIndex をリセットしてから使う
    pattern.lastIndex = 0;
    if (pattern.test(message)) {
      shadowDetections.push(name);
    }
  }
  if (shadowDetections.length > 0) {
    logger.info(
      { shadowDetections, messageLength: message.length },
      '[promptFirewall] shadow detection (not blocked, measurement only)'
    );
  }
}

export function applyPromptFirewall(message: string): FirewallResult {
  // shadow計測は本番の有効/無効判定から独立して行う（メッセージのstrip前に検査する）
  logShadowDetections(message);

  // Enabled check — fast path
  if (!isPromptFirewallEnabled()) {
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
