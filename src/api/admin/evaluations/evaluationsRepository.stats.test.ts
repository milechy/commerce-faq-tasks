// src/api/admin/evaluations/evaluationsRepository.stats.test.ts
// evaluationsRepository の「発行されるSQLそのもの」を固定する回帰テスト。
// 現在のカバー範囲: getDetailedStats（JSONB/unnest 回帰）、checkAlreadyEvaluated（tenant絞り込み）。
//
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

import { checkAlreadyEvaluated, getDetailedStats } from "./evaluationsRepository";

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

// ---------------------------------------------------------------------------
// checkAlreadyEvaluated — 存在確認オラクル防止の中核。
//
// POST /v1/admin/evaluations/trigger は所有権検証(evaluateSession)より前に
// この関数を呼ぶ。tenant_id で絞らないと「他テナントの評価済みセッション」に
// 409 already_evaluated が返り、session_id の総当たりで他テナントの有効な
// セッションIDを列挙できてしまう（CLAUDE.md 禁止事項20/21）。
//
// ルート層のテストはモック済みのこの関数に第2引数が渡るかしか見ていないため、
// 「渡された tenantId を SQL で実際に使うか」はここでしか固定できない。
// AND 句の削除・三項条件の反転・パラメータ順の取り違えを検出する。
// ---------------------------------------------------------------------------

describe("checkAlreadyEvaluated", () => {
  const SESSION_ID = "sess-001";
  const TENANT_ID = "carnation";

  it("expectedTenantId 指定時は tenant_id で絞り、パラメータを [sessionId, tenantId] の順で渡す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await checkAlreadyEvaluated(SESSION_ID, TENANT_ID);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/session_id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/),
      [SESSION_ID, TENANT_ID],
    );
  });

  it("expectedTenantId 未指定(super_admin)時は tenant_id 述語を含めない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await checkAlreadyEvaluated(SESSION_ID);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/tenant_id/);
    expect(params).toEqual([SESSION_ID]);
  });

  it("空文字の tenantId でも「未指定」に倒さず tenant_id で絞る（falsy 判定に退行させない）", async () => {
    // `expectedTenantId !== undefined` を `if (expectedTenantId)` のような
    // falsy 判定に変えると、空 tenantId の client_admin が全テナント横断で
    // 409 を引ける状態に戻る。
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await checkAlreadyEvaluated(SESSION_ID, "");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/tenant_id\s*=\s*\$2/),
      [SESSION_ID, ""],
    );
  });

  it("count が '0' なら false、1件以上なら true を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    await expect(checkAlreadyEvaluated(SESSION_ID, TENANT_ID)).resolves.toBe(false);

    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    await expect(checkAlreadyEvaluated(SESSION_ID, TENANT_ID)).resolves.toBe(true);

    mockQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] });
    await expect(checkAlreadyEvaluated(SESSION_ID, TENANT_ID)).resolves.toBe(true);
  });

  it("rows が空でも例外を投げず false を返す（未評価扱いに倒す）", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(checkAlreadyEvaluated(SESSION_ID, TENANT_ID)).resolves.toBe(false);
  });
});
