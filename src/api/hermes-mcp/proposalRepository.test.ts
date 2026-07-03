// src/api/hermes-mcp/proposalRepository.test.ts
// Phase74: hermesProposalRepository テスト (fake pool 注入)

import { createHermesProposalRepository } from "./proposalRepository";

type QueryMock = jest.Mock<Promise<{ rows: unknown[] }>, [string, unknown[]?]>;

function makePool(queryMock: QueryMock) {
  return { query: queryMock } as unknown as Parameters<
    typeof createHermesProposalRepository
  >[0];
}

describe("insertProposal", () => {
  it("global提案: INSERTを発行し、挿入されたらtrue", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: "1" }] });
    const repo = createHermesProposalRepository(makePool(query));

    const inserted = await repo.insertProposal({
      scope: "global",
      title: "心理原則「scarcity」の全体採用を検討",
      rationale: "複数の同意済みテナントの会話で共通するパターンを確認",
      suggestedAction: "デフォルト戦略に追加検討",
      evidence: { sessionIds: ["sess-1", "sess-2"] },
      dedupKey: "global:scarcity-pattern",
    });

    expect(inserted).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO hermes_strategy_proposals");
    expect(sql).toContain("ON CONFLICT (dedup_key) WHERE status = 'pending' DO NOTHING");
    expect(args![0]).toBe("global");
    expect(args![1]).toBeNull();
    expect(args![7]).toBe("hermes-agent"); // submitted_by既定値
  });

  it("tenant提案: tenant_idが引数に渡る", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: "2" }] });
    const repo = createHermesProposalRepository(makePool(query));

    await repo.insertProposal({
      scope: "tenant",
      tenantId: "carnation",
      title: "保証訴求の改善",
      rationale: "会話ログから保証質問への回答が購入に繋がるパターンを確認",
      suggestedAction: "保証訴求を初回応答に含める",
      dedupKey: "tenant:carnation:warranty-pitch",
    });

    const [, args] = query.mock.calls[0]!;
    expect(args![0]).toBe("tenant");
    expect(args![1]).toBe("carnation");
  });

  it("scope='global'にtenantIdを渡すと例外(越境ガード)", async () => {
    const query: QueryMock = jest.fn();
    const repo = createHermesProposalRepository(makePool(query));

    await expect(
      repo.insertProposal({
        scope: "global",
        tenantId: "carnation",
        title: "t",
        rationale: "r",
        suggestedAction: "a",
        dedupKey: "bad",
      }),
    ).rejects.toThrow(/scope='global' must not carry tenantId/);
    expect(query).not.toHaveBeenCalled();
  });

  it("scope='tenant'でtenantId無しは例外", async () => {
    const query: QueryMock = jest.fn();
    const repo = createHermesProposalRepository(makePool(query));

    await expect(
      repo.insertProposal({
        scope: "tenant",
        title: "t",
        rationale: "r",
        suggestedAction: "a",
        dedupKey: "bad2",
      }),
    ).rejects.toThrow(/scope='tenant' requires tenantId/);
    expect(query).not.toHaveBeenCalled();
  });

  it("ON CONFLICTで行が返らなければfalse(重複スキップ)", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    const inserted = await repo.insertProposal({
      scope: "global",
      title: "t",
      rationale: "r",
      suggestedAction: "a",
      dedupKey: "dup",
    });

    expect(inserted).toBe(false);
  });
});

describe("findProposalIdByDedupKey", () => {
  it("dedup_keyから最新のIDを取得する", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: "42" }] });
    const repo = createHermesProposalRepository(makePool(query));

    const id = await repo.findProposalIdByDedupKey("global:scarcity-pattern");

    expect(id).toBe("42");
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("WHERE dedup_key = $1");
    expect(args).toEqual(["global:scarcity-pattern"]);
  });

  it("該当なしはnull", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));
    expect(await repo.findProposalIdByDedupKey("nonexistent")).toBeNull();
  });
});

describe("getProposalById", () => {
  it("IDから提案を1件取得しキャメルケースに変換する", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "5",
          scope: "tenant",
          tenant_id: "carnation",
          title: "t",
          rationale: "r",
          suggested_action: "a",
          evidence: {},
          status: "pending",
          dedup_key: "k",
          submitted_by: "hermes-agent",
          created_at: new Date(),
          decided_at: null,
          decided_by: null,
        },
      ],
    });
    const repo = createHermesProposalRepository(makePool(query));

    const proposal = await repo.getProposalById("5");

    expect(proposal).toMatchObject({ id: "5", scope: "tenant", tenantId: "carnation" });
  });

  it("該当なしはnull", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));
    expect(await repo.getProposalById("999")).toBeNull();
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

  it("tenantIdで絞り込み(client_admin向けAPIが使用)", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    await repo.listProposals({ tenantId: "carnation" });

    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("tenant_id = $1");
    expect(args![0]).toBe("carnation");
  });
});

describe("updateProposalStatus", () => {
  it("UPDATEを発行しdecided_by/decided_atを設定", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "1",
          scope: "tenant",
          tenant_id: "carnation",
          title: "t",
          rationale: "r",
          suggested_action: "a",
          evidence: {},
          status: "approved",
          dedup_key: "k",
          submitted_by: "hermes-agent",
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

  it("該当行が無ければnull", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createHermesProposalRepository(makePool(query));

    expect(await repo.updateProposalStatus("999", "rejected", "admin@example.com")).toBeNull();
  });
});
