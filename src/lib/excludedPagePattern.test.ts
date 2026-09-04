// src/lib/excludedPagePattern.test.ts
import { isValidExcludedPagePattern, matchesPathnameGlob } from "./excludedPagePattern";

describe("isValidExcludedPagePattern", () => {
  it("先頭スラッシュのパスは有効", () => {
    expect(isValidExcludedPagePattern("/cart")).toBe(true);
    expect(isValidExcludedPagePattern("/products/*")).toBe(true);
    expect(isValidExcludedPagePattern("/blog/**")).toBe(true);
  });

  it("先頭スラッシュが無いと無効", () => {
    expect(isValidExcludedPagePattern("cart")).toBe(false);
  });

  it("クエリ文字列(?)を含むと無効", () => {
    expect(isValidExcludedPagePattern("/cart?step=2")).toBe(false);
  });

  it("フラグメント(#)を含むと無効", () => {
    expect(isValidExcludedPagePattern("/cart#top")).toBe(false);
  });

  it("空文字は無効", () => {
    expect(isValidExcludedPagePattern("")).toBe(false);
  });

  it("200文字ちょうどは有効、201文字は無効", () => {
    const at200 = "/" + "a".repeat(199);
    const at201 = "/" + "a".repeat(200);
    expect(at200.length).toBe(200);
    expect(isValidExcludedPagePattern(at200)).toBe(true);
    expect(isValidExcludedPagePattern(at201)).toBe(false);
  });
});

describe("matchesPathnameGlob", () => {
  it("完全一致", () => {
    expect(matchesPathnameGlob("/cart", "/cart")).toBe(true);
    expect(matchesPathnameGlob("/cart2", "/cart")).toBe(false);
  });

  it("* は1階層のみに一致（/を跨がない）", () => {
    expect(matchesPathnameGlob("/products/123", "/products/*")).toBe(true);
    expect(matchesPathnameGlob("/products/123/reviews", "/products/*")).toBe(false);
  });

  it("** は複数階層に一致", () => {
    expect(matchesPathnameGlob("/blog/2026/09/post", "/blog/**")).toBe(true);
  });

  it("正規表現メタ文字はエスケープされる", () => {
    expect(matchesPathnameGlob("/fooXhtml", "/foo.html")).toBe(false);
    expect(matchesPathnameGlob("/foo.html", "/foo.html")).toBe(true);
  });

  it("括弧など正規表現メタ文字を含むパターンでも例外を投げない", () => {
    expect(matchesPathnameGlob("/cart(", "/cart(")).toBe(true);
    expect(matchesPathnameGlob("/cart", "/cart(")).toBe(false);
  });

  it("[ ] を含むパターンもエスケープされリテラル文字として扱われる(文字クラスとして解釈されない)", () => {
    // "[" "]" は他のメタ文字と同じくエスケープ対象。不均衡な"["を含む文字列でも
    // エスケープ後は "\[" という有効なリテラルになるため RegExp としては壊れない。
    expect(matchesPathnameGlob("/foo[bar", "/foo[bar")).toBe(true);
    expect(matchesPathnameGlob("/foobar", "/foo[bar")).toBe(false);
  });

  it("RegExpコンストラクタが例外を投げても、try/catchで吸収しfalseを返す(呼び出し元に例外を漏らさない)", () => {
    // 現行のエスケープ設計では "*" 以外の正規表現メタ文字を事前に全てエスケープするため、
    // 通常の文字列だけで new RegExp を実際に throw させることはできない(不均衡な "[" "(" 等の
    // 全パターンを試したが、いずれもエスケープされて安全なリテラルになる)。
    // それでも「万一 RegExp 生成が失敗した場合に例外を外へ漏らさない」という
    // try/catch 自体の効果は、RegExp コンストラクタを一時的にスタブして直接検証できる。
    const spy = jest.spyOn(global, "RegExp").mockImplementation(() => {
      throw new SyntaxError("forced for test");
    });
    try {
      expect(matchesPathnameGlob("/cart", "/cart")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("trailing slashの有無は区別される(/blog と /blog/ は別のパスとして扱われる)", () => {
    // 完全一致パターンは末尾スラッシュを無視しない。サイトがURLを末尾スラッシュ付きに
    // 正規化しているのに、パターンをスラッシュ無しで登録すると効かない、という
    // 実運用上の落とし穴があるため挙動を明示的に固定する。
    expect(matchesPathnameGlob("/blog", "/blog")).toBe(true);
    expect(matchesPathnameGlob("/blog/", "/blog")).toBe(false);
    expect(matchesPathnameGlob("/blog", "/blog/")).toBe(false);
    expect(matchesPathnameGlob("/blog/", "/blog/")).toBe(true);
  });

  it("単一の* は/を跨いだ2階層以上には一致しない(**との違いを明示)", () => {
    expect(matchesPathnameGlob("/blog/2026/post", "/blog/*")).toBe(false);
    expect(matchesPathnameGlob("/blog/2026/09/post", "/blog/**")).toBe(true);
  });
});
