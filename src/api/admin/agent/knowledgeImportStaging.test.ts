// src/api/admin/agent/knowledgeImportStaging.test.ts
// チャットFAQ一括インポートのプロセス内ステージング（tenantId+sessionIdキー、TTL、上限）のテスト。

import {
  setStagedFaqImport,
  getStagedFaqImport,
  clearStagedFaqImport,
  selectFromStagedFaqImport,
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

// GID 1218166714484055: 件単位選択インポート(commit-selected)が使う純関数。
// フラット順indexの解決・境界値(範囲外/負/重複)を、HTTPルートを経由せずここで固定する。
describe('selectFromStagedFaqImport', () => {
  const faqA = { question: 'Q-A', answer: 'A-A', duplicate: null };
  const faqB = { question: 'Q-B', answer: 'A-B', duplicate: null };
  const faqC = { question: 'Q-C', answer: 'A-C', duplicate: { existingQuestion: 'Q-A?', existingAnswer: 'A-A' } };

  function textStaged(faqs = [faqA, faqB, faqC]): StagedFaqImport {
    return { kind: 'text', tenantId: 't1', faqs, categoryOverride: null, truncated: false, createdAt: Date.now() };
  }

  it('text: 選択したindexのFAQのみを返す', () => {
    const result = selectFromStagedFaqImport(textStaged(), [0, 2]);
    expect(result).toEqual({ kind: 'text', faqs: [faqA, faqC] });
  });

  it('text: selectedIndicesが空配列なら空配列を返す(全件へのフォールバックはしない)', () => {
    const result = selectFromStagedFaqImport(textStaged(), []);
    expect(result).toEqual({ kind: 'text', faqs: [] });
  });

  it('text: 範囲外・負のindexは無視される(クラッシュしない)', () => {
    const result = selectFromStagedFaqImport(textStaged(), [1, 999, -1]);
    expect(result).toEqual({ kind: 'text', faqs: [faqB] });
  });

  it('text: 同じindexを複数回渡しても対応するFAQは1回しか含まれない', () => {
    const result = selectFromStagedFaqImport(textStaged(), [0, 0, 0]);
    expect(result).toEqual({ kind: 'text', faqs: [faqA] });
  });

  it('scrape: 複数URLをまたぐflat indexで選択を解決する(URL単位ではなく通し番号)', () => {
    const staged: StagedFaqImport = {
      kind: 'scrape',
      tenantId: 't1',
      items: [
        { url: 'https://example.com/p/1', faqs: [faqA, faqB] },
        { url: 'https://example.com/p/2', faqs: [faqC] },
      ],
      categoryOverride: null,
      truncated: false,
      createdAt: Date.now(),
    };
    // flat index: 0=faqA(p/1), 1=faqB(p/1), 2=faqC(p/2)
    const result = selectFromStagedFaqImport(staged, [1, 2]);
    expect(result).toEqual({
      kind: 'scrape',
      items: [
        { url: 'https://example.com/p/1', faqs: [faqB] },
        { url: 'https://example.com/p/2', faqs: [faqC] },
      ],
    });
  });

  it('scrape: あるURLグループの選択が0件になった場合、そのURLは結果から除外される(空グループを残さない)', () => {
    const staged: StagedFaqImport = {
      kind: 'scrape',
      tenantId: 't1',
      items: [
        { url: 'https://example.com/p/1', faqs: [faqA, faqB] },
        { url: 'https://example.com/p/2', faqs: [faqC] },
      ],
      categoryOverride: null,
      truncated: false,
      createdAt: Date.now(),
    };
    // p/1(index 0,1)は選ばず、p/2(index 2)のみ選択する
    const result = selectFromStagedFaqImport(staged, [2]);
    expect(result).toEqual({
      kind: 'scrape',
      items: [{ url: 'https://example.com/p/2', faqs: [faqC] }],
    });
  });

  it('scrape: 何も選択しなければitemsは空配列になる', () => {
    const staged: StagedFaqImport = {
      kind: 'scrape',
      tenantId: 't1',
      items: [{ url: 'https://example.com/p/1', faqs: [faqA] }],
      categoryOverride: null,
      truncated: false,
      createdAt: Date.now(),
    };
    const result = selectFromStagedFaqImport(staged, []);
    expect(result).toEqual({ kind: 'scrape', items: [] });
  });
});
