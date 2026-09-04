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
});
