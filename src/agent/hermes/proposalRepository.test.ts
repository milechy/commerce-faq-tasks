// src/agent/hermes/proposalRepository.test.ts
// Phase74: hermesProposalRepository テスト (fake pool 注入)

import { createHermesProposalRepository } from "./proposalRepository";

type QueryMock = jest.Mock<Promise<{ rows: unknown[] }>, [string, unknown[]?]>;

function makePool(queryMock: QueryMock) {
  return { query: queryMock } as unknown as Parameters<
    typeof createHermesProposalRepository
  >[0];
}

describe("insertProposal", () => {
  it("global提案: INSERT を発行し、挿入されたら true", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: "1" }] });
    const repo = createHermesProposalRepository(makePool(query));

    const inserted = await repo.insertProposal({
      scope: "global",
      proposalType: "xt_principle",
      title: "心理原則Xの全体採用を検討",
      rationale: "全テナント横断でCV率+12%(サンプル340件)",
      suggestedAction: "デフォルト戦略に心理原則Xを追加",
      evidence: { principle: "scarcity", conversionRate: 12, sampleSize: 340 },
      dedupKey: "xt_principle:scarcity",
    });

    expect(inserted).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO hermes_strategy_proposals");
    expect(sql).toContain("ON CONFLICT (dedup_key) WHERE status = 'pending' DO NOTHING");
    expect(args![0]).toBe("global");
    expect(args![1]).toBeNull(); // tenant_id は必ず null
  });

  it("tenant提案: tenant_idが引数に渡る", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: "2" }] });
    const repo = createHermesProposalRepository(makePool(query));

    await repo.insertProposal({
      scope: "tenant",
      tenantId: "carnation",
      proposalType: "ab_winner",
      title: "variant B を昇格検討",
      rationale: "A/BテストでCV率+7%(サンプル120件)",
      suggestedAction: "variant B を昇格",
      dedupKey: "tenant:carnation:ab:exp-1",
    });

    const [, args] = query.mock.calls[0]!;
    expect(args![0]).toBe("tenant");
    expect(args![1]).toBe("carnation");
  });

  it("scope='global' に tenantId を渡すと例外(越境ガード)", async () => {
    const query: QueryMock = jest.fn();
    const repo = createHermesProposalRepository(makePool(query));

    await expect(
      repo.insertProposal({
        scope: "global",
        tenantId: "carnation", // 不変条件違反
        proposalType: "xt_principle",
        title: "t",
        rationale: "r",
        suggestedAction: "a",
        dedupKey: "bad",
      }),
    ).rejects.toThrow(/scope='global' must not carry tenantId/);
    expect(query).not.toHaveBeenCalled();
  });

  it("scope='tenant' で tenantId 無しは例外", async () => {
    const query: QueryMock = jest.fn();
    const repo = createHermesProposalRepository(makePool(query));

    await expect(
      repo.insertProposal({
        scope: "tenant",
        proposalType: "ab_winner",
        title: "t",
        rationale: "r",
        suggestedAction: "a",
        dedupKey: "bad2",
      }),
    ).rejects.toThrow(/scope='tenant' requires tenantId/);
    expect(query).not.toHaveBeenCalled();
  });

  it("ON CONFLICT で行が返らなければ false (重複スキップ)", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    const inserted = await repo.insertProposal({
      scope: "global",
      proposalType: "xt_principle",
      title: "t",
      rationale: "r",
      suggestedAction: "a",
      dedupKey: "dup",
    });

    expect(inserted).toBe(false);
  });
});

describe("listProposals", () => {
  it("フィルタ無しでLIMIT付きSELECT", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    await repo.listProposals();

    const [sql, args] = query.mock.calls[0]!;
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(args![0]).toBe(100);
  });

  it("scope + status で絞り込み", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    await repo.listProposals({ scope: "global", status: "pending", limit: 20 });

    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("scope = $1");
    expect(sql).toContain("status = $2");
    expect(args).toEqual(["global", "pending", 20]);
  });

  it("tenantId で絞り込み(client_admin向けAPIが使用)", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    await repo.listProposals({ tenantId: "carnation" });

    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("tenant_id = $1");
    expect(args![0]).toBe("carnation");
  });

  it("DBの行をキャメルケースに変換する", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "1",
          scope: "global",
          tenant_id: null,
          proposal_type: "xt_principle",
          title: "t",
          rationale: "r",
          suggested_action: "a",
          evidence: { foo: "bar" },
          status: "pending",
          dedup_key: "k",
          created_at: new Date("2026-01-01T00:00:00Z"),
          decided_at: null,
          decided_by: null,
        },
      ],
    });
    const repo = createHermesProposalRepository(makePool(query));

    const [proposal] = await repo.listProposals();

    expect(proposal).toMatchObject({
      id: "1",
      scope: "global",
      tenantId: null,
      proposalType: "xt_principle",
      suggestedAction: "a",
      evidence: { foo: "bar" },
    });
  });
});

describe("findProposalIdByDedupKey", () => {
  it("dedup_keyから最新のIDを取得する", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: "42" }] });
    const repo = createHermesProposalRepository(makePool(query));

    const id = await repo.findProposalIdByDedupKey("xt_principle:scarcity");

    expect(id).toBe("42");
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("WHERE dedup_key = $1");
    expect(args).toEqual(["xt_principle:scarcity"]);
  });

  it("該当なしはnull", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    const id = await repo.findProposalIdByDedupKey("nonexistent");

    expect(id).toBeNull();
  });
});

describe("updateProposalStatus", () => {
  it("UPDATE を発行しdecided_by/decided_atを設定", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "1",
          scope: "tenant",
          tenant_id: "carnation",
          proposal_type: "ab_winner",
          title: "t",
          rationale: "r",
          suggested_action: "a",
          evidence: {},
          status: "approved",
          dedup_key: "k",
          created_at: new Date(),
          decided_at: new Date(),
          decided_by: "admin@example.com",
        },
      ],
    });
    const repo = createHermesProposalRepository(makePool(query));

    const result = await repo.updateProposalStatus("1", "approved", "admin@example.com");

    expect(result?.status).toBe("approved");
    expect(result?.decidedBy).toBe("admin@example.com");
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE hermes_strategy_proposals");
    expect(args).toEqual(["1", "approved", "admin@example.com"]);
  });

  it("該当行が無ければ null", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    const result = await repo.updateProposalStatus("999", "rejected", "admin@example.com");

    expect(result).toBeNull();
  });
});
