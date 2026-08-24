// src/search/pgvectorSearchVisibility.test.ts
// 実回答経路(searchAgent → pgvectorSearch)が faq_docs の可視性判定を通ることの静的検証。
//
// 2026-08-24 発見: faq_embeddings を引く経路が2つあり、
//   searchTool → pgvector.ts        … is_published を見ていた
//   searchAgent → pgvectorSearch.ts … 見ていなかった(=実回答経路)
// そのため「非公開にしたFAQが答えに出る」状態だった。
// 本番SQLはPostgres側で評価されるため、SQL文字列に必要句が入ることで確認する
// (excludedIds.test.ts / globalRag.test.ts と同じ流儀)。

import fs from "node:fs";
import path from "node:path";
import { FAQ_VISIBILITY_JOIN, FAQ_VISIBILITY_WHERE } from "./pgvector";

const source = fs.readFileSync(path.resolve(__dirname, "pgvectorSearch.ts"), "utf8");

describe("pgvectorSearch.ts の可視性判定", () => {
  it("共有の述語を pgvector.ts から import している(第2の実装を書かない)", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*FAQ_VISIBILITY_JOIN[^}]*FAQ_VISIBILITY_WHERE[^}]*\}\s*from\s*"\.\/pgvector"/s,
    );
  });

  it("SQL に JOIN と可視性 WHERE を両方埋めている", () => {
    expect(source).toContain("${FAQ_VISIBILITY_JOIN}");
    expect(source).toContain("${FAQ_VISIBILITY_WHERE}");
  });

  it("述語自体が is_published = true を要求する", () => {
    expect(FAQ_VISIBILITY_WHERE).toMatch(/fd\.is_published\s*=\s*true/);
    expect(FAQ_VISIBILITY_WHERE).toMatch(/fd\.is_excluded_from_search/);
  });

  it("非FAQ(book/web等・faq_id を持たない)は faq_docs を見ずに通す", () => {
    expect(FAQ_VISIBILITY_WHERE).toMatch(/fe\.metadata->>'faq_id'\s+IS\s+NULL/);
    expect(FAQ_VISIBILITY_WHERE).toMatch(/fe\.metadata->>'faq_id'\s+!~\s+'\^\[0-9\]\+\$'/);
  });

  it("JOIN に numeric guard があり、非数値 faq_id で bigint キャストが落ちない", () => {
    expect(FAQ_VISIBILITY_JOIN).toMatch(/fe\.metadata->>'faq_id'\s*~\s*'\^\[0-9\]\+\$'/);
  });

  it("エイリアスが fe / fd に揃っている(述語の前提)", () => {
    expect(source).toMatch(/FROM faq_embeddings fe/);
    // 無修飾の列参照が残っていると faq_docs と ambiguous になりSQLが落ちる
    expect(source).not.toMatch(/WHERE \(tenant_id =/);
    expect(source).not.toMatch(/ORDER BY embedding </);
  });

  it("グローバル知識の合流は維持されている", () => {
    expect(source).toContain("OR fe.tenant_id = 'global'");
    expect(source).toContain("OR fe.tenant_id = 'r2c_docs'");
  });
});
