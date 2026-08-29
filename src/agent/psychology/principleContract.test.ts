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
import { PRINCIPLE_SCHEMA_MAPPINGS, PRINCIPLE_FIELDS } from "./principleSchemaMap";
import { KNOWN_SCHEMAS } from "../../lib/book-pipeline/contentAnalyzer";

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
  // 2026-08-29: principleSearch.ts はキー名を SQL に直書きせず
  // principleSchemaMap.ts の対応表から生成するようになったため、
  // 突き合わせ先を「ソース中の metadata->>'xxx' リテラル」から対応表に変更した。
  // 経路2(bookStructurizer.ts)が書くのは psychology_book スキーマのみなので、
  // 突き合わせ対象もそのマッピングに限定する。
  it("faq_embeddings.metadata の書き込みキー集合に、psychology_book マッピングの参照キーが全て含まれる", () => {
    const producer = READ("src/agent/knowledge/bookStructurizer.ts");

    // 書き側: `const metadata = { ... };` ブロック内の識別子キーを抽出する
    const metadataBlockMatch = producer.match(/const metadata = \{([\s\S]*?)\};/);
    expect(metadataBlockMatch).not.toBeNull();
    const writtenKeys = [...metadataBlockMatch![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);

    const mapping = PRINCIPLE_SCHEMA_MAPPINGS.find((m) => m.contentType === "psychology_book");
    expect(mapping).toBeDefined();
    const readKeys = PRINCIPLE_FIELDS.map((f) => mapping![f]).filter(
      (k): k is string => k !== null,
    );
    expect(readKeys.length).toBeGreaterThan(0);

    for (const key of readKeys) {
      expect(writtenKeys).toContain(key);
    }
  });

  it("principleSearch.ts はキー名を SQL に直書きしない(対応表から生成する)", () => {
    // 直書きに戻すと、sales_manual 等の別スキーマで取り込まれた書籍が
    // 再び原則注入から丸ごと外れる(本番 book_id=6 の81件が該当していた)。
    const consumer = READ("src/agent/psychology/principleSearch.ts");
    const sqlBlock = consumer.slice(consumer.indexOf("pool.query<RawRow>"));
    expect(sqlBlock).not.toMatch(/metadata->>'(principle|situation|example|contraindication)'/);
    expect(consumer).toContain("buildFieldSelect");
    expect(consumer).toContain("buildPrincipleWhereClause");
  });
});

describe("principleSchemaMap.ts の対応表は contentAnalyzer.ts の KNOWN_SCHEMAS と整合する", () => {
  it("各マッピングの contentType が KNOWN_SCHEMAS に実在する", () => {
    for (const mapping of PRINCIPLE_SCHEMA_MAPPINGS) {
      expect(Object.keys(KNOWN_SCHEMAS)).toContain(mapping.contentType);
    }
  });

  it("各マッピングが参照するキーが、そのスキーマのフィールドとして実在する", () => {
    // 継ぎ目バグの本体: 存在しないキーを指すと、そのスキーマの書籍は
    // 「対象になっているのに全フィールドが空」という無言の壊れ方をする。
    for (const mapping of PRINCIPLE_SCHEMA_MAPPINGS) {
      const schemaKeys = (KNOWN_SCHEMAS[mapping.contentType] ?? []).map((f) => f.key);
      expect(schemaKeys.length).toBeGreaterThan(0);
      for (const field of PRINCIPLE_FIELDS) {
        const key = mapping[field];
        if (key === null) continue;
        expect(schemaKeys).toContain(key);
      }
    }
  });

  it("打ち手フィールド(principle)は null にできない", () => {
    // principle が無いスキーマは原則注入の対象にしてはいけない
    // (product_catalog / business_document / general_report が該当)。
    for (const mapping of PRINCIPLE_SCHEMA_MAPPINGS) {
      expect(typeof mapping.principle).toBe("string");
      expect(mapping.principle.length).toBeGreaterThan(0);
    }
  });
});

describe("bookStructurizer.ts が書く metadata は bookPdfRoutes.ts の構造化フィールドを包含する", () => {
  it("STRUCTURED_FIELDS(チャンク編集UIが扱う6フィールド)が全て metadata に書かれている", () => {
    const producer = READ("src/agent/knowledge/bookStructurizer.ts");
    const consumer = READ("src/api/admin/knowledge/bookPdfRoutes.ts");

    // 消費側: `const STRUCTURED_FIELDS = [...] as const;` の要素を抽出
    const fieldsBlockMatch = consumer.match(/const STRUCTURED_FIELDS = \[([\s\S]*?)\] as const;/);
    expect(fieldsBlockMatch).not.toBeNull();
    const expectedFields = [...fieldsBlockMatch![1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    expect(expectedFields.length).toBeGreaterThan(0);

    const metadataBlockMatch = producer.match(/const metadata = \{([\s\S]*?)\};/);
    const writtenKeys = [...metadataBlockMatch![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);

    for (const field of expectedFields) {
      expect(writtenKeys).toContain(field);
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

// T3(Asana LB-1): 原則注入を rag_sources に記録し、貢献度集計で注入軸を分ける。
// 生産者(searchAgent.ts が rag_sources に書く injected フラグ)と消費者
// (summaryQueries.ts が rag_sources から読む injected フラグ)が別のキー名を
// 独立に持つと、注入は起きているのに貢献度画面には一生出ない継ぎ目バグになる
// (この種のバグは単体テストのモックでは検出できない。冒頭の説明参照)。
describe("原則注入の記録(injected)は生産者(searchAgent.ts)と消費者(summaryQueries.ts)でキー名が一致する", () => {
  it("RagSource 型(types.ts)に injected フィールドが定義されている", () => {
    const typesSrc = READ("src/agent/types.ts");
    const ragSourceMatch = typesSrc.match(/export interface RagSource \{([\s\S]*?)\n\}/);
    expect(ragSourceMatch).not.toBeNull();
    expect(ragSourceMatch![1]).toMatch(/injected\?:\s*boolean/);
  });

  it("searchAgent.ts が RagSource に 'injected' キーで注入フラグを書く", () => {
    const producer = READ("src/agent/flow/searchAgent.ts");
    // 通常RAGとも重複ヒットした分: 既存の行に注入フラグだけを立てる(行を2つにしない)
    expect(producer).toMatch(/source\.injected\s*=\s*true/);
    // 通常RAGに乗らなかった注入分: 新規の行として追加する
    expect(producer).toMatch(/ragSources\.push\(\{[\s\S]*?injected:\s*true[\s\S]*?\}\)/);
  });

  it("summaryQueries.ts が同じ 'injected' キーで rag_sources から読み、usage_count とは別列に集計する", () => {
    const consumer = READ("src/api/admin/analytics/summaryQueries.ts");
    // 生産側と同じ JSONB キー名('injected')を読んでいること
    expect(consumer).toContain(`(src->>'injected')::boolean AS injected`);
    // 既存 usage_count の意味(検索でヒットした回数)を変えず、注入回数は別列で持つ
    expect(consumer).toMatch(/COUNT\(\*\) FILTER \(WHERE injected\)::int AS injected_count/);
    expect(consumer).toContain("injected_count: row.injected_count");
  });
});
