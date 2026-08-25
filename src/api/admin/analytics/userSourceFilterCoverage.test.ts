// src/api/admin/analytics/userSourceFilterCoverage.test.ts
// GID 1217810341674380: 構造的対策(C) — userSourceExists()/userSourceClause() の
// 「呼び忘れ」を検知する静的スイープ。
//
// 背景: 今日一日で同じ欠陥(集計クエリに source='user' 絞り込みが無い/結合列を
// 間違える)が7回発生した(#863→#954→#958→#962→#963→#964→本タスク)。
// userSourceExistsForTable() は「間違った結合列を渡す」失敗モードを構造的に
// 塞ぐが、「そもそも呼び忘れる」失敗モードは塞げない。このテストはそれを
// 静的にスイープして検知する最後の砦。
//
// 手法: 各対象ファイルのソースをテキストとして読み、SELECT を含む
// テンプレートリテラルSQLブロックを抽出する。ブロックが既知テーブル
// (chat_sessions/conversation_evaluations/conversion_attributions/
// knowledge_gaps/chat_messages)を FROM/JOIN しており、かつ集計関数
// (COUNT/AVG/SUM/GROUP BY/unnest等)を伴う「KPI集計クエリ」である場合のみ、
// userSourceExists()/userSourceClause()/userSourceExistsForTable() のいずれか
// (またはインライン展開後の "metadata->>'source'")を含むことを要求する。
//
// 集計を伴わない単発ルックアップ(例: session_idプレフィックス検索で
// 該当セッションを1件引く actionExecutor.ts の候補検索)は対象外
// (実ユーザー/テストのどちらのセッションでも運用者が中身を見に行くのが
// 正しい挙動であり、source='user' で絞ると管理者がテストセッションの
// 中身を調べられなくなってしまう)。
//
// 実際にこのスイープを書く過程で、summaryQueries.ts の
// cv_days_since_first_session 計算(cs_min サブクエリ)に絞り込み漏れが
// 見つかり、本タスクで修正済み(8件目の発生)。

import fs from "fs";
import path from "path";

const TARGET_FILES = [
  "src/api/admin/analytics/summaryQueries.ts",
  "src/lib/crossTenantContext.ts",
  "src/api/conversion/autoTuning.ts",
  "src/api/admin/agent/actionExecutor.ts",
  "src/api/admin/tenants/analyticsSummaryRoutes.ts",
];

const KNOWN_TABLES = [
  "conversation_evaluations",
  "conversion_attributions",
  "knowledge_gaps",
  "chat_messages",
  "chat_sessions",
];

const FILTER_MARKERS = [
  "userSourceExists(",
  "userSourceClause(",
  "userSourceExistsForTable(",
  "metadata->>'source'",
];

const AGGREGATE_MARKERS: RegExp[] = [
  /\bCOUNT\s*\(/i,
  /\bAVG\s*\(/i,
  /\bSUM\s*\(/i,
  /\bGROUP BY\b/i,
  /\bpercentile_cont\b/i,
  /\bunnest\s*\(/i,
];

const REPO_ROOT = path.resolve(__dirname, "../../../../");

function extractSqlBlocks(source: string): Array<{ block: string; line: number }> {
  const results: Array<{ block: string; line: number }> = [];
  const re = /`([^`]*?SELECT[^`]*?)`/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const line = source.slice(0, m.index).split("\n").length;
    results.push({ block: m[1], line });
  }
  return results;
}

function referencesKnownTable(block: string): boolean {
  return KNOWN_TABLES.some((t) =>
    new RegExp(`\\bFROM\\s+${t}\\b|\\bJOIN\\s+${t}\\b`, "i").test(block),
  );
}

function isAggregateQuery(block: string): boolean {
  return AGGREGATE_MARKERS.some((r) => r.test(block));
}

function hasSourceFilter(block: string): boolean {
  return FILTER_MARKERS.some((marker) => block.includes(marker));
}

describe("userSourceExists/userSourceClause 呼び忘れの静的スイープ", () => {
  for (const relPath of TARGET_FILES) {
    it(`${relPath}: 既知テーブルへの集計クエリは全て source='user' フィルタを持つ`, () => {
      const absPath = path.join(REPO_ROOT, relPath);
      const source = fs.readFileSync(absPath, "utf8");
      const blocks = extractSqlBlocks(source);

      // ファイル自体に SELECT ブロックが1つも無い(将来リファクタで空になった等)は
      // スイープの前提が壊れているサインなので、明示的に落とす。
      expect(blocks.length).toBeGreaterThan(0);

      const violations = blocks
        .filter((b) => referencesKnownTable(b.block) && isAggregateQuery(b.block))
        .filter((b) => !hasSourceFilter(b.block));

      if (violations.length > 0) {
        const detail = violations
          .map((v) => `  L${v.line}: ${v.block.slice(0, 160).replace(/\s+/g, " ")}`)
          .join("\n");
        throw new Error(
          `${relPath} に source='user' フィルタの無い集計クエリが見つかりました:\n${detail}`,
        );
      }
    });
  }

  it("スイープ対象の全ファイルが実在する(パスのtypoでスイープが空振りしていないことの保証)", () => {
    for (const relPath of TARGET_FILES) {
      const absPath = path.join(REPO_ROOT, relPath);
      expect(fs.existsSync(absPath)).toBe(true);
    }
  });

  it("ミューテーションテスト: cs_min サブクエリから source='user' フィルタを外すとスイープが検知する", () => {
    const relPath = "src/api/admin/analytics/summaryQueries.ts";
    const absPath = path.join(REPO_ROOT, relPath);
    const source = fs.readFileSync(absPath, "utf8");

    // 本タスクで実際に修正した箇所を意図的に壊し、スイープが落ちることを確認する
    // (「テストが通るだけ」ではなく「壊れたら本当に検知するか」を検証する)。
    const mutated = source.replace(
      /(SELECT cs\.tenant_id, MIN\(cs\.started_at\) AS first_session_at\s*\n\s*FROM chat_sessions cs\s*\n\s*WHERE cs\.tenant_id = t\.id\s*\n)\s*\$\{userSourceClause\("cs"\)\}/,
      "$1",
    );
    expect(mutated).not.toBe(source); // 置換が実際に効いたことの前提チェック

    const blocks = extractSqlBlocks(mutated);
    const violations = blocks
      .filter((b) => referencesKnownTable(b.block) && isAggregateQuery(b.block))
      .filter((b) => !hasSourceFilter(b.block));

    expect(violations.length).toBeGreaterThan(0);
  });
});
