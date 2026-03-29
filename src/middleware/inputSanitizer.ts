// src/middleware/inputSanitizer.ts
// Phase48 Pane 1: L5 Input Sanitizer

export interface SanitizeResult {
  allowed: boolean;
  reason?: string; // 'url_detected' | 'too_long' | 'encoding_attack' | 'repeat_abuse'
  sanitizedMessage?: string; // 許可された場合のサニタイズ済みメッセージ
  userFacingMessage?: string; // ブロック時にユーザーに返すメッセージ（日本語）
  shouldTerminateSession?: boolean;
}

interface SessionEntry {
  messages: string[];
  blockCount: number;
  lastAccessedAt: number;
}

export const sessionHistoryStore: Map<string, SessionEntry> = new Map();

const URL_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /www\./i,
  /ftp:\/\//i,
  /[a-zA-Z0-9-]+\.(com|net|org|jp|co\.jp|io|dev|xyz|info|biz|me)(\/|\s|$)/i,
];

const ENCODING_PATTERNS = {
  base64DataUri: /data:[a-z]+\/[a-z]+;base64,/i,
  unicodeEscape: /\\u[0-9a-f]{4}/gi,
  htmlEntity: /&#x?[0-9a-f]+;/gi,
  nullByte: /\x00/g,
};

const SESSION_ENTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function evictExpiredSessions(): void {
  const now = Date.now();
  for (const [key, entry] of sessionHistoryStore.entries()) {
    if (now - entry.lastAccessedAt > SESSION_ENTRY_TTL_MS) {
      sessionHistoryStore.delete(key);
    }
  }
}

// Set up periodic eviction at module level
setInterval(evictExpiredSessions, SESSION_ENTRY_TTL_MS).unref?.();

function getMaxLength(): number {
  return parseInt(process.env['INPUT_MAX_LENGTH'] ?? '500', 10);
}

function getSessionAbuseLimit(): number {
  return parseInt(process.env['SESSION_ABUSE_LIMIT'] ?? '5', 10);
}

function checkUrl(message: string): SanitizeResult | null {
  for (const pattern of URL_PATTERNS) {
    if (pattern.test(message)) {
      return {
        allowed: false,
        reason: 'url_detected',
        userFacingMessage:
          '申し訳ありません。URLの送信には対応しておりません。ご質問をテキストでお送りください。',
      };
    }
  }
  return null;
}

function checkEncoding(message: string): { blocked: boolean; strippedMessage: string } {
  // Strip null bytes first
  let strippedMessage = message.replace(ENCODING_PATTERNS.nullByte, '');

  // Check base64 data URI
  if (ENCODING_PATTERNS.base64DataUri.test(strippedMessage)) {
    return { blocked: true, strippedMessage };
  }

  // Check unicode escapes (10+ occurrences)
  const unicodeMatches = strippedMessage.match(/\\u[0-9a-f]{4}/gi);
  if (unicodeMatches && unicodeMatches.length >= 10) {
    return { blocked: true, strippedMessage };
  }

  // Check HTML entities (5+ occurrences)
  const htmlEntityMatches = strippedMessage.match(/&#x?[0-9a-f]+;/gi);
  if (htmlEntityMatches && htmlEntityMatches.length >= 5) {
    return { blocked: true, strippedMessage };
  }

  // If entire message was just null bytes and is now empty → block
  if (strippedMessage.trim().length === 0 && message.length > 0) {
    return { blocked: true, strippedMessage };
  }

  return { blocked: false, strippedMessage };
}

function checkRepeat(
  message: string,
  sessionId: string,
  sessionHistory: Map<string, SessionEntry>
): SanitizeResult | null {
  const abuseLimit = getSessionAbuseLimit();

  if (!sessionHistory.has(sessionId)) {
    sessionHistory.set(sessionId, { messages: [], blockCount: 0, lastAccessedAt: Date.now() });
  }

  const entry = sessionHistory.get(sessionId)!;
  entry.lastAccessedAt = Date.now();

  // Check abuse limit first
  if (entry.blockCount >= abuseLimit) {
    return {
      allowed: false,
      reason: 'repeat_abuse',
      userFacingMessage:
        'この会話は終了しました。商品やサービスについて新しくご質問ください。',
      shouldTerminateSession: true,
    };
  }

  // Count occurrences of the same message already stored in this session.
  // We block on the 3rd send: sameCount >= 2 means we've seen it twice before.
  const sameCount = entry.messages.filter((m) => m === message).length;

  if (sameCount >= 2) {
    entry.blockCount += 1;
    return {
      allowed: false,
      reason: 'repeat_abuse',
      userFacingMessage: '同じ内容が繰り返されています。別のご質問をどうぞ。',
    };
  }

  // Record this message
  entry.messages.push(message);

  return null;
}

export function sanitizeInput(
  message: string,
  sessionId: string,
  sessionHistory?: Map<string, SessionEntry>
): SanitizeResult {
  // Enabled check — fast path
  if (process.env['INPUT_SANITIZER_ENABLED'] !== 'true') {
    return { allowed: true, sanitizedMessage: message };
  }

  const store = sessionHistory ?? sessionHistoryStore;

  // 1. URL check
  const urlResult = checkUrl(message);
  if (urlResult) {
    return urlResult;
  }

  // 2. Encoding check
  const { blocked: encodingBlocked, strippedMessage } = checkEncoding(message);
  if (encodingBlocked) {
    return {
      allowed: false,
      reason: 'encoding_attack',
      userFacingMessage:
        '不正なエンコーディングが検出されました。通常のテキストでお送りください。',
    };
  }

  // Use the null-byte-stripped message from here on
  let workingMessage = strippedMessage;

  // 3. Truncation check
  const maxLength = getMaxLength();
  let truncated = false;
  if (workingMessage.length > maxLength) {
    workingMessage = workingMessage.slice(0, maxLength);
    truncated = true;
  }

  // 4. Repeat check (uses possibly-truncated message for comparison)
  const repeatResult = checkRepeat(workingMessage, sessionId, store);
  if (repeatResult) {
    return repeatResult;
  }

  if (truncated) {
    return {
      allowed: true,
      reason: 'too_long',
      sanitizedMessage: workingMessage,
    };
  }

  return { allowed: true, sanitizedMessage: workingMessage };
}
