// tests/phase48/inputSanitizer.test.ts
// Phase48 Pane 1: L5 Input Sanitizer tests

import {
  sanitizeInput,
  evictExpiredSessions,
  sessionHistoryStore,
  SanitizeResult,
} from '../../src/middleware/inputSanitizer';

const SESSION_A = 'session-aaa';
const SESSION_B = 'session-bbb';
const SESSION_C = 'session-ccc';
const SESSION_D = 'session-ddd';
const SESSION_E = 'session-eee';
const SESSION_F = 'session-fff';
const SESSION_G = 'session-ggg';

beforeEach(() => {
  // Enable sanitizer for all tests
  process.env['INPUT_SANITIZER_ENABLED'] = 'true';
  delete process.env['INPUT_MAX_LENGTH'];
  delete process.env['SESSION_ABUSE_LIMIT'];
  // Clear the shared session store before each test
  sessionHistoryStore.clear();
});

afterEach(() => {
  delete process.env['INPUT_SANITIZER_ENABLED'];
});

// ---------------------------------------------------------------------------
// Disabled (fast path)
// ---------------------------------------------------------------------------
describe('disabled fast path', () => {
  it('returns allowed:true immediately when INPUT_SANITIZER_ENABLED is not "true"', () => {
    process.env['INPUT_SANITIZER_ENABLED'] = 'false';
    const result = sanitizeInput('http://evil.com', 'any-session');
    expect(result.allowed).toBe(true);
    expect(result.sanitizedMessage).toBe('http://evil.com');
  });
});

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------
describe('URL detection', () => {
  it('blocks http:// URLs', () => {
    const result = sanitizeInput('この商品は http://example.com で買えますか', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
    expect(result.userFacingMessage).toContain('URLの送信');
  });

  it('blocks https:// URLs', () => {
    const result = sanitizeInput('https://shop.example.com/item?id=1', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('blocks www. URLs', () => {
    const result = sanitizeInput('www.example.com を見てください', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('blocks ftp:// URLs', () => {
    const result = sanitizeInput('ftp://files.example.com/data', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('blocks domain patterns ending in .com', () => {
    const result = sanitizeInput('shop.com を参照してください', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('blocks domain patterns ending in .jp', () => {
    const result = sanitizeInput('example.jp にアクセスしてください', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('blocks domain patterns ending in .io', () => {
    const result = sanitizeInput('connect to api.io for info', SESSION_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('does NOT block normal Japanese business message (false positive guard)', () => {
    const result = sanitizeInput('このシステムの保証は何年ですか？', SESSION_A);
    expect(result.allowed).toBe(true);
  });

  it('does NOT block message with "ネット" (false positive guard)', () => {
    const result = sanitizeInput('インターネットで購入できますか？', SESSION_A);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Length truncation
// ---------------------------------------------------------------------------
describe('length truncation', () => {
  it('truncates message over 500 chars but still allows it', () => {
    const longMessage = 'あ'.repeat(600);
    const result = sanitizeInput(longMessage, SESSION_B);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('too_long');
    expect(result.sanitizedMessage).toHaveLength(500);
  });

  it('respects custom INPUT_MAX_LENGTH env var', () => {
    process.env['INPUT_MAX_LENGTH'] = '100';
    const longMessage = 'x'.repeat(200);
    const result = sanitizeInput(longMessage, SESSION_B);
    expect(result.allowed).toBe(true);
    expect(result.sanitizedMessage).toHaveLength(100);
  });

  it('passes message exactly at limit without truncation', () => {
    const exactMessage = 'a'.repeat(500);
    const result = sanitizeInput(exactMessage, SESSION_B);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.sanitizedMessage).toHaveLength(500);
  });

  it('passes short message without modifying it', () => {
    const result = sanitizeInput('配送について教えてください', SESSION_B);
    expect(result.allowed).toBe(true);
    expect(result.sanitizedMessage).toBe('配送について教えてください');
  });
});

// ---------------------------------------------------------------------------
// Encoding attack detection
// ---------------------------------------------------------------------------
describe('encoding attack detection', () => {
  it('blocks base64 data URI', () => {
    const result = sanitizeInput(
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      SESSION_C
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('encoding_attack');
    expect(result.userFacingMessage).toContain('エンコーディング');
  });

  it('blocks messages with 10 or more unicode escapes', () => {
    const unicodeSpam = '\\u0041'.repeat(10); // 10 occurrences
    const result = sanitizeInput(unicodeSpam, SESSION_C);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('encoding_attack');
  });

  it('allows messages with fewer than 10 unicode escapes', () => {
    const fewUnicode = '\\u0041'.repeat(9); // 9 occurrences — below threshold
    const result = sanitizeInput(fewUnicode, SESSION_C);
    expect(result.allowed).toBe(true);
  });

  it('blocks messages with 5 or more HTML entities', () => {
    const entitySpam = '&#x41;&#x42;&#x43;&#x44;&#x45;'; // 5 occurrences
    const result = sanitizeInput(entitySpam, SESSION_C);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('encoding_attack');
  });

  it('strips null bytes but still allows the message', () => {
    const withNull = 'hello\x00world';
    const result = sanitizeInput(withNull, SESSION_C);
    expect(result.allowed).toBe(true);
    expect(result.sanitizedMessage).toBe('helloworld');
  });

  it('allows messages with fewer than 5 HTML entities', () => {
    const fewEntities = '&#x41;&#x42;&#x43;&#x44;'; // 4 occurrences — below threshold
    const result = sanitizeInput(fewEntities, SESSION_C);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Repeat detection
// ---------------------------------------------------------------------------
describe('repeat detection', () => {
  it('allows the same message sent 1 time', () => {
    const result = sanitizeInput('返品方法を教えてください', SESSION_D);
    expect(result.allowed).toBe(true);
  });

  it('allows the same message sent 2 times', () => {
    sanitizeInput('返品方法を教えてください', SESSION_D);
    const result = sanitizeInput('返品方法を教えてください', SESSION_D);
    expect(result.allowed).toBe(true);
  });

  it('allows the same message sent 2 more times (total 2 unique messages)', () => {
    sanitizeInput('返品方法を教えてください', SESSION_D);
    const result2 = sanitizeInput('返品方法を教えてください', SESSION_D);
    expect(result2.allowed).toBe(true);
  });

  it('blocks on the 3rd occurrence of the same message', () => {
    sanitizeInput('返品方法を教えてください', SESSION_E);
    sanitizeInput('返品方法を教えてください', SESSION_E);
    const result = sanitizeInput('返品方法を教えてください', SESSION_E);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('repeat_abuse');
    expect(result.userFacingMessage).toContain('繰り返されています');
  });

  it('does not cross-contaminate different sessions', () => {
    sanitizeInput('hello', SESSION_F);
    sanitizeInput('hello', SESSION_F);
    // Different session — should not see the history from SESSION_F
    const result = sanitizeInput('hello', SESSION_G);
    expect(result.allowed).toBe(true);
  });

  it('blocks session when blockCount reaches SESSION_ABUSE_LIMIT with shouldTerminateSession', () => {
    process.env['SESSION_ABUSE_LIMIT'] = '2';
    const msg1 = '同じメッセージ1';
    const msg2 = '同じメッセージ2';

    // First abuse: same message 3 times
    sanitizeInput(msg1, SESSION_F);
    sanitizeInput(msg1, SESSION_F);
    sanitizeInput(msg1, SESSION_F); // blocked → blockCount becomes 1

    // Second abuse: different repeated message
    sanitizeInput(msg2, SESSION_F);
    sanitizeInput(msg2, SESSION_F);
    sanitizeInput(msg2, SESSION_F); // blocked → blockCount becomes 2 (= limit)

    // Now blockCount >= limit → terminate
    const result = sanitizeInput('any message', SESSION_F);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('repeat_abuse');
    expect(result.shouldTerminateSession).toBe(true);
    expect(result.userFacingMessage).toContain('終了しました');
  });
});

// ---------------------------------------------------------------------------
// evictExpiredSessions
// ---------------------------------------------------------------------------
describe('evictExpiredSessions', () => {
  it('removes sessions older than 30 minutes', () => {
    const oldTimestamp = Date.now() - 31 * 60 * 1000; // 31 minutes ago
    sessionHistoryStore.set('old-session', {
      messages: ['test'],
      blockCount: 0,
      lastAccessedAt: oldTimestamp,
    });
    sessionHistoryStore.set('fresh-session', {
      messages: ['test'],
      blockCount: 0,
      lastAccessedAt: Date.now(),
    });

    evictExpiredSessions();

    expect(sessionHistoryStore.has('old-session')).toBe(false);
    expect(sessionHistoryStore.has('fresh-session')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Normal business messages — pass all checks
// ---------------------------------------------------------------------------
describe('normal business messages', () => {
  const normalMessages = [
    'このシステムの保証は何年ですか？',
    '返品ポリシーについて教えてください',
    '配送にはどのくらい時間がかかりますか？',
    '在庫を確認したいです',
    'サイズ交換は可能ですか？',
  ];

  normalMessages.forEach((msg) => {
    it(`passes: "${msg}"`, () => {
      const result = sanitizeInput(msg, `normal-${msg}`);
      expect(result.allowed).toBe(true);
    });
  });
});
