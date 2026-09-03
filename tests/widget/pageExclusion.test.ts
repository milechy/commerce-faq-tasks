// tests/widget/pageExclusion.test.ts
// widget.js の matchPathnameGlob() — ページ除外設定(excluded_page_patterns)の
// パスマッチングロジックのユニットテスト。
//
// 方針: 他の tests/widget/*.test.ts と同様、実際の widget.js を eval せず、
// 同一ロジックを抽出して検証する（public/widget.js の matchPathnameGlob と
// 完全同一に保つこと）。ロジックの乖離は tests/widget/widgetSourceInvariants.test.ts
// が別途チェックしている。

function matchPathnameGlob(pathname: string, pattern: string): boolean {
  try {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '@@R2C_DBLSTAR@@')
      .replace(/\*/g, '[^/]*')
      .replace(/@@R2C_DBLSTAR@@/g, '.*');
    const regex = new RegExp('^' + regexStr + '$');
    return regex.test(pathname);
  } catch {
    return false;
  }
}

function isExcludedPage(pathname: string, patterns: string[]): boolean {
  return patterns.some((p) => matchPathnameGlob(pathname, p));
}

describe('widget.js matchPathnameGlob (ページ除外設定)', () => {
  describe('完全一致', () => {
    it('/cart は /cart にのみ一致する', () => {
      expect(matchPathnameGlob('/cart', '/cart')).toBe(true);
      expect(matchPathnameGlob('/cart/1', '/cart')).toBe(false);
      expect(matchPathnameGlob('/carts', '/cart')).toBe(false);
    });
  });

  describe('単一階層ワイルドカード(*)', () => {
    it('/products/* は1階層下にのみ一致する', () => {
      expect(matchPathnameGlob('/products/shoes', '/products/*')).toBe(true);
      expect(matchPathnameGlob('/products', '/products/*')).toBe(false);
      expect(matchPathnameGlob('/products/shoes/1', '/products/*')).toBe(false);
    });
  });

  describe('複数階層ワイルドカード(**)', () => {
    it('/blog/** は配下すべてに一致する', () => {
      expect(matchPathnameGlob('/blog/2026/post-1', '/blog/**')).toBe(true);
      expect(matchPathnameGlob('/blog', '/blog/**')).toBe(false);
      expect(matchPathnameGlob('/blog/', '/blog/**')).toBe(true);
    });

    it('** と * の二段置換が衝突しない(shoes/** が shoes/.[^/]* にならない)', () => {
      expect(matchPathnameGlob('/shoes/a/b/c', '/shoes/**')).toBe(true);
    });
  });

  describe('正規表現メタ文字のエスケープ', () => {
    it('"." はリテラルの1文字として扱われ、任意の1文字にはマッチしない', () => {
      expect(matchPathnameGlob('/foo.html', '/foo.html')).toBe(true);
      expect(matchPathnameGlob('/fooXhtml', '/foo.html')).toBe(false);
    });

    it('"(" のようなメタ文字を含むパターンでも例外にならず、リテラル一致として扱われる', () => {
      expect(matchPathnameGlob('/cart(', '/cart(')).toBe(true);
      expect(matchPathnameGlob('/cart', '/cart(')).toBe(false);
    });

    it('"*" はエスケープされずグロブ構文として機能し続ける', () => {
      expect(matchPathnameGlob('/products/shoes', '/products/*')).toBe(true);
    });
  });

  describe('異常系', () => {
    it('不正な正規表現になるパターンでも例外を投げず false を返す', () => {
      expect(matchPathnameGlob('/cart', '[')).toBe(false);
    });
  });

  describe('isExcludedPage(除外リスト全体の判定)', () => {
    it('空配列では誰も除外されない', () => {
      expect(isExcludedPage('/cart', [])).toBe(false);
    });

    it('複数パターンのいずれかに一致すれば除外', () => {
      const patterns = ['/cart', '/checkout/**', '/mypage/*'];
      expect(isExcludedPage('/checkout/confirm', patterns)).toBe(true);
      expect(isExcludedPage('/top', patterns)).toBe(false);
    });
  });
});
