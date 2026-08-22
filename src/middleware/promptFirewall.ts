// src/middleware/promptFirewall.ts
// Phase48 Pane 2: L7 Prompt Firewall

import { logger } from '../lib/logger';
import { isSecurityLayerEnabled } from './securityLayerConfig';

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

// 役割上書き試行の語彙。本番用(行頭アンカー)とshadow用(緩めたアンカー)の
// 両パターンがこの1箇所だけを参照する。新語を足す際に片方だけ直す事故を防ぐため、
// 語彙とアンカーの関心をここで分離する。
const ROLE_OVERRIDE_WORDS_EN = 'you are|act as|pretend|from now on|forget';
const ROLE_OVERRIDE_WORDS_JA = 'あなたは|ふりをして|なりきって|今から|これから|忘れて|リセット';

// Group 2: Role override attempts
const ROLE_OVERRIDE_PATTERNS: StripPattern[] = [
  { name: 'role_override_en', pattern: new RegExp(`^(${ROLE_OVERRIDE_WORDS_EN})\\b`, 'gim') },
  { name: 'role_override_ja', pattern: new RegExp(`^(${ROLE_OVERRIDE_WORDS_JA})`, 'gm') },
  { name: 'dan_jailbreak', pattern: /\b(DAN|jailbreak)\b/gi },
];

// Shadowモード専用: ROLE_OVERRIDE_PATTERNSと同じ語彙(上記定数を共有)だが、
// 行頭アンカー(^)を「文字列先頭 or 文末記号+空白の直後」に緩めたバージョン。
// 「よろしくお願いします。act as a pirate」のような文中埋め込みインジェクションを拾う。
// ブロック判定・文字列除去には一切使わず、検出頻度の計測(ログ出力のみ)に用いる
// （'forget'/'あなたは'は「パスワードを忘れました」等の正常な問い合わせにも頻出するため、
// 誤検知でエンドユーザーの会話を壊すコストの方が高い可能性があり、即ブロック昇格はしない）。
const ROLE_OVERRIDE_SHADOW_PATTERNS: StripPattern[] = [
  {
    name: 'role_override_en_shadow',
    pattern: new RegExp(`(?:^|[.!?。！？]\\s*)(${ROLE_OVERRIDE_WORDS_EN})\\b`, 'gim'),
  },
  {
    name: 'role_override_ja_shadow',
    pattern: new RegExp(`(?:^|[.!?。！？]\\s*)(${ROLE_OVERRIDE_WORDS_JA})`, 'gm'),
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

function isPromptFirewallEnabled(): boolean {
  return isSecurityLayerEnabled('PROMPT_FIREWALL_ENABLED');
}

// shadowモード: ブロックには使わず、緩めたパターンの発火頻度をログのみで計測する。
// 誤検知率を実トラフィックで確認してからブロック昇格を判断するための計測スイッチ。
function isPromptFirewallShadowEnabled(): boolean {
  return isSecurityLayerEnabled('PROMPT_FIREWALL_SHADOW_ENABLED');
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
 *
 * shadowパターンは本番パターンを包含する上位集合（行頭ケースは両方にマッチする）。
 * 「アンカーを緩めたら新たに何を拾うか」を測る計測の趣旨上、本番側で既に検出済みの
 * 行頭ケースかどうかをパターン名単位で判定し alreadyDetectedByLive として残す
 * （ログを削らず、集計時にnewOnly = !alreadyDetectedByLiveで絞り込めるようにする）。
 */
function logShadowDetections(message: string): void {
  if (!isPromptFirewallShadowEnabled()) return;
  const shadowDetections: string[] = [];
  const newDetections: string[] = [];
  for (const { name, pattern } of ROLE_OVERRIDE_SHADOW_PATTERNS) {
    // 各パターンは stateful(g フラグ) な RegExp なので lastIndex をリセットしてから使う
    pattern.lastIndex = 0;
    if (!pattern.test(message)) continue;
    shadowDetections.push(name);

    const livePattern = ROLE_OVERRIDE_PATTERNS.find((p) => p.name === name.replace(/_shadow$/, ''));
    if (livePattern) livePattern.pattern.lastIndex = 0;
    const alreadyDetectedByLive = livePattern ? livePattern.pattern.test(message) : false;
    if (!alreadyDetectedByLive) newDetections.push(name);
  }
  if (shadowDetections.length > 0) {
    logger.info(
      {
        shadowDetections,
        newDetections, // 本番側では拾えていない=行頭以外(文中)で新たに検出した分のみ
        messageLength: message.length,
      },
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
