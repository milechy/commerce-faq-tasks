// tests/search/langEmbedding.test.ts
// Phase33 C: langEmbedding ユニットテスト

import { detectLangFromText, resolveFaqLang, MIGRATION_ADD_LANG_COLUMN } from "../../src/search/langEmbedding";

describe("detectLangFromText", () => {
  it("ひらがなを含むテキストを ja と判定する", () => {
    expect(detectLangFromText("返品したいのですが")).toBe("ja");
    expect(detectLangFromText("送料はいくらですか")).toBe("ja");
  });

  it("カタカナを含むテキストを ja と判定する", () => {
    expect(detectLangFromText("クレジットカードで払えますか")).toBe("ja");
    expect(detectLangFromText("サポートセンター")).toBe("ja");
  });

  it("CJK漢字のみのテキストを ja と判定する", () => {
    expect(detectLangFromText("返品送料")).toBe("ja");
    expect(detectLangFromText("注文確認")).toBe("ja");
  });

  it("英語テキストを en と判定する", () => {
    expect(detectLangFromText("How do I return an item?")).toBe("en");
    expect(detectLangFromText("shipping cost")).toBe("en");
  });

  it("空文字はデフォルト言語を返す", () => {
    expect(detectLangFromText("")).toBe("ja");
    expect(detectLangFromText("   ")).toBe("ja");
  });

  it("数字・記号のみは en と判定する", () => {
    expect(detectLangFromText("123 $@!")).toBe("en");
  });
});

describe("resolveFaqLang", () => {
  it("FAQ に lang フィールドがある場合はそれを優先する", () => {
    expect(resolveFaqLang({ lang: "en", text: "返品したい" })).toBe("en");
    expect(resolveFaqLang({ lang: "ja", text: "return policy" })).toBe("ja");
  });

  it("不正な lang フィールドはテキストから検出する", () => {
    expect(resolveFaqLang({ lang: "zh", text: "返品したい" })).toBe("ja");
    expect(resolveFaqLang({ lang: null as any, text: "return policy" })).toBe("en");
  });

  it("lang なし・text から自動検出する（日本語）", () => {
    expect(resolveFaqLang({ text: "返品したいのですが" })).toBe("ja");
  });

  it("lang なし・text から自動検出する（英語）", () => {
    expect(resolveFaqLang({ text: "How to return?" })).toBe("en");
  });

  it("question + answer の連結からも検出できる", () => {
    expect(resolveFaqLang({ question: "return policy?", answer: "You can return" })).toBe("en");
    expect(resolveFaqLang({ question: "返品ポリシー", answer: "返品できます" })).toBe("ja");
  });

  it("全フィールドが空の場合はデフォルト言語", () => {
    expect(resolveFaqLang({})).toBe("ja");
  });
});

describe("MIGRATION_ADD_LANG_COLUMN", () => {
  it("ALTER TABLE 文を含む", () => {
    expect(MIGRATION_ADD_LANG_COLUMN).toContain("ALTER TABLE faq_embeddings");
    expect(MIGRATION_ADD_LANG_COLUMN).toContain("ADD COLUMN IF NOT EXISTS lang");
  });

  it("インデックス作成文を含む", () => {
    expect(MIGRATION_ADD_LANG_COLUMN).toContain("CREATE INDEX IF NOT EXISTS faq_embeddings_lang_idx");
  });
});
