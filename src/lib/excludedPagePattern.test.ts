// src/lib/excludedPagePattern.test.ts
import { isValidExcludedPagePattern } from "./excludedPagePattern";

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
