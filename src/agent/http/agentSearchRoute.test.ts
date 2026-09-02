import type { Response } from "express";
import pino from "pino";
import type { AuthedRequest } from "./authMiddleware";

jest.mock("../flow/searchAgent", () => ({
  runSearchAgent: jest.fn(),
}));
jest.mock("../../lib/defaultExcludedIds", () => ({
  fetchDefaultExcludedIds: jest.fn(),
  mergeExcludedIds: jest.fn((excludedIds: unknown) => excludedIds ?? []),
}));
jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: jest.fn(),
}));
// [A2A-1a]: getTenantPlan だけモックし、planHasFeature は実実装のまま使う
// (プラン→ゲート可否のロジックまでテストがカバーするため)。
jest.mock("../../lib/billing/planFeatures", () => {
  const actual = jest.requireActual("../../lib/billing/planFeatures");
  return { ...actual, getTenantPlan: jest.fn() };
});

import { createAgentSearchHandler } from "./agentSearchRoute";
import { runSearchAgent } from "../flow/searchAgent";
import { fetchDefaultExcludedIds } from "../../lib/defaultExcludedIds";
import { trackUsage } from "../../lib/billing/usageTracker";
import { getTenantPlan } from "../../lib/billing/planFeatures";
import { CHAT_LLM_MODEL } from "../../lib/billing/chatUsage";

const mockedRunSearchAgent = runSearchAgent as jest.MockedFunction<typeof runSearchAgent>;
const mockedFetchDefaultExcludedIds = fetchDefaultExcludedIds as jest.MockedFunction<
  typeof fetchDefaultExcludedIds
>;
const mockedTrackUsage = trackUsage as jest.MockedFunction<typeof trackUsage>;
const mockedGetTenantPlan = getTenantPlan as jest.MockedFunction<typeof getTenantPlan>;

function mockReq(overrides: Record<string, unknown> = {}): AuthedRequest {
  const headers: Record<string, string> = (overrides.headers as Record<string, string>) ?? {};
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    headers,
    body: { q: "送料について" },
    tenantId: undefined as unknown as string,
    requestId: "req-test-1",
    ...overrides,
  } as unknown as AuthedRequest;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe("createAgentSearchHandler", () => {
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchDefaultExcludedIds.mockResolvedValue([]);
    mockedRunSearchAgent.mockResolvedValue({ answer: "ok" } as any);
    // [A2A-1a]: agent_search は Growth 以上限定。既存テストは全てゲートを
    // 通過させたいので、既定は growth にしておく(starter/free_ad が必要な
    // テストだけ個別に上書きする)。
    mockedGetTenantPlan.mockResolvedValue("growth");
  });

  it("rejects request with no authenticated tenantId (401)", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({ tenantId: undefined });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "unauthorized" })
    );
    expect(mockedRunSearchAgent).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied x-tenant-id header and uses the authenticated tenantId", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({
      tenantId: "tenant-a",
      headers: { "x-tenant-id": "tenant-b" },
    });
    const res = mockRes();

    await handler(req, res);

    expect(mockedFetchDefaultExcludedIds).toHaveBeenCalledWith("tenant-a");
    expect(mockedRunSearchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a" })
    );
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it("scopes the search to the authenticated tenantId when no header is present", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({ tenantId: "tenant-a" });
    const res = mockRes();

    await handler(req, res);

    expect(mockedRunSearchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a" })
    );
  });

  it("still validates the request body before touching tenant resolution", async () => {
    const handler = createAgentSearchHandler(logger);
    const req = mockReq({ tenantId: "tenant-a", body: {} });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedRunSearchAgent).not.toHaveBeenCalled();
  });

  describe("x-tenant-id header cannot override the authenticated tenant (regression guard)", () => {
    it("ignores a header naming a real, differently-cased tenant id", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "Tenant-B" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("ignores an empty-string x-tenant-id header", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("ignores a whitespace-only x-tenant-id header", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "   " },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("ignores an oversized x-tenant-id header value (10k chars) without throwing", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "b".repeat(10_000) },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
      expect(res.status).not.toHaveBeenCalledWith(500);
    });

    it("ignores a header value containing embedded null bytes / control chars", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "tenant-b\u0000\u0007" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("does not read differently-cased header names (X-Tenant-Id, X-TENANT-ID) either", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        headers: { "x-tenant-id": "tenant-b" }, // mockReq lower-cases lookups; simulates any casing variant
      });
      // sanity: header() itself still resolves the value (proves the route just never calls it)
      expect(req.header("X-Tenant-Id")).toBe("tenant-b");

      const res = mockRes();
      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" })
      );
    });

    it("a super_admin-authenticated request still resolves to its own authenticated tenantId, not the header", async () => {
      // super_admin's tenant switching must go through an explicit, guarded mechanism
      // (targetTenantId + isSuperAdmin check) elsewhere — never through this header.
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "super-admin-home-tenant",
        headers: { "x-tenant-id": "victim-tenant" },
      });
      const res = mockRes();

      await handler(req, res);

      expect(mockedRunSearchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "super-admin-home-tenant" })
      );
    });
  });

  describe("defensive fail-closed when tenantId is falsy but not strictly undefined", () => {
    it("rejects with 401 when tenantId is an empty string", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "" });
      const res = mockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockedRunSearchAgent).not.toHaveBeenCalled();
    });

    it("rejects with 401 when tenantId is null", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: null as unknown as string });
      const res = mockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockedRunSearchAgent).not.toHaveBeenCalled();
    });

    it("never calls fetchDefaultExcludedIds before the tenant check (no side effects pre-auth)", async () => {
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: undefined });
      const res = mockRes();

      await handler(req, res);

      expect(mockedFetchDefaultExcludedIds).not.toHaveBeenCalled();
    });
  });

  // [A2A-1a]: 外部エージェント連携APIの商品化。テナントAPIキー認証は既に通って
  // いたが、プランへの載せ方が無く全プランへ無制限に到達できていた。Growth以上に限定する。
  describe("plan gate (Growth以上限定, GID [A2A-1a])", () => {
    it("rejects with 403 plan_upgrade_required when the tenant plan lacks agent_search", async () => {
      mockedGetTenantPlan.mockResolvedValue("starter");
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "plan_upgrade_required" })
      );
      expect(mockedRunSearchAgent).not.toHaveBeenCalled();
      expect(mockedTrackUsage).not.toHaveBeenCalled();
    });

    it("rejects free_ad and standard plans too (only growth/enterprise pass)", async () => {
      for (const plan of ["free_ad", "standard"] as const) {
        mockedGetTenantPlan.mockResolvedValue(plan);
        const handler = createAgentSearchHandler(logger);
        const req = mockReq({ tenantId: "tenant-a" });
        const res = mockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
      }
    });

    it("allows growth and enterprise plans through to the search agent", async () => {
      for (const plan of ["growth", "enterprise"] as const) {
        jest.clearAllMocks();
        mockedFetchDefaultExcludedIds.mockResolvedValue([]);
        mockedRunSearchAgent.mockResolvedValue({ answer: "ok" } as any);
        mockedGetTenantPlan.mockResolvedValue(plan);
        const handler = createAgentSearchHandler(logger);
        const req = mockReq({ tenantId: "tenant-a" });
        const res = mockRes();

        await handler(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
        expect(mockedRunSearchAgent).toHaveBeenCalled();
      }
    });

    // fail-safe方向の確認: getTenantPlan は queryTenantPlan(planFeatures.ts)経由で
    // 常に5値のいずれかへ丸め込まれる設計だが、その fail-safe 自体が壊れた場合の
    // 「開いてしまう」方向の退行(未知の値を上位プラン扱いしてしまう)を、
    // ここでは実装(planHasFeature)を通して直接固定する。
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["空文字", ""],
      ["未知のプラン文字列", "bogus_plan"],
    ] as const)(
      "getTenantPlanが%sを返しても403で弾く(開く方向に倒れない)",
      async (_label, planValue) => {
        mockedGetTenantPlan.mockResolvedValue(planValue as any);
        const handler = createAgentSearchHandler(logger);
        const req = mockReq({ tenantId: "tenant-a" });
        const res = mockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(mockedRunSearchAgent).not.toHaveBeenCalled();
        expect(mockedTrackUsage).not.toHaveBeenCalled();
      },
    );

    // このAPIキー認証経路(agent/http/authMiddleware.ts)には role/super_admin の
    // 概念自体が無い(AuthedRequest は tenantId のみを持つ)。仮に他ミドルウェアの
    // 混線で req に supabaseUser 相当のプロパティが紛れ込んでも、このハンドラは
    // それを一切読まないためゲートをすり抜けられないことを固定する
    // (GID [A2A-1a] コメント: 「このAPIキー認証経路には super_admin ロールの
    // 概念が無いため、バイパスは設けない」の実装側の裏付け)。
    it("req に super_admin 相当のロール情報が乗っていてもプランゲートをバイパスしない", async () => {
      mockedGetTenantPlan.mockResolvedValue("starter");
      const handler = createAgentSearchHandler(logger);
      const req = mockReq({
        tenantId: "tenant-a",
        supabaseUser: { app_metadata: { role: "super_admin" } },
      });
      const res = mockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockedRunSearchAgent).not.toHaveBeenCalled();
    });
  });

  // 収益監査ギャップ [P0]: /agent.search・/agent/search は LLM 合成・埋め込みを
  // 実行するのに trackUsage を通っておらず完全に未計上だった。
  describe("billing usage tracking (revenue audit gap [P0])", () => {
    it("counts usage via trackUsage with featureUsed=agent_search, the authenticated tenantId and requestId", async () => {
      mockedRunSearchAgent.mockResolvedValue({
        answer: "ok",
        llmUsage: { prompt_tokens: 120, completion_tokens: 40 },
      } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a", requestId: "req-42" });
      const res = mockRes();

      await handler(req, res);

      expect(mockedTrackUsage).toHaveBeenCalledTimes(1);
      expect(mockedTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-a",
          requestId: "req-42",
          featureUsed: "agent_search",
          model: CHAT_LLM_MODEL,
          inputTokens: 120,
          outputTokens: 40,
        })
      );
    });

    it("does not pass a sessionId (agent.search is a one-shot search, not a conversation)", async () => {
      mockedRunSearchAgent.mockResolvedValue({
        answer: "ok",
        llmUsage: { prompt_tokens: 10, completion_tokens: 5 },
      } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      const params = mockedTrackUsage.mock.calls[0][0];
      expect(params.sessionId).toBeUndefined();
    });

    it("folds the OpenAI query embedding into extraLlmUsages at its real model rate (not the chat model)", async () => {
      mockedRunSearchAgent.mockResolvedValue({
        answer: "ok",
        llmUsage: { prompt_tokens: 100, completion_tokens: 20 },
        embeddingUsage: { model: "text-embedding-3-small", totalTokens: 512 },
      } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      expect(mockedTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          extraLlmUsages: [
            { model: "text-embedding-3-small", inputTokens: 512, outputTokens: 0 },
          ],
        })
      );
    });

    it("records {0,0} chat tokens when synthesis produced no usage (still one billable request)", async () => {
      mockedRunSearchAgent.mockResolvedValue({ answer: "ok" } as any);

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res);

      expect(mockedTrackUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          featureUsed: "agent_search",
          inputTokens: 0,
          outputTokens: 0,
        })
      );
      // no embedding/planner → extraLlmUsages omitted entirely
      expect(mockedTrackUsage.mock.calls[0][0]).not.toHaveProperty("extraLlmUsages");
    });

    it("does not count usage when the request is rejected (401 / 400) before running the agent", async () => {
      const handler = createAgentSearchHandler(logger);

      await handler(mockReq({ tenantId: undefined }), mockRes()); // 401
      await handler(mockReq({ tenantId: "tenant-a", body: {} }), mockRes()); // 400

      expect(mockedTrackUsage).not.toHaveBeenCalled();
    });

    // [A2A-1a] migration_agent_search_feature.sql は本番未適用のまま。適用前は
    // trackUsage 内部のINSERTがCHECK制約違反(23514)で失敗しうる
    // (usageTracker.test.ts の「23514(CHECK制約違反)でも例外を投げずに終わる」で
    // 固定済み)。ただしそれは trackUsage が setImmediate 経由でスケジュールする
    // 「将来のティック」で起きる話で、trackUsage() 自体は呼び出し時点で即座に
    // void を返す(内部の失敗を呼び出し元へ伝播させない)。
    //
    // ここでは agentSearchRoute 側がその契約に実際に乗っている
    // (= trackUsage の戻り値/内部の失敗を await していない)ことを、
    // 「trackUsage が絶対に解決しない Promise を返しても handler 自体は完了する」
    // という形で固定する。もし将来 `await trackUsage(...)` のようなコードに
    // 変わっていたら、このテストはタイムアウトして落ちる
    // (=migration未適用時のDB遅延・エラーがレスポンスをブロックするようになる退行の検知)。
    it("does not await trackUsage's return value (a hanging/never-resolving trackUsage must not block the response)", async () => {
      mockedTrackUsage.mockImplementation(() => {
        // 型上は void だが、誤って await されていないかを検出するためにあえて
        // 解決しない Promise を仕込む(jest.fn の戻り値をキャストして注入)。
        return new Promise(() => {}) as unknown as void;
      });

      const handler = createAgentSearchHandler(logger);
      const req = mockReq({ tenantId: "tenant-a" });
      const res = mockRes();

      await handler(req, res); // await されていれば永遠にハングし、jestのデフォルトタイムアウトで落ちる

      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalled();
    });
  });
});
