// src/agent/hermes/hermesAgent.test.ts
// Phase74: hermesAgent テスト (依存モジュールをモック、heartbeatHandler.test.ts と同型)

import {
  runHermesCycle,
  startHermes,
  stopHermes,
} from "./hermesAgent";
import { collectAllProposalCandidates, listActiveTenantIds } from "./strategyAggregator";
import { createHermesProposalRepository } from "./proposalRepository";
import { createNotification } from "../../lib/notifications";
import { sendSlackAlert } from "../../lib/alerts/slackNotifier";

jest.mock("./strategyAggregator", () => ({
  collectAllProposalCandidates: jest.fn(),
  listActiveTenantIds: jest.fn(),
}));

jest.mock("./proposalRepository", () => ({
  createHermesProposalRepository: jest.fn(),
}));

jest.mock("../../lib/notifications", () => ({
  createNotification: jest.fn(),
}));

jest.mock("../../lib/alerts/slackNotifier", () => ({
  sendSlackAlert: jest.fn(),
}));

const mockCollectAll = collectAllProposalCandidates as jest.Mock;
const mockListActive = listActiveTenantIds as jest.Mock;
const mockCreateRepo = createHermesProposalRepository as jest.Mock;
const mockCreateNotification = createNotification as jest.Mock;
const mockSendSlackAlert = sendSlackAlert as jest.Mock;

const mockInsertProposal = jest.fn();
const mockFindProposalIdByDedupKey = jest.fn();

const ENV_KEYS = [
  "HERMES_ENABLED",
  "HERMES_TENANTS",
  "HERMES_NOTIFY_ENABLED",
] as const;

const globalCandidate = {
  scope: "global" as const,
  proposalType: "xt_principle" as const,
  title: "心理原則「scarcity」の全体採用を検討",
  rationale: "全テナント横断でCV率12%(サンプル340件)",
  suggestedAction: "デフォルト戦略に追加検討",
  evidence: { principle: "scarcity", conversionRate: 12, sampleSize: 340 },
  dedupKey: "xt_principle:scarcity",
};

const tenantCandidate = {
  scope: "tenant" as const,
  tenantId: "carnation",
  proposalType: "ab_winner" as const,
  title: "A/Bテスト「価格訴求」でVariant Bが勝利",
  rationale: "CV率+7%",
  suggestedAction: "Variant Bを適用",
  evidence: { experimentId: "exp-1" },
  dedupKey: "tenant:carnation:ab_winner:exp-1",
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  mockCreateRepo.mockReturnValue({
    insertProposal: mockInsertProposal,
    findProposalIdByDedupKey: mockFindProposalIdByDedupKey,
  });
  mockListActive.mockResolvedValue([]);
  mockCollectAll.mockResolvedValue([]);
  mockInsertProposal.mockResolvedValue(true);
  mockFindProposalIdByDedupKey.mockResolvedValue("1");
});

afterEach(() => {
  // 順序が重要: フェイクタイマー下で作られた interval を real timers に切り替える前に
  // stopHermes() で clearInterval しないと、次テストへ intervalHandle が漏れて
  // 二重起動ガードが誤発火する(heartbeatHandler.test.ts と同じ落とし穴)。
  stopHermes();
  jest.useRealTimers();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("runHermesCycle", () => {
  it("global提案は super_admin へ通知される", async () => {
    mockCollectAll.mockResolvedValue([globalCandidate]);

    const result = await runHermesCycle();

    expect(result).toEqual({ generated: 1, skipped: 0 });
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: "super_admin",
        recipientTenantId: undefined,
        type: "hermes_proposal",
        link: "/admin/hermes",
      }),
    );
  });

  it("tenant提案は client_admin へ tenantId 付きで通知される", async () => {
    mockCollectAll.mockResolvedValue([tenantCandidate]);

    await runHermesCycle();

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: "client_admin",
        recipientTenantId: "carnation",
        link: "/admin/conversion",
      }),
    );
  });

  it("insertProposalがfalse(重複)なら通知せずskippedをカウント", async () => {
    mockCollectAll.mockResolvedValue([globalCandidate]);
    mockInsertProposal.mockResolvedValue(false);

    const result = await runHermesCycle();

    expect(result).toEqual({ generated: 0, skipped: 1 });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("HERMES_NOTIFY_ENABLED=false なら永続化はするが通知しない", async () => {
    process.env.HERMES_NOTIFY_ENABLED = "false";
    mockCollectAll.mockResolvedValue([globalCandidate]);

    const result = await runHermesCycle();

    expect(result).toEqual({ generated: 1, skipped: 0 });
    expect(mockInsertProposal).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("アクティブテナントをHERMES_TENANTSで絞り込んでcollectAllProposalCandidatesに渡す", async () => {
    process.env.HERMES_TENANTS = "carnation";
    mockListActive.mockResolvedValue(["carnation", "other-tenant"]);

    await runHermesCycle();

    expect(mockCollectAll).toHaveBeenCalledWith(["carnation"]);
  });

  it("generated>0のときSlackサマリを送る", async () => {
    mockCollectAll.mockResolvedValue([globalCandidate]);

    await runHermesCycle();

    expect(mockSendSlackAlert).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "hermes-agent-cycle", level: "INFO" }),
    );
  });

  it("generated=0のときSlackサマリを送らない", async () => {
    mockCollectAll.mockResolvedValue([]);

    await runHermesCycle();

    expect(mockSendSlackAlert).not.toHaveBeenCalled();
  });

  it("collectAllProposalCandidatesが失敗しても例外を投げず{generated:0,skipped:0}を返す", async () => {
    mockCollectAll.mockRejectedValue(new Error("db down"));

    await expect(runHermesCycle()).resolves.toEqual({ generated: 0, skipped: 0 });
  });

  it("1件のinsertProposalが失敗しても他の候補の処理は継続する", async () => {
    mockCollectAll.mockResolvedValue([globalCandidate, tenantCandidate]);
    mockInsertProposal
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValueOnce(true);

    const result = await runHermesCycle();

    expect(result).toEqual({ generated: 1, skipped: 0 });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });
});

describe("startHermes / stopHermes", () => {
  it("HERMES_ENABLED未設定ならintervalを作らない", () => {
    jest.useFakeTimers();

    startHermes();
    jest.advanceTimersByTime(6 * 60 * 60 * 1000 + 1000);

    expect(mockCollectAll).not.toHaveBeenCalled();
  });

  it("HERMES_ENABLED=trueなら6時間周期でrunHermesCycleが走る", () => {
    jest.useFakeTimers();
    process.env.HERMES_ENABLED = "true";

    startHermes();
    jest.advanceTimersByTime(6 * 60 * 60 * 1000 + 1000);

    expect(mockListActive).toHaveBeenCalled();
  });

  it("二重起動してもintervalは1本のみ", () => {
    jest.useFakeTimers();
    process.env.HERMES_ENABLED = "true";

    startHermes();
    startHermes();
    jest.advanceTimersByTime(6 * 60 * 60 * 1000 + 1000);

    expect(mockListActive).toHaveBeenCalledTimes(1);
  });

  it("stopHermes後はintervalが再度作れる状態に戻る", () => {
    jest.useFakeTimers();
    process.env.HERMES_ENABLED = "true";

    startHermes();
    stopHermes();
    startHermes();
    jest.advanceTimersByTime(6 * 60 * 60 * 1000 + 1000);

    expect(mockListActive).toHaveBeenCalledTimes(1);
  });
});
