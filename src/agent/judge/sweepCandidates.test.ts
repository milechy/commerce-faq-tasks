// src/agent/judge/sweepCandidates.test.ts
// GID 1216970103691946 (PR-12): buildSweepCandidatesQuery のSQL/パラメータ検証。
// 実行はしない(純関数)。実データに対する疎通はG2確定後にintegrationで見る。

import { buildSweepCandidatesQuery } from "./sweepCandidates";

describe("buildSweepCandidatesQuery", () => {
  it("既定値でSQL/パラメータを組み立てる(離脱30分・上限7日・最低4通・limit20)", () => {
    const { params } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"] });

    expect(params).toEqual([["r2c_default"], "30 minutes", "7 days", 4, 20]);
  });

  it("tenant_id = ANY($1) でテナント許可リストに絞り込む(段階開放)", () => {
    const { sql } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"] });
    expect(sql).toContain("s.tenant_id = ANY($1)");
  });

  it("tenantIdsが空配列でも例外を投げずクエリを返す(呼び出し元は空配列で0件になることを期待できる)", () => {
    const { sql, params } = buildSweepCandidatesQuery({ tenantIds: [] });
    expect(sql).toContain("s.tenant_id = ANY($1)");
    expect(params[0]).toEqual([]);
  });

  it("conversation_evaluations への NOT EXISTS で冪等性を担保する", () => {
    const { sql } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"] });
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("FROM conversation_evaluations ce");
    expect(sql).toContain("ce.tenant_id = s.tenant_id AND ce.session_id = s.session_id");
  });

  it("is_escalated = false で有人対応中のセッションを除外する", () => {
    const { sql } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"] });
    expect(sql).toContain("s.is_escalated = false");
  });

  it("userSourceClauseを再利用してe2e/未タグ付けを除外する(判定文字列を書き直さない)", () => {
    const { sql } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"] });
    expect(sql).toContain("s.metadata->>'source' = 'user'");
  });

  it("last_message_at ASC で古いセッションから処理する(starvation防止)", () => {
    const { sql } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"] });
    expect(sql).toContain("ORDER BY s.last_message_at ASC");
  });

  it("上限(maxAgeInterval)より古いセッションはバックログに含めない条件を持つ", () => {
    const { sql, params } = buildSweepCandidatesQuery({ tenantIds: ["r2c_default"], maxAgeInterval: "3 days" });
    expect(sql).toContain("s.last_message_at >= NOW() - $3::interval");
    expect(params[2]).toBe("3 days");
  });

  it("オプションで離脱間隔・上限件数・最低通数・limitを上書きできる", () => {
    const { params } = buildSweepCandidatesQuery({
      tenantIds: ["r2c_default", "carnation"],
      idleInterval: "1 hour",
      maxAgeInterval: "14 days",
      minMessageCount: 6,
      limit: 5,
    });
    expect(params).toEqual([["r2c_default", "carnation"], "1 hour", "14 days", 6, 5]);
  });
});
