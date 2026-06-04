// src/search/faqIndexUnify.test.ts
// Phase69-2-E: ES write path / read path の index 名統一の単体 + 統合テスト
//
// 背景: Phase33-c 起因で write path (旧: ES_FAQ_INDEX || "faqs") と
// read path (faq_${tenantId}) の index 名が不整合になり、ES への
// is_excluded_from_search 同期や upsert が検索 index に届いていなかった。
// 本テストは write/read/reindex が同一の `faq_${tenantId}` を参照することを保証する。

import { resolveFaqWriteIndex, resolveFallbackIndices } from "./langIndex";

// ---------------------------------------------------------------------------
// 単体: resolveFaqWriteIndex と read path の整合
// ---------------------------------------------------------------------------
describe("resolveFaqWriteIndex (Phase69-2-E)", () => {
  it("テナント別に faq_${tenantId} を返す", () => {
    expect(resolveFaqWriteIndex("demo")).toBe("faq_demo");
    expect(resolveFaqWriteIndex("carnation")).toBe("faq_carnation");
  });

  it("write index は read path のフォールバック index（旧形式）と一致する", () => {
    // hybrid.ts / langRouter.ts は resolveFallbackIndices を read path に使う。
    // その最終フォールバック（旧形式）が write 先と一致していなければ、
    // ES に書いた doc が検索でヒットしない。
    const tenantId = "demo";
    const writeIndex = resolveFaqWriteIndex(tenantId);
    const readFallbacks = resolveFallbackIndices(tenantId, "ja");
    expect(readFallbacks).toContain(writeIndex);
    // 旧形式（言語サフィックスなし）が write index と完全一致
    expect(readFallbacks[readFallbacks.length - 1]).toBe(writeIndex);
  });

  it("hybrid.ts の非言語パス index 表現 faq_${tenantId} と一致する", () => {
    // hybrid.ts は LANG_SEARCH 無効時に `faq_${tenantId ?? "demo"}` を使う。
    const tenantId = "t1";
    expect(resolveFaqWriteIndex(tenantId)).toBe(`faq_${tenantId}`);
  });

  it("環境変数 ES_FAQ_INDEX を参照しない（廃止済み）", () => {
    const orig = process.env.ES_FAQ_INDEX;
    process.env.ES_FAQ_INDEX = "should_be_ignored";
    try {
      expect(resolveFaqWriteIndex("demo")).toBe("faq_demo");
    } finally {
      if (orig !== undefined) process.env.ES_FAQ_INDEX = orig;
      else delete process.env.ES_FAQ_INDEX;
    }
  });
});
