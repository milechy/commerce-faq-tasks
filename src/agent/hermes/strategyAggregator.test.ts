// src/agent/hermes/strategyAggregator.test.ts
// Phase74: strategyAggregator テスト (crossTenantContext / autoTuning / pool をモック)

import {
  collectGlobalProposalCandidates,
  collectTenantProposalCandidates,
  listActiveTenantIds,
  collectAllProposalCandidates,
} from "./strategyAggregator";
import { getCrossTenantContext } from "../../lib/crossTenantContext";
import {
  detectABWinners,
  detectRepeatedJudgeSuggestions,
  detectTopPrinciples,
} from "../../api/conversion/autoTuning";
import { pool } from "../../lib/db";

jest.mock("../../lib/crossTenantContext", () => ({
  getCrossTenantContext: jest.fn(),
}));

jest.mock("../../api/conversion/autoTuning", () => ({
  detectABWinners: jest.fn(),
  detectRepeatedJudgeSuggestions: jest.fn(),
  detectTopPrinciples: jest.fn(),
}));

jest.mock("../../lib/db", () => ({
  pool: { query: jest.fn() },
}));

const mockGetCrossTenantContext = getCrossTenantContext as jest.Mock;
const mockDetectABWinners = detectABWinners as jest.Mock;
const mockDetectRepeatedJudgeSuggestions = detectRepeatedJudgeSuggestions as jest.Mock;
const mockDetectTopPrinciples = detectTopPrinciples as jest.Mock;
const mockPoolQuery = pool!.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockDetectABWinners.mockResolvedValue([]);
  mockDetectRepeatedJudgeSuggestions.mockResolvedValue([]);
  mockDetectTopPrinciples.mockResolvedValue([]);
});

describe("collectGlobalProposalCandidates", () => {
  it("crossTenantContextの匿名集計から global 提案を生成し、tenantIdを持たない", async () => {
    mockGetCrossTenantContext.mockResolvedValue({
      avgScores: null,
      topPsychologyPrinciples: [
        { principle: "scarcity", conversionRate: 12, sampleSize: 340 },
        { principle: "social_proof", conversionRate: 9, sampleSize: 210 },
      ],
      commonGapPatterns: [],
      effectiveRulePatterns: [],
      totalTenants: 5,
      dataAsOf: "2026-07-01T00:00:00.000Z",
    });

    const candidates = await collectGlobalProposalCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      scope: "global",
      proposalType: "xt_principle",
      dedupKey: "xt_principle:scarcity",
      evidence: { principle: "scarcity", conversionRate: 12, sampleSize: 340 },
    });
    expect(candidates[0]!.tenantId).toBeUndefined();
  });

  it("上位3件までに絞る(通知過多防止)", async () => {
    mockGetCrossTenantContext.mockResolvedValue({
      avgScores: null,
      topPsychologyPrinciples: Array.from({ length: 10 }, (_, i) => ({
        principle: `p${i}`,
        conversionRate: 10 - i,
        sampleSize: 100,
      })),
      commonGapPatterns: [],
      effectiveRulePatterns: [],
      totalTenants: 5,
      dataAsOf: "2026-07-01T00:00:00.000Z",
    });

    const candidates = await collectGlobalProposalCandidates();

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.evidence.principle)).toEqual(["p0", "p1", "p2"]);
  });

  it("匿名集計が空なら空配列", async () => {
    mockGetCrossTenantContext.mockResolvedValue({
      avgScores: null,
      topPsychologyPrinciples: [],
      commonGapPatterns: [],
      effectiveRulePatterns: [],
      totalTenants: 0,
      dataAsOf: "2026-07-01T00:00:00.000Z",
    });

    const candidates = await collectGlobalProposalCandidates();
    expect(candidates).toEqual([]);
  });
});

describe("collectTenantProposalCandidates", () => {
  it("ab_winner候補を正規化し、scope='tenant'+tenantIdを持つ", async () => {
    mockDetectABWinners.mockResolvedValue([
      {
        type: "ab_winner",
        description: "A/Bテスト「価格訴求」でVariant Bが勝利",
        suggestedAction: "Variant Bを適用",
        data: { experimentId: "exp-1", rateA: 0.1, rateB: 0.18, winner: "B" },
      },
    ]);

    const candidates = await collectTenantProposalCandidates("carnation");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      scope: "tenant",
      tenantId: "carnation",
      proposalType: "ab_winner",
      dedupKey: "tenant:carnation:ab_winner:exp-1",
      suggestedAction: "Variant Bを適用",
    });
  });

  it("effectiveness_top候補のdedupKeyはprincipleベース", async () => {
    mockDetectTopPrinciples.mockResolvedValue([
      {
        type: "effectiveness_top",
        description: "「urgency」が8回のCVに貢献",
        suggestedAction: "「urgency」をチューニングルールで優先設定",
        data: { principle: "urgency", count: 8, avgTemp: 70 },
      },
    ]);

    const candidates = await collectTenantProposalCandidates("carnation");

    expect(candidates[0]!.dedupKey).toBe("tenant:carnation:effectiveness_top:urgency");
  });

  it("judge_repeated候補は自由記述のruleをslug化してdedupKeyにする", async () => {
    mockDetectRepeatedJudgeSuggestions.mockResolvedValue([
      {
        type: "judge_repeated",
        description: "AIが3回同じ提案をしています",
        suggestedAction: "在庫切れ時は代替商品を提案する",
        data: { count: 3, rule: "在庫切れ時は代替商品を提案する" },
      },
    ]);

    const candidates = await collectTenantProposalCandidates("carnation");

    expect(candidates[0]!.dedupKey).toMatch(/^tenant:carnation:judge_repeated:/);
    expect(candidates[0]!.dedupKey).not.toContain(" ");
  });

  it("3系統を並列で束ね、順不同で全件返す", async () => {
    mockDetectABWinners.mockResolvedValue([
      { type: "ab_winner", description: "d1", suggestedAction: "a1", data: { experimentId: "e1" } },
    ]);
    mockDetectRepeatedJudgeSuggestions.mockResolvedValue([
      { type: "judge_repeated", description: "d2", suggestedAction: "a2", data: { rule: "r2" } },
    ]);
    mockDetectTopPrinciples.mockResolvedValue([
      { type: "effectiveness_top", description: "d3", suggestedAction: "a3", data: { principle: "p3" } },
    ]);

    const candidates = await collectTenantProposalCandidates("carnation");
    expect(candidates).toHaveLength(3);
    expect(candidates.every((c) => c.tenantId === "carnation")).toBe(true);
  });
});

describe("listActiveTenantIds", () => {
  it("INTERVAL付きクエリを発行しtenant_idの配列を返す", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ tenant_id: "carnation" }, { tenant_id: "english-demo" }],
    });

    const ids = await listActiveTenantIds();

    expect(ids).toEqual(["carnation", "english-demo"]);
    const [sql, args] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("SELECT DISTINCT tenant_id FROM conversation_evaluations");
    expect(sql).toContain("INTERVAL");
    expect(args).toEqual([30]);
  });

  it("windowDaysを指定できる", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await listActiveTenantIds(7);
    const [, args] = mockPoolQuery.mock.calls[0]!;
    expect(args).toEqual([7]);
  });
});

describe("collectAllProposalCandidates", () => {
  it("明示的なtenantIdsを渡すとlistActiveTenantIdsを呼ばずglobal+tenant提案を合算する", async () => {
    mockGetCrossTenantContext.mockResolvedValue({
      avgScores: null,
      topPsychologyPrinciples: [{ principle: "scarcity", conversionRate: 12, sampleSize: 340 }],
      commonGapPatterns: [],
      effectiveRulePatterns: [],
      totalTenants: 5,
      dataAsOf: "2026-07-01T00:00:00.000Z",
    });
    mockDetectABWinners.mockResolvedValue([
      { type: "ab_winner", description: "d1", suggestedAction: "a1", data: { experimentId: "e1" } },
    ]);

    const candidates = await collectAllProposalCandidates(["carnation"]);

    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(candidates).toHaveLength(2);
    expect(candidates.filter((c) => c.scope === "global")).toHaveLength(1);
    expect(candidates.filter((c) => c.scope === "tenant")).toHaveLength(1);
  });

  it("tenantIds省略時はlistActiveTenantIds経由でDBから母集団を取得する", async () => {
    mockGetCrossTenantContext.mockResolvedValue({
      avgScores: null,
      topPsychologyPrinciples: [],
      commonGapPatterns: [],
      effectiveRulePatterns: [],
      totalTenants: 0,
      dataAsOf: "2026-07-01T00:00:00.000Z",
    });
    mockPoolQuery.mockResolvedValue({ rows: [{ tenant_id: "carnation" }] });

    await collectAllProposalCandidates();

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockDetectABWinners).toHaveBeenCalledWith("carnation");
  });
});
