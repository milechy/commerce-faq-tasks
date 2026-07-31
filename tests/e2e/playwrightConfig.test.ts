// tests/e2e/playwrightConfig.test.ts
//
// playwright.config.ts の testMatch ガードが外れていないことを Gate 1(1分)で検知する。
//
// なぜ必要か:
//   testDir が './tests/e2e' である一方、tests/ 配下は Jest と Playwright の二重所有。
//   Playwright の既定 testMatch は *.spec.ts だけでなく *.test.ts にも一致するため、
//   ガードが外れると Playwright が本ファイルや config.test.ts を読み込み、
//   `ReferenceError: describe is not defined` で収集が落ちて 103 テストが 0 件になる
//   (実測確認済み。exit code 1 なので CI は赤くなるが、原因が分かりにくく E2E の
//   3分半を消費してから失敗する)。ここで pin しておけば Gate 1 が即座に落ちる。
//
// なぜ import ではなく正規表現を抽出しているか:
//   playwright.config.ts は `@playwright/test` を import しており、Jest 内で読み込むと
//   expect の内部シンボルが衝突して `TypeError: Cannot redefine property:
//   Symbol($$jest-matchers-object)` になる(実測確認済み)。そのためソースから
//   正規表現リテラルを取り出し、実際にファイル名へ適用して挙動を検証する。

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.resolve(__dirname, '../../playwright.config.ts');
const source = fs.readFileSync(CONFIG_PATH, 'utf8');

/** ソース中の `testMatch: /.../flags` から RegExp を復元する。 */
function extractTestMatchRegexes(text: string): RegExp[] {
  const literals = text.match(/testMatch:\s*\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g) ?? [];
  return literals.map((literal) => {
    const body = literal.replace(/^testMatch:\s*\//, '');
    const lastSlash = body.lastIndexOf('/');
    return new RegExp(body.slice(0, lastSlash), body.slice(lastSlash + 1));
  });
}

/** projects: より前 = トップレベル設定。 */
const topLevelSection = source.slice(0, source.indexOf('projects:'));

const JEST_OWNED_FILES = [
  'tests/e2e/config.test.ts',
  'tests/e2e/playwrightConfig.test.ts',
  'config.test.ts',
];

describe('playwright.config.ts — testMatch ガード', () => {
  it('トップレベルに testMatch が定義されている(ガードの存在)', () => {
    expect(extractTestMatchRegexes(topLevelSection)).toHaveLength(1);
  });

  describe('トップレベル testMatch の挙動', () => {
    const [topLevel] = extractTestMatchRegexes(topLevelSection);

    it.each(JEST_OWNED_FILES)('Jest所有の %s に一致しない', (file) => {
      expect(topLevel.test(file)).toBe(false);
    });

    it.each([
      'tests/e2e/widget.spec.ts',
      'tests/e2e/qa-irregular-3roles.spec.ts',
      'tests/e2e/visual-regression.spec.ts',
    ])('Playwright所有の %s には一致する', (file) => {
      expect(topLevel.test(file)).toBe(true);
    });

    it.each(['tests/e2e/auth.setup.ts', 'tests/e2e/superadmin.setup.ts'])(
      'storageState生成の %s には一致する(除外すると認証が走らずRole B/Cが全skipになる)',
      (file) => {
        expect(topLevel.test(file)).toBe(true);
      },
    );
  });

  // Playwright ではプロジェクト個別の testMatch がトップレベルを上書きする。
  // 将来どのプロジェクトに testMatch が足されても、*.test.ts を拾い直さないことを保証する。
  it('ファイル内のどの testMatch も Jest所有の *.test.ts に一致しない', () => {
    const all = extractTestMatchRegexes(source);
    expect(all.length).toBeGreaterThanOrEqual(1);

    const offenders = all.flatMap((re) =>
      JEST_OWNED_FILES.filter((f) => re.test(f)).map((f) => `${String(re)} matches ${f}`),
    );
    expect(offenders).toEqual([]);
  });

  // chromium プロジェクトは testMatch を持たずトップレベルを継承することが前提。
  // ここに testMatch が足されるとガードが実質無効化されるため、変更時に気付けるようにする。
  it('chromium プロジェクトは testMatch を持たない(トップレベルのガードを継承する)', () => {
    const chromiumSection = source.slice(source.indexOf("name: 'chromium'"));
    const untilNextProject = chromiumSection.slice(0, chromiumSection.indexOf('},'));
    // 行コメント内の「testMatch」への言及を拾わないよう、コメントを除去してからキーを探す。
    const codeOnly = untilNextProject.replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toMatch(/\btestMatch\s*:/);
  });
});
