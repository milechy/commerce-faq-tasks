// src/api/admin/agent/knowledgeImportStaging.test.ts
// チャットFAQ一括インポートのプロセス内ステージング（tenantId+sessionIdキー、TTL、上限）のテスト。

import {
  setStagedFaqImport,
  getStagedFaqImport,
  clearStagedFaqImport,
  __resetKnowledgeImportStagingForTest,
  type StagedFaqImport,
} from './knowledgeImportStaging';

function makeTextEntry(tenantId: string, overrides: Partial<StagedFaqImport> = {}): StagedFaqImport {
  return {
    kind: 'text',
    tenantId,
    faqs: [{ question: 'Q1', answer: 'A1', duplicate: null }],
    categoryOverride: null,
    truncated: false,
    createdAt: Date.now(),
    ...overrides,
  } as StagedFaqImport;
}

beforeEach(() => {
  __resetKnowledgeImportStagingForTest();
});

describe('knowledgeImportStaging', () => {
  it('保存したプレビューを同じ tenantId + sessionId で取得できる', () => {
    setStagedFaqImport('t1', 's1', makeTextEntry('t1'));
    const got = getStagedFaqImport('t1', 's1');
    expect(got).not.toBeNull();
    expect(got?.kind).toBe('text');
  });

  it('プレビューが無い場合は null', () => {
    expect(getStagedFaqImport('t1', 's1')).toBeNull();
  });

  it('別 sessionId のステージングは混ざらない', () => {
    setStagedFaqImport('t1', 's1', makeTextEntry('t1'));
    expect(getStagedFaqImport('t1', 's2')).toBeNull();
  });

  it('別 tenantId のステージングは混ざらない（テナント越境しない）', () => {
    setStagedFaqImport('t1', 's1', makeTextEntry('t1'));
    expect(getStagedFaqImport('t2', 's1')).toBeNull();
  });

  it('同じキーへの再保存は上書きされる', () => {
    setStagedFaqImport('t1', 's1', makeTextEntry('t1', { categoryOverride: 'pricing' }));
    setStagedFaqImport('t1', 's1', makeTextEntry('t1', { categoryOverride: 'store_info' }));
    const got = getStagedFaqImport('t1', 's1');
    expect(got?.categoryOverride).toBe('store_info');
  });

  it('clearStagedFaqImport で明示的に破棄できる', () => {
    setStagedFaqImport('t1', 's1', makeTextEntry('t1'));
    clearStagedFaqImport('t1', 's1');
    expect(getStagedFaqImport('t1', 's1')).toBeNull();
  });

  it('TTL(30分)を超えたプレビューは期限切れとして扱われる', () => {
    const THIRTY_ONE_MIN_AGO = Date.now() - 31 * 60 * 1000;
    setStagedFaqImport('t1', 's1', makeTextEntry('t1', { createdAt: THIRTY_ONE_MIN_AGO }));
    expect(getStagedFaqImport('t1', 's1')).toBeNull();
  });

  it('TTL(30分)以内のプレビューは有効', () => {
    const TWENTY_NINE_MIN_AGO = Date.now() - 29 * 60 * 1000;
    setStagedFaqImport('t1', 's1', makeTextEntry('t1', { createdAt: TWENTY_NINE_MIN_AGO }));
    expect(getStagedFaqImport('t1', 's1')).not.toBeNull();
  });

  it('上限(200件)を超えると最も古いエントリから追い出される', () => {
    for (let i = 0; i < 200; i++) {
      setStagedFaqImport(`t${i}`, 's1', makeTextEntry(`t${i}`));
    }
    // 200件目でまだ最初のエントリ(t0)は残っている
    expect(getStagedFaqImport('t0', 's1')).not.toBeNull();

    // 201件目を追加すると上限に達し、最古(t0)が追い出される
    setStagedFaqImport('t200', 's1', makeTextEntry('t200'));
    expect(getStagedFaqImport('t0', 's1')).toBeNull();
    expect(getStagedFaqImport('t200', 's1')).not.toBeNull();
    // 直近のエントリ(t199)はまだ残っている
    expect(getStagedFaqImport('t199', 's1')).not.toBeNull();
  });
});
