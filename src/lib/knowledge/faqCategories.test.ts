// src/lib/knowledge/faqCategories.test.ts

import { FAQ_CATEGORIES, FAQ_CATEGORY_IDS, buildFaqCategoryPromptSection } from "./faqCategories";

describe("faqCategories", () => {
  it("FAQ_CATEGORIES は9件ある", () => {
    expect(FAQ_CATEGORIES).toHaveLength(9);
  });

  it("id が重複しない", () => {
    const ids = FAQ_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("各要素の id・label・criteria がすべて空でない", () => {
    for (const c of FAQ_CATEGORIES) {
      expect(c.id.trim()).not.toBe("");
      expect(c.label.trim()).not.toBe("");
      expect(c.criteria.trim()).not.toBe("");
    }
  });

  it("FAQ_CATEGORY_IDS は FAQ_CATEGORIES の id と同じ内容・順序", () => {
    expect(FAQ_CATEGORY_IDS).toEqual(FAQ_CATEGORIES.map((c) => c.id));
  });

  it("buildFaqCategoryPromptSection の出力に全idが含まれる", () => {
    const section = buildFaqCategoryPromptSection();
    for (const id of FAQ_CATEGORY_IDS) {
      expect(section).toContain(`"${id}"`);
    }
  });

  it("buildFaqCategoryPromptSection は `* {判定基準} → \"{id}\"` を改行で連結した形式", () => {
    const section = buildFaqCategoryPromptSection();
    const lines = section.split("\n");
    expect(lines).toHaveLength(FAQ_CATEGORIES.length);
    FAQ_CATEGORIES.forEach((c, i) => {
      expect(lines[i]).toBe(`* ${c.criteria} → "${c.id}"`);
    });
  });
});
