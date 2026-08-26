// tests/security/internalTerms.test.ts
// 社内用語(RAJIUSEC/ARCSTRA の法則)の伏せ字化

import { redactInternalTerms, INTERNAL_TERM_HOLD_CHARS } from '../../src/middleware/outputGuard';

describe('redactInternalTerms', () => {
  it.each([
    'RAJIUSECの法則',
    'ラジウスの法則',
    'ラジウセックの法則',
    'ARCSTRAの法則',
    'アクストラの法則',
    'rajiusecの法則',
    'ArcStraの法則',
  ])('伏せる: %s', (term) => {
    const result = redactInternalTerms(`当店では${term}に基づいてご提案しています。`);
    expect(result.redacted).toBe(true);
    expect(result.text).toBe('当店では独自の考え方に基づいてご提案しています。');
  });

  it('「の法則」を伴わない単独の呼称も伏せる', () => {
    const result = redactInternalTerms('ARCSTRAをご存知ですか。');
    expect(result.text).toBe('独自の考え方をご存知ですか。');
  });

  it('1文に複数出てもすべて伏せる', () => {
    const result = redactInternalTerms('RAJIUSECの法則とARCSTRAの法則を組み合わせます。');
    expect(result.text).toBe('独自の考え方と独自の考え方を組み合わせます。');
  });

  it('無関係な文は変更しない', () => {
    const text = '本日の営業時間は10時から19時までです。';
    const result = redactInternalTerms(text);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it('OUTPUT_GUARD_ENABLED が無効でも伏せる', () => {
    process.env['OUTPUT_GUARD_ENABLED'] = 'false';
    try {
      expect(redactInternalTerms('ラジウスの法則です').text).toBe('独自の考え方です');
    } finally {
      delete process.env['OUTPUT_GUARD_ENABLED'];
    }
  });

  it('保留幅は最長パターンより長い', () => {
    expect(INTERNAL_TERM_HOLD_CHARS).toBeGreaterThan('RAJIUSECの法則性'.length);
  });
});

describe('ストリーミング分割時の伏せ字化', () => {
  // anamChatStreamRoutes の flushPending と同じ手順を再現する
  function streamRedact(chunks: string[]): string {
    let pending = '';
    let emitted = '';
    const flush = (final: boolean): void => {
      pending = redactInternalTerms(pending).text;
      const cut = final ? pending.length : pending.length - INTERNAL_TERM_HOLD_CHARS;
      if (cut <= 0) return;
      emitted += pending.slice(0, cut);
      pending = pending.slice(cut);
    };
    for (const c of chunks) {
      pending += c;
      flush(false);
    }
    flush(true);
    return emitted;
  }

  it('用語がチャンク境界で分割されても伏せる', () => {
    const out = streamRedact(['当店では', 'RAJI', 'USEC', 'の法', '則に基づいてご提案しています。']);
    expect(out).toBe('当店では独自の考え方に基づいてご提案しています。');
  });

  it('1文字ずつ届いても伏せる', () => {
    const out = streamRedact('ARCSTRAの法則でご案内します。'.split(''));
    expect(out).toBe('独自の考え方でご案内します。');
  });

  it('用語を含まない場合は全文がそのまま出る', () => {
    const text = '本日の営業時間は10時から19時までです。';
    expect(streamRedact(text.split(''))).toBe(text);
  });
});
