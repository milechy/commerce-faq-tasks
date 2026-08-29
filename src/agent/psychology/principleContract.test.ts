// src/agent/psychology/principleContract.test.ts
// 心理学ナレッジ経路の「生産者と消費者が別のリテラルを持つ」継ぎ目バグの機械ガード
// (.claude/rules/knowledge.md「生産者と消費者が別のリテラルを持たない」参照)。
//
// 2026-08-29 発覚した3件の継ぎ目バグ:
//   1. principleDetector.ts の語彙(KEYWORD_MAP) と bookStructurizerPrompt.md の
//      few-shot例が出力する principle 値が独立に揺れていた(「返報性」vs「返報性の原理」)。
//      → 検索(principleSearch.ts)は完全一致のため永久にヒットしない。
//   2. bookStructurizer.ts が metadata に書くキーは
//      situation/contraindication/failure_example の3つだが、principleSearch.ts は
//      example も読む。example は書かれていない = 常に空文字。
//   3. bookStructurizer.ts は page_hint、bookPdfRoutes.ts の一覧取得は
//      page_number でソートしており、同じ値を指す別名で永久に結合しない。
//
// 各ファイルの単体テストはモックが「あるべき理想の行」を自作しており、
// 生産側が実際に何を書くかを見ていなかったため、この3件をどれも検出できなかった。
// このテストはモックを使わず、ソースファイルを直接走査して両側の語を突き合わせる。

import { readFileSync } from "fs";
import { join } from "path";
import { PRINCIPLE_NAMES, isKnownPrinciple } from "./principleVocabulary";
import { KEYWORD_MAP } from "./principleDetector";

const READ = (relPath: string): string =>
  readFileSync(join(__dirname, "..", "..", "..", relPath), "utf-8");

describe("principleDetector.ts の語彙は principleVocabulary.ts と完全一致する", () => {
  it("KEYWORD_MAP のキー集合が PRINCIPLE_NAMES と1対1で一致する", () => {
    // Record<PrincipleName, ...> によりコンパイル時にも強制されるが、
    // as any によるすり抜けを実行時にも検知できるよう二重で持つ。
    expect(Object.keys(KEYWORD_MAP).sort()).toEqual([...PRINCIPLE_NAMES].sort());
  });
});

describe("config/bookStructurizerPrompt.md の few-shot例は既知の原則名を使う", () => {
  it("few-shot出力の principle 値が PRINCIPLE_NAMES に含まれる(「返報性の原理」のような表記揺れを防ぐ)", () => {
    const prompt = READ("config/bookStructurizerPrompt.md");
    // "## few-shot例" 以降だけを見る("## 出力フォーマット" の "principle": "..." は
    // プレースホルダであって実際の原則名ではないため対象外にする。
    const fewShotSection = prompt.slice(prompt.indexOf("## few-shot例"));
    expect(fewShotSection.length).toBeGreaterThan(0);
    const matches = [...fewShotSection.matchAll(/"principle":\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(matches.length).toBeGreaterThan(0);
    for (const value of matches) {
      expect(isKnownPrinciple(value)).toBe(true);
    }
  });

  it("プロンプトが原則名の選択肢({{PRINCIPLE_LIST}})を差し込む形になっている(自由記述にしない)", () => {
    const prompt = READ("config/bookStructurizerPrompt.md");
    expect(prompt).toContain("{{PRINCIPLE_LIST}}");
  });
});

describe("bookStructurizer.ts が書く metadata は principleSearch.ts が読むキーを包含する", () => {
  it("faq_embeddings.metadata の書き込みキー集合に、principleSearch の SELECT対象キーが全て含まれる", () => {
    const producer = READ("src/agent/knowledge/bookStructurizer.ts");
    const consumer = READ("src/agent/psychology/principleSearch.ts");

    // 書き側: `const metadata = { ... };` ブロック内の識別子キーを抽出する
    const metadataBlockMatch = producer.match(/const metadata = \{([\s\S]*?)\};/);
    expect(metadataBlockMatch).not.toBeNull();
    const writtenKeys = [...metadataBlockMatch![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);

    // 読み側: `metadata->>'xxx'` で参照しているキーを抽出する
    const readKeys = [...consumer.matchAll(/metadata->>'(\w+)'/g)].map((m) => m[1]!);
    expect(readKeys.length).toBeGreaterThan(0);

    for (const key of readKeys) {
      expect(writtenKeys).toContain(key);
    }
  });
});

describe("bookStructurizer.ts と bookPdfRoutes.ts はページ情報のキー名が一致する", () => {
  it("bookStructurizer が metadata に書くページ情報キーが、一覧取得の ORDER BY と同じ名前である", () => {
    const producer = READ("src/agent/knowledge/bookStructurizer.ts");
    const consumer = READ("src/api/admin/knowledge/bookPdfRoutes.ts");

    const orderByMatch = consumer.match(/ORDER BY \(metadata->>'(\w+)'\)::int/);
    expect(orderByMatch).not.toBeNull();
    const sortKey = orderByMatch![1]!;

    const metadataBlockMatch = producer.match(/const metadata = \{([\s\S]*?)\};/);
    const writtenKeys = [...metadataBlockMatch![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);

    expect(writtenKeys).toContain(sortKey);
  });
});
