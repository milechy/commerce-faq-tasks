// src/lib/crossTenantContext.test.ts
// PR-3 (GID 1216970103691946): クロステナント匿名集計にsource='user'絞り込みが
// 入っていることの検証(e2eセッションの評価・CV実績が全テナント統計に混入しないため)。

const mockQuery = jest.fn();
jest.mock("./db", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));
jest.mock("./logger", () => ({
  logger: { warn: jest.fn() },
}));

import { getCrossTenantContext, _clearCacheForTesting } from "./crossTenantContext";

beforeEach(() => {
  mockQuery.mockReset();
  _clearCacheForTesting();
  // fetchAvgScores / fetchTopPsychologyPrinciples / fetchCommonGapPatterns /
  // fetchEffectiveRulePatterns の4クエリすべてに安全に応答する汎用モック
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("getCrossTenantContext — source='user'フィルタ", () => {
  it("平均スコア集計(conversation_evaluations)にsource='user'絞り込みが入っている", async () => {
    await getCrossTenantContext();

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const avgScoreSql = allSql.find((sql) => /FROM conversation_evaluations/.test(sql));
    expect(avgScoreSql).toBeDefined();
    expect(avgScoreSql).toContain("metadata->>'source' = 'user'");
  });

  it("心理原則ランキング集計(conversion_attributions)にsource='user'絞り込みが入っている", async () => {
    await getCrossTenantContext();

    const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
    const principlesSql = allSql.find((sql) => /FROM conversion_attributions/.test(sql));
    expect(principlesSql).toBeDefined();
    expect(principlesSql).toContain("metadata->>'source' = 'user'");
  });
});
