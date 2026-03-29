// tests/phase48/outputGuard.test.ts
// Phase48 Pane 4: L8 Output Guard unit tests

import { guardOutput, OutputGuardResult } from '../../src/middleware/outputGuard';

beforeEach(() => {
  process.env['OUTPUT_GUARD_ENABLED'] = 'true';
  delete process.env['MAX_RAG_EXCERPT_LENGTH'];
});

afterEach(() => {
  delete process.env['OUTPUT_GUARD_ENABLED'];
  delete process.env['MAX_RAG_EXCERPT_LENGTH'];
});

// ---------------------------------------------------------------------------
// Disabled (fast path)
// ---------------------------------------------------------------------------
describe('disabled fast path', () => {
  it('returns passthrough immediately when OUTPUT_GUARD_ENABLED is not set', () => {
    delete process.env['OUTPUT_GUARD_ENABLED'];
    const response = 'Security First — this should pass through unmodified';
    const result = guardOutput(response);
    expect(result.safe).toBe(true);
    expect(result.sanitizedResponse).toBe(response);
    expect(result.redactions).toHaveLength(0);
  });

  it('returns passthrough when OUTPUT_GUARD_ENABLED is "false"', () => {
    process.env['OUTPUT_GUARD_ENABLED'] = 'false';
    const response = 'Security First — passthrough';
    const result = guardOutput(response);
    expect(result.safe).toBe(true);
    expect(result.sanitizedResponse).toBe(response);
    expect(result.redactions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: System prompt leak detection
// ---------------------------------------------------------------------------
describe('system prompt leak detection', () => {
  it('redacts built-in snippet "Security First"', () => {
    const result = guardOutput('このシステムはSecurity Firstの原則で設計されています。');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('Security First');
    expect(result.sanitizedResponse).toContain('[内部情報が検出されたため非表示]');
  });

  it('redacts built-in snippet "ragExcerpt.slice(0, 200)"', () => {
    const result = guardOutput('内部処理: ragExcerpt.slice(0, 200) を適用しています');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('ragExcerpt.slice(0, 200)');
  });

  it('redacts built-in snippet "tenantId from JWT only"', () => {
    const result = guardOutput('認証ルール: tenantId from JWT only が適用されます');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
  });

  it('redacts built-in snippet "Mobile First"', () => {
    const result = guardOutput('設計方針はMobile Firstです');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('Mobile First');
  });

  it('redacts built-in snippet "Touch targets"', () => {
    const result = guardOutput('UIガイドライン: Touch targets ≥44px が必要です');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('Touch targets');
  });

  it('redacts built-in snippet "Anti-Slop"', () => {
    const result = guardOutput('Anti-Slop ポリシーにより制限されています');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('Anti-Slop');
  });

  it('redacts custom snippet passed as parameter', () => {
    const result = guardOutput(
      'このシステムはMY_SECRET_PHRASEを使っています',
      ['MY_SECRET_PHRASE']
    );
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('MY_SECRET_PHRASE');
    expect(result.sanitizedResponse).toContain('[内部情報が検出されたため非表示]');
  });

  it('redacts multiple custom snippets in one response', () => {
    const result = guardOutput(
      'PHRASE_A と PHRASE_B を含む応答です',
      ['PHRASE_A', 'PHRASE_B']
    );
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.sanitizedResponse).not.toContain('PHRASE_A');
    expect(result.sanitizedResponse).not.toContain('PHRASE_B');
  });

  it('is case-sensitive: does not redact "security first" (lowercase)', () => {
    const response = 'security first ポリシーについて説明します';
    const result = guardOutput(response);
    expect(result.safe).toBe(true);
    expect(result.sanitizedResponse).toBe(response);
    expect(result.redactions).toHaveLength(0);
  });

  it('only adds system_prompt_leak once even if multiple snippets match', () => {
    const result = guardOutput('Security First and Mobile First and Anti-Slop');
    expect(result.redactions.filter((r) => r === 'system_prompt_leak')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: PII leak detection
// ---------------------------------------------------------------------------
describe('PII leak detection', () => {
  it('redacts hyphenated phone number (XX-XXXX-XXXX)', () => {
    const result = guardOutput('お問い合わせ番号: 03-1234-5678 までご連絡ください');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('phone_hyphen');
    expect(result.sanitizedResponse).not.toContain('03-1234-5678');
    expect(result.sanitizedResponse).toContain('[個人情報のため非表示]');
  });

  it('redacts hyphenated phone number (XXX-XXXX-XXXX)', () => {
    const result = guardOutput('携帯: 090-1234-5678');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('phone_hyphen');
    expect(result.sanitizedResponse).not.toContain('090-1234-5678');
  });

  it('redacts plain 11-digit phone number starting with 0', () => {
    const result = guardOutput('電話番号は09012345678です');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('phone_plain');
    expect(result.sanitizedResponse).not.toContain('09012345678');
    expect(result.sanitizedResponse).toContain('[個人情報のため非表示]');
  });

  it('redacts plain 10-digit phone number starting with 0', () => {
    const result = guardOutput('固定電話: 0312345678');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('phone_plain');
    expect(result.sanitizedResponse).not.toContain('0312345678');
  });

  it('redacts email address', () => {
    const result = guardOutput('メール: user.name+tag@example.co.jp までどうぞ');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('email');
    expect(result.sanitizedResponse).not.toContain('user.name+tag@example.co.jp');
    expect(result.sanitizedResponse).toContain('[個人情報のため非表示]');
  });

  it('redacts standard email address format', () => {
    const result = guardOutput('contact: hello@example.com');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('email');
  });

  it('redacts postal code (XXX-XXXX)', () => {
    const result = guardOutput('〒123-4567 東京都...');
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('postal_code');
    expect(result.sanitizedResponse).not.toContain('123-4567');
    expect(result.sanitizedResponse).toContain('[個人情報のため非表示]');
  });

  it('phone_hyphen takes priority over postal_code for 3-digit prefix patterns', () => {
    // 090-1234-5678 — the pattern 090-1234 would match postal_code if phone_hyphen ran second
    // Since phone_hyphen runs first and replaces the whole match, postal_code sees no match
    const result = guardOutput('電話: 090-1234-5678');
    // phone_hyphen should catch this entire pattern
    expect(result.redactions).toContain('phone_hyphen');
    // The original number should be gone
    expect(result.sanitizedResponse).not.toContain('090-1234-5678');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: RAG excerpt exceeded check
// ---------------------------------------------------------------------------
describe('RAG excerpt exceeded check', () => {
  it('truncates a block of 200+ characters and appends "..."', () => {
    const longBlock = 'あ'.repeat(250);
    const result = guardOutput(longBlock);
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('rag_excerpt_exceeded');
    expect(result.sanitizedResponse).toContain('...');
    // Should be 200 chars + '...' = 203 chars
    expect(result.sanitizedResponse.length).toBeLessThanOrEqual(203);
  });

  it('does not truncate a block of exactly 200 characters', () => {
    const exactBlock = 'a'.repeat(200);
    const result = guardOutput(exactBlock);
    expect(result.redactions).not.toContain('rag_excerpt_exceeded');
    expect(result.sanitizedResponse).toBe(exactBlock);
  });

  it('does not truncate normal conversational responses', () => {
    const response = 'ご注文ありがとうございます。配送は3-5営業日でお届けします。ご不明点はお気軽にお問い合わせください。';
    const result = guardOutput(response);
    expect(result.redactions).not.toContain('rag_excerpt_exceeded');
    expect(result.sanitizedResponse).toBe(response);
  });

  it('splits on 。 and truncates only the offending block', () => {
    const shortBlock = '通常の短い文章です';
    const longBlock = 'x'.repeat(250);
    const response = `${shortBlock}。${longBlock}`;
    const result = guardOutput(response);
    expect(result.redactions).toContain('rag_excerpt_exceeded');
    expect(result.sanitizedResponse).toContain(shortBlock);
    expect(result.sanitizedResponse).toContain('...');
  });

  it('splits on newline and truncates only the offending block', () => {
    const shortBlock = '短い行';
    const longBlock = 'y'.repeat(250);
    const response = `${shortBlock}\n${longBlock}`;
    const result = guardOutput(response);
    expect(result.redactions).toContain('rag_excerpt_exceeded');
    expect(result.sanitizedResponse).toContain(shortBlock);
    expect(result.sanitizedResponse).toContain('...');
  });

  it('respects MAX_RAG_EXCERPT_LENGTH env var', () => {
    process.env['MAX_RAG_EXCERPT_LENGTH'] = '100';
    const longBlock = 'b'.repeat(150);
    const result = guardOutput(longBlock);
    expect(result.redactions).toContain('rag_excerpt_exceeded');
    // Should be truncated at 100 chars + '...'
    expect(result.sanitizedResponse).toBe('b'.repeat(100) + '...');
  });
});

// ---------------------------------------------------------------------------
// Normal business response — passes clean
// ---------------------------------------------------------------------------
describe('normal business response', () => {
  const normalResponses = [
    'ご注文ありがとうございます。',
    '返品は30日以内にお申し付けください。',
    '配送にはおよそ3営業日かかります。',
    '在庫状況を確認いたします。少々お待ちください。',
    'サイズ交換は可能です。お気軽にご連絡ください。',
  ];

  normalResponses.forEach((response) => {
    it(`passes clean: "${response.slice(0, 30)}..."`, () => {
      const result = guardOutput(response);
      expect(result.safe).toBe(true);
      expect(result.redactions).toHaveLength(0);
      expect(result.sanitizedResponse).toBe(response);
    });
  });
});

// ---------------------------------------------------------------------------
// Partial redaction: PII embedded in normal text
// ---------------------------------------------------------------------------
describe('partial redaction', () => {
  it('redacts PII but preserves surrounding normal text', () => {
    const result = guardOutput(
      'お電話番号 03-1234-5678 へのご連絡をお待ちしております。ご注文の確認はこちらから。'
    );
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('phone_hyphen');
    expect(result.sanitizedResponse).toContain('お電話番号');
    expect(result.sanitizedResponse).toContain('へのご連絡をお待ちしております');
    expect(result.sanitizedResponse).not.toContain('03-1234-5678');
  });
});

// ---------------------------------------------------------------------------
// Multiple redaction types in one response
// ---------------------------------------------------------------------------
describe('multiple redaction types', () => {
  it('redacts all: system prompt leak + PII + RAG excerpt in one response', () => {
    const longBlock = 'z'.repeat(250);
    const response = `Security First ポリシーに基づき、メールはuser@example.comへ。${longBlock}`;
    const result = guardOutput(response);

    expect(result.safe).toBe(false);
    expect(result.redactions).toContain('system_prompt_leak');
    expect(result.redactions).toContain('email');
    expect(result.redactions).toContain('rag_excerpt_exceeded');

    expect(result.sanitizedResponse).not.toContain('Security First');
    expect(result.sanitizedResponse).not.toContain('user@example.com');
    expect(result.sanitizedResponse).toContain('...');
  });

  it('lists each redaction type only once even with multiple matches of the same type', () => {
    const response = 'email1@test.com と email2@test.com の両方に送信しました';
    const result = guardOutput(response);
    expect(result.redactions.filter((r) => r === 'email')).toHaveLength(1);
  });
});
