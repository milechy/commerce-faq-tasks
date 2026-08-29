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

// 2026-08-29 レビュー是正: usage_count に注入専用行(通常RAGに乗らない分)が
// 混入し、「検索でヒットした回数」という既存の意味が壊れていた(過去データと
// 比較不能になる制約違反)。1ビットでは「検索ヒットのみ/注入のみ/両方」の
// 3状態を表せないため、retrieved(通常RAGヒット)と injected(注入)を直交する
// 2つのフラグに分けた。usage_count は retrieved のみを数える。
describe("通常RAGヒットの記録(retrieved)は生産者(searchAgent.ts)と消費者(summaryQueries.ts)でキー名が一致する", () => {
  it("RagSource 型(types.ts)に retrieved フィールドが定義されている", () => {
    const typesSrc = READ("src/agent/types.ts");
    const ragSourceMatch = typesSrc.match(/export interface RagSource \{([\s\S]*?)\n\}/);
    expect(ragSourceMatch).not.toBeNull();
    expect(ragSourceMatch![1]).toMatch(/retrieved\?:\s*boolean/);
  });

  it("searchAgent.ts は rerankResult.items 由来の行に retrieved: true、注入専用行に retrieved: false を明示する", () => {
    const producer = READ("src/agent/flow/searchAgent.ts");
    // rerankResult.items.map(...) が組み立てる行: retrieved: true を持つ
    const mapBlockMatch = producer.match(
      /const ragSources: RagSource\[\] = rerankResult\.items\.map\(\(it\) => \{[\s\S]*?\n  \}\);/,
    );
    expect(mapBlockMatch).not.toBeNull();
    expect(mapBlockMatch![0]).toMatch(/retrieved:\s*true/);

    // 通常RAGに乗らなかった注入専用の push 行: retrieved: false を明示する。
    // キーを省略すると summaryQueries.ts の COALESCE(retrieved, true) が
    // retrieved 未導入時代の旧行(NULL=true扱いが正しい)と区別できなくなる。
    const pushBlockMatch = producer.match(/ragSources\.push\(\{[\s\S]*?\}\);/);
    expect(pushBlockMatch).not.toBeNull();
    expect(pushBlockMatch![0]).toMatch(/retrieved:\s*false/);
  });

  it("summaryQueries.ts が同じ 'retrieved' キーで rag_sources から読み、usage_count の集計対象を絞る", () => {
    const consumer = READ("src/api/admin/analytics/summaryQueries.ts");
    // 生産側と同じ JSONB キー名('retrieved')を読んでいること
    expect(consumer).toContain(`(src->>'retrieved')::boolean AS retrieved`);
    // usage_count は retrieved のみを数える(injected 専用行を混入させない)
    expect(consumer).toMatch(/COUNT\(\*\) FILTER \(WHERE COALESCE\(retrieved, true\)\)::int AS usage_count/);
  });

  it("旧形式の行(retrieved キーを持たない)は COALESCE で true 扱いになる(後方互換)", () => {
    // retrieved 導入前に書かれた rag_sources 行は当時すべて検索ヒットだったため、
    // NULL を true として扱わないと過去の usage_count が変わってしまう。
    const consumer = READ("src/api/admin/analytics/summaryQueries.ts");
    expect(consumer).toMatch(/COALESCE\(retrieved, true\)/);
  });
});

// 2026-08-29 テスト強化: chunkId の型不一致による継ぎ目バグ。
// faq_embeddings.id は BIGSERIAL(int8)。node-postgres は既定で OID 20(int8)を
// 精度落ち防止のため文字列で返し、このリポジトリに setTypeParser(20, ...) による
// グローバル上書きは無い(src/lib/db.ts参照)。生産者(searchAgent.ts)は
// principleChunkIds.has(Number(it.id)) で「principleSearch.ts が返す chunkId は
// 数値の集合である」ことを前提に突き合わせているため、消費側(principleSearch.ts)が
// row.id を Number() で正規化せずそのまま chunkId に詰めていると、実行時に文字列
// (bigintのpg既定挙動)のままになり比較が一致しなくなる — 同じチャンクが通常RAGで
// ヒットしても injected フラグが静かに立たなくなる(ランタイム再現は
// principleSearch.test.ts「id 列が文字列(pgのbigint既定パーサ挙動)で返っても chunkId は
// number になる」参照)。
describe("principleSearch.ts が返す chunkId は searchAgent.ts の Number(it.id) 比較と型が一致する", () => {
  it("searchAgent.ts は principleChunkIds を Number(it.id) で突き合わせている(数値の集合である前提)", () => {
    const consumer = READ("src/agent/flow/searchAgent.ts");
    expect(consumer).toMatch(/principleChunkIds\.has\(Number\(it\.id\)\)/);
  });

  it("principleSearch.ts は faq_embeddings.id(BIGSERIAL/int8)を Number() で正規化してから chunkId として返す", () => {
    const producer = READ("src/agent/psychology/principleSearch.ts");
    const mapBlock = producer.slice(producer.indexOf("return result.rows.map"));
    expect(mapBlock).toMatch(/chunkId:\s*Number\(row\.id\)/);
  });
});
