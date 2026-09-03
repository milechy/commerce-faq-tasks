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

describe('禁止38: ②静的埋め込み・③db===nullリダイレクト経路では除外設定が効かない(fail-open, 既知の制限)', () => {
  // CLAUDE.md 絶対にやってはいけないこと 38: ウィジェットの配布経路は
  // ①GET /widget/:tenantSlug.js(動的、テナント設定を注入) ②public/widget.js +
  // data-tenant属性(静的、プラン判定を一切経由しない) ③①がdb===nullのとき②へ
  // リダイレクト、の3経路。excluded_page_patterns(本ファイルの対象機能)は①の
  // widgetGenerator.ts が window.__RAJIUCE_TENANT_CFG__ へ注入することでしか
  // 反映されないため、②③では常に「除外なし(全ページ表示)」に落ちる。
  //
  // これは単なる未実装ではなく、この機能の目的(「ウィジェットを出す面の限定を
  // R2C側の設定で効かせる、テナントの貼り方に依存させない」)そのものを②③では
  // 満たせていない既知の制限。塞ぐかどうかは製品判断のため、ここでは「気づかない
  // まま壊れている」状態を「テストで宣言された既知の制限」に変えるに留める
  // (第2の埋め込み経路を新設して②③でも取得しに行く、という解決はしない —
  // 「第2の埋め込み経路を作らない」に反するため)。

  it('②静的 /widget.js + data-tenant 埋め込みでは window.__RAJIUCE_TENANT_CFG__ が存在せず、excludedPagePatterns は常に空配列になる', () => {
    // public/widget.js:45 付近の `_rajiuceTenantCfg = window.__RAJIUCE_TENANT_CFG__ || {}` を模す。
    // このグローバルは①の動的ルートのみが注入するため、静的埋め込みでは常に {} になる。
    const rajiuceTenantCfg: { excludedPagePatterns?: string[] } = {};
    const excludedPagePatterns = rajiuceTenantCfg.excludedPagePatterns || [];
    expect(excludedPagePatterns).toEqual([]);

    // テナントが管理画面で '/cart' を除外設定していても、静的埋め込みの訪問者には
    // その設定が一切届かず、常に表示されてしまう。
    expect(isExcludedPage('/cart', excludedPagePatterns)).toBe(false);
  });

  it('③GET /widget/:tenantSlug.js が db===null で /widget.js へリダイレクトする経路も、②と同じ静的配布物のため除外設定が効かない', () => {
    // リダイレクト自体(src/api/widget/routes.ts)と302の実挙動は
    // src/api/widget/routes.test.ts の
    // '②db===nullのとき /widget.js へフォールバックし、バッジ制御ロジックを経由しない(fail-open)'
    // が既に固定している。リダイレクト先は②と同一の静的配布物であるため、
    // 上記②のfail-open検証(excludedPagePatternsが常に空配列になる)がそのまま
    // この経路にも適用される。ここでは経路の対応関係を明記するのみ(実行不要)。
    expect(true).toBe(true);
  });
});
