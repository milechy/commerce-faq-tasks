// tests/scripts/detectUnwiredExports.test.ts
// Phase44–46 未配線検知ツール (SCRIPTS/detect-unwired-exports.ts) の分類ロジック単体テスト。
// 純粋ヘルパー (isTestFile / classifyExport / isProdUnwired) を網羅する。
// AST 走査本体 (analyze) は実コードベース全体を読むため CLI 実行で手動検証する。

import {
  isTestFile,
  classifyExport,
  isProdUnwired,
  isIntentionalTestHelper,
  type ExportCategory,
} from '../../SCRIPTS/detect-unwired-exports';

describe('detect-unwired-exports: isTestFile', () => {
  const cases: [string, boolean][] = [
    ['src/foo/bar.test.ts', true],
    ['src/foo/bar.spec.ts', true],
    ['src/foo/bar.test.tsx', true],
    ['tests/agent/x.ts', true],
    ['src/__tests__/x.ts', true],
    ['/abs/path/src/x.test.ts', true],
    ['src/foo/bar.ts', false],
    ['src/foo/testHelpers.ts', false], // 'test' を含むが .test.ts ではない
    ['SCRIPTS/x.ts', false],
  ];
  it.each(cases)('%s -> isTest=%s', (p, expected) => {
    expect(isTestFile(p)).toBe(expected);
  });
});

describe('detect-unwired-exports: classifyExport', () => {
  it('外部 prod 参照あり -> wired', () => {
    expect(classifyExport({ externalProd: 2, selfFile: 0, test: 5 })).toBe('wired');
  });

  it('外部なし・同一ファイル内のみ -> internal-only', () => {
    expect(classifyExport({ externalProd: 0, selfFile: 3, test: 0 })).toBe('internal-only');
  });

  it('test 参照のみ -> test-only', () => {
    expect(classifyExport({ externalProd: 0, selfFile: 0, test: 4 })).toBe('test-only');
  });

  it('参照なし -> unreferenced', () => {
    expect(classifyExport({ externalProd: 0, selfFile: 0, test: 0 })).toBe('unreferenced');
  });

  it('外部 prod 参照は test/self より優先 (test seam 誤検知防止の要)', () => {
    // テストがあっても prod から使われていれば wired。これが本タスクの検知漏れ #1 への回答。
    expect(classifyExport({ externalProd: 1, selfFile: 0, test: 0 })).toBe('wired');
    expect(classifyExport({ externalProd: 1, selfFile: 9, test: 9 })).toBe('wired');
  });

  it('内部使用は test より優先 (internal-only は dead ではない)', () => {
    expect(classifyExport({ externalProd: 0, selfFile: 1, test: 3 })).toBe('internal-only');
  });
});

describe('detect-unwired-exports: isProdUnwired', () => {
  const map: [ExportCategory, boolean][] = [
    ['test-only', true],
    ['unreferenced', true],
    ['wired', false],
    ['internal-only', false],
    ['dynamic-ref', false], // 動的 import 等で配線されている可能性 → 未配線扱いしない
    ['test-helper', false], // 意図的なテスト足場 → 未配線機能ではない
  ];
  it.each(map)('%s -> prodUnwired=%s', (cat, expected) => {
    expect(isProdUnwired(cat)).toBe(expected);
  });
});

describe('detect-unwired-exports: isIntentionalTestHelper', () => {
  const cases: [string, boolean][] = [
    ['__resetCeEngineForTests', true],
    ['_resetPostHogClientForTest', true],
    ['_resetClientForTest', true],
    ['detectObjectionPatterns', false],
    ['runWeeklyReport', false],
    ['setSalesSessionMeta', false],
  ];
  it.each(cases)('%s -> testHelper=%s', (name, expected) => {
    expect(isIntentionalTestHelper(name)).toBe(expected);
  });
});
