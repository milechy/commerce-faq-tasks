// src/api/admin/evaluations/evaluationsRepository.stats.test.ts
// getDetailedStats() が JSONB カラムに unnest() を使って常時500になっていた不具合の回帰テスト。
//
// used_principles / effective_principles は JSONB(migration_conversation_evaluations.sql)。
// unnest() は配列型専用で、PostgreSQL は `function unnest(jsonb) does not exist` で失敗する。
// そのため GET /v1/admin/evaluations/stats(テナント詳細「AI改善レポート」タブ)が
// 常に500を返していた。実行されるSQLそのものを検査して再発を止める。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { getDetailedStats } from "./evaluationsRepository";

/** 呼ばれた全SQLを1本の文字列に連結する（何本目かに依存せず検査するため） */
function allSql(): string {
  return mockQuery.mock.calls.map((c) => String(c[0])).join("\n---\n");
}

beforeEach(() => {
  mockQuery.mockReset();
  // getDetailedStats は複数クエリを順に投げる。どれも空結果で構わない。
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("getDetailedStats", () => {
  it("JSONBカラムに unnest() を使わない（使うと本番で必ず500になる）", async () => {
    await getDetailedStats("carnation", 7);

    const sql = allSql();
    expect(sql).not.toMatch(/unnest\s*\(\s*used_principles\s*\)/);
    expect(sql).not.toMatch(/unnest\s*\(\s*effective_principles\s*\)/);
  });

  it("JSONB用の jsonb_array_elements_text で展開する", async () => {
    await getDetailedStats("carnation", 7);

    const sql = allSql();
    expect(sql).toMatch(/jsonb_array_elements_text\s*\(\s*used_principles\s*\)/);
    expect(sql).toMatch(/jsonb_array_elements_text\s*\(\s*effective_principles\s*\)/);
  });

  it("tenantId 指定時は全クエリが tenant_id で絞られる（テナント越境しない）", async () => {
    await getDetailedStats("carnation", 7);

    // principle 集計を含む全クエリに tenant_id 条件が入っていること
    const principleQueries = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("jsonb_array_elements_text"));
    expect(principleQueries.length).toBe(2);
    for (const q of principleQueries) {
      expect(q).toMatch(/tenant_id\s*=\s*\$\d/);
    }
    for (const c of mockQuery.mock.calls) {
      expect(c[1]).toContain("carnation");
    }
  });

  it("tenantId 未指定(super_adminの横断ビュー)でも例外にならない", async () => {
    await expect(getDetailedStats(undefined, 30)).resolves.toBeDefined();
    expect(allSql()).toMatch(/jsonb_array_elements_text/);
  });

  it("結果が0件でも例外にならず、空の principle_stats を返す", async () => {
    const stats = await getDetailedStats("carnation", 7);
    expect(stats.principle_stats).toEqual({});
  });

  it("DBが例外を投げた場合はそのまま伝播する（呼び出し元が500へ変換する既存挙動を維持）", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(getDetailedStats("carnation", 7)).rejects.toThrow();
  });
});
