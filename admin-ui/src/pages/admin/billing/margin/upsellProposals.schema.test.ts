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
    expect(parseUpsellProposalsResponse({ proposals: [] })).toEqual({ proposals: [] });
  });

  it('オブジェクトでない入力は throw', () => {
    expect(() => parseUpsellProposalsResponse(null)).toThrow();
  });
});
