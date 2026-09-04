// admin-ui/src/pages/admin/billing/margin/upsellProposals.schema.test.ts
import { describe, it, expect } from 'vitest';
import { parseUpsellProposalsResponse } from './upsellProposals.schema';

const RENDERABLE = {
  proposal_id: '1', tenant_id: 't1', renderable: true,
  headline: 'アップセル候補', lines: ['粗利 ¥20,800'], created_at: '2026-09-04T00:00:00Z',
};

describe('parseUpsellProposalsResponse', () => {
  it('renderable:true の行を正しくパースする', () => {
    const r = parseUpsellProposalsResponse({ proposals: [RENDERABLE] });
    expect(r.proposals[0]).toEqual(RENDERABLE);
  });

  it('renderable:false の行はheadline/lines無しで通る', () => {
    const r = parseUpsellProposalsResponse({
      proposals: [{ proposal_id: '2', tenant_id: 't2', renderable: false, created_at: 'x' }],
    });
    expect(r.proposals[0]).toEqual({ proposal_id: '2', tenant_id: 't2', renderable: false, created_at: 'x' });
  });

  it('★__proto__ を含む行でも Object.prototype を汚染しない★', () => {
    const malicious = JSON.parse(
      `{"proposal_id":"1","tenant_id":"t1","renderable":true,"headline":"x","lines":[],"created_at":"x","__proto__":{"polluted":"yes"}}`
    );
    parseUpsellProposalsResponse({ proposals: [malicious] });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('proposals が配列でなければ throw', () => {
    expect(() => parseUpsellProposalsResponse({ proposals: 'nope' })).toThrow();
  });

  it('proposal_id が空文字なら throw', () => {
    expect(() => parseUpsellProposalsResponse({
      proposals: [{ ...RENDERABLE, proposal_id: '' }],
    })).toThrow();
  });

  it('renderable:true なのに headline が欠落していれば throw', () => {
    const { headline: _h, ...rest } = RENDERABLE;
    void _h;
    expect(() => parseUpsellProposalsResponse({ proposals: [rest] })).toThrow();
  });

  it('lines に非文字列が混ざっていれば throw', () => {
    expect(() => parseUpsellProposalsResponse({
      proposals: [{ ...RENDERABLE, lines: ['ok', 123] }],
    })).toThrow();
  });

  it('空配列でも正常に処理する', () => {
    expect(parseUpsellProposalsResponse({ proposals: [] })).toEqual({ proposals: [], truncated: false });
  });

  it('オブジェクトでない入力は throw', () => {
    expect(() => parseUpsellProposalsResponse(null)).toThrow();
  });

  it('truncated:true をそのまま伝える(P1a: 上限に当たったことを黙って落とさない)', () => {
    const r = parseUpsellProposalsResponse({ proposals: [], truncated: true });
    expect(r.truncated).toBe(true);
  });

  it('truncated が欠落・非真偽値なら false に倒す(0にはしないが、暴走UIも作らない)', () => {
    expect(parseUpsellProposalsResponse({ proposals: [] }).truncated).toBe(false);
    expect(parseUpsellProposalsResponse({ proposals: [], truncated: 'yes' }).truncated).toBe(false);
  });

  it('★period_yyyymm/stale をそのまま伝える(P2b: 陳腐化検知)★', () => {
    const r = parseUpsellProposalsResponse({
      proposals: [{ ...RENDERABLE, period_yyyymm: '202609', stale: true }],
    });
    expect(r.proposals[0].period_yyyymm).toBe('202609');
    expect(r.proposals[0].stale).toBe(true);
  });

  it('renderable:false の行にも period_yyyymm/stale が付く', () => {
    const r = parseUpsellProposalsResponse({
      proposals: [{
        proposal_id: '2', tenant_id: 't2', renderable: false, created_at: 'x',
        period_yyyymm: '202608', stale: true,
      }],
    });
    expect(r.proposals[0].period_yyyymm).toBe('202608');
    expect(r.proposals[0].stale).toBe(true);
  });

  it('period_yyyymm/stale が欠落・型違いなら undefined に倒す(誤った日付を出さない)', () => {
    const r1 = parseUpsellProposalsResponse({ proposals: [RENDERABLE] });
    expect(r1.proposals[0].period_yyyymm).toBeUndefined();
    expect(r1.proposals[0].stale).toBeUndefined();

    const r2 = parseUpsellProposalsResponse({
      proposals: [{ ...RENDERABLE, period_yyyymm: 202609, stale: 'yes' }],
    });
    expect(r2.proposals[0].period_yyyymm).toBeUndefined();
    expect(r2.proposals[0].stale).toBeUndefined();
  });
});
