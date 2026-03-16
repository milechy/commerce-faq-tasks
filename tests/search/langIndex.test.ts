// tests/search/langIndex.test.ts
// Phase33 C: langIndex ユニットテスト

import {
  resolveEsIndex,
  resolveFallbackIndices,
  isSupportedLang,
  toSupportedLang,
  DEFAULT_LANG,
} from "../../src/search/langIndex";

describe("langIndex", () => {
  describe("resolveEsIndex", () => {
    it("テナントID + lang からインデックス名を生成する", () => {
      expect(resolveEsIndex("tenant1", "ja")).toBe("faq_tenant1_ja");
      expect(resolveEsIndex("tenant1", "en")).toBe("faq_tenant1_en");
    });

    it("特殊文字を含むテナントIDも連結する", () => {
      expect(resolveEsIndex("my-tenant", "ja")).toBe("faq_my-tenant_ja");
    });
  });

  describe("resolveFallbackIndices", () => {
    it("言語別インデックスを先頭に、旧形式を2番目に返す", () => {
      const indices = resolveFallbackIndices("demo", "ja");
      expect(indices).toEqual(["faq_demo_ja", "faq_demo"]);
    });

    it("en の場合も同様のパターンを返す", () => {
      const indices = resolveFallbackIndices("demo", "en");
      expect(indices).toEqual(["faq_demo_en", "faq_demo"]);
    });
  });

  describe("isSupportedLang", () => {
    it("ja と en を SupportedLang として認識する", () => {
      expect(isSupportedLang("ja")).toBe(true);
      expect(isSupportedLang("en")).toBe(true);
    });

    it("未サポートの値は false を返す", () => {
      expect(isSupportedLang("zh")).toBe(false);
      expect(isSupportedLang(null)).toBe(false);
      expect(isSupportedLang(undefined)).toBe(false);
      expect(isSupportedLang(1)).toBe(false);
      expect(isSupportedLang("")).toBe(false);
    });
  });

  describe("toSupportedLang", () => {
    it("有効な値はそのまま返す", () => {
      expect(toSupportedLang("ja")).toBe("ja");
      expect(toSupportedLang("en")).toBe("en");
    });

    it("不正な値は DEFAULT_LANG を返す", () => {
      expect(toSupportedLang("zh")).toBe(DEFAULT_LANG);
      expect(toSupportedLang(null)).toBe(DEFAULT_LANG);
      expect(toSupportedLang(undefined)).toBe(DEFAULT_LANG);
      expect(toSupportedLang("")).toBe(DEFAULT_LANG);
    });

    it("DEFAULT_LANG は ja である", () => {
      expect(DEFAULT_LANG).toBe("ja");
    });
  });
});
