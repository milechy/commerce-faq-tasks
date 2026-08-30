// src/api/hermes-mcp/routes.test.ts

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { registerHermesMcpRoutes } from "./routes";

jest.mock("../../lib/hermesConsent", () => ({
  isHermesDataConsentGranted: jest.fn(),
  listHermesConsentingTenantIds: jest.fn(),
  // GET /proposalsが「生SQLで判定を再実装していない」ことを検証できるよう、
  // 引数(features列を指す式)をそのままマーカー文字列に埋め込むダミー実装にする。
  shareConsentSqlPredicate: jest.fn((featuresExpr: string) => `SHARE_PREDICATE(${featuresExpr})`),
}));
jest.mock("./hermesMcpRepository", () => ({
  searchConversations: jest.fn(),
}));
jest.mock("../../lib/notifications", () => ({
  createNotification: jest.fn(),
}));
// [H-1] GET /proposalsの効果測定は既存のDiD集計(getRuleEffect)を再利用する。
// ルート層のテストではDBを介した実計算まで検証しないため、ここではモックする。
jest.mock("../admin/analytics/ruleEffect", () => ({
  getRuleEffect: jest.fn(),
}));

// R6: 提案は hermes_strategy_proposals ではなく tuning_rules に着地する
// (source='hermes', is_active=false, status='pending')。実装は生のpool.queryを
// 使うため、DBをモックしてSQL/引数を直接検証する。
const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { isHermesDataConsentGranted, listHermesConsentingTenantIds } from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";
import { createNotification } from "../../lib/notifications";
import { getRuleEffect } from "../admin/analytics/ruleEffect";

const mockIsConsentGranted = isHermesDataConsentGranted as jest.Mock;
const mockListConsenting = listHermesConsentingTenantIds as jest.Mock;
const mockSearchConversations = searchConversations as jest.Mock;
const mockCreateNotification = createNotification as jest.Mock;
const mockGetRuleEffect = getRuleEffect as jest.Mock;

const API_KEY = "test-hermes-mcp-key";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerHermesMcpRoutes(app);
  return app;
}

function authedGet(path: string) {
  return request(makeApp()).get(path).set("Authorization", `Bearer ${API_KEY}`);
}

function authedPost(path: string, body: object) {
  return request(makeApp()).post(path).set("Authorization", `Bearer ${API_KEY}`).send(body);
}

const VALID_TENANT_PROPOSAL = {
  scope: "tenant",
  tenant_id: "carnation",
  title: "保証訴求の改善",
  rationale: "会話ログから保証質問への回答が購入に繋がるパターンを確認",
  suggested_action: "保証訴求を初回応答に含める",
  dedup_key: "tenant:carnation:warranty-pitch",
};

const VALID_GLOBAL_PROPOSAL = {
  scope: "global",
  title: "心理原則scarcityの全体採用を検討",
  rationale: "複数の同意済みテナントで共通するパターンを確認",
  suggested_action: "デフォルト戦略に追加検討",
  dedup_key: "global:scarcity-pattern",
};

beforeEach(() => {
  process.env.HERMES_MCP_API_KEY = API_KEY;
  mockIsConsentGranted.mockReset();
  mockListConsenting.mockReset();
  mockSearchConversations.mockReset();
  mockCreateNotification.mockReset().mockResolvedValue(undefined);
  mockQuery.mockReset().mockResolvedValue({ rows: [{ id: 1 }] });
  mockGetRuleEffect.mockReset();
});

afterEach(() => {
  delete process.env.HERMES_MCP_API_KEY;
});

describe("認証ガード", () => {
  it("Bearerトークンなしは401(tenants)", async () => {
    const res = await request(makeApp()).get("/v1/hermes-mcp/tenants");
    expect(res.status).toBe(401);
  });

  it("Bearerトークンなしは401(conversations)", async () => {
    const res = await request(makeApp()).get("/v1/hermes-mcp/conversations?tenant_id=carnation");
    expect(res.status).toBe(401);
  });

  it("Bearerトークンなしは401(proposals)", async () => {
    const res = await request(makeApp()).get("/v1/hermes-mcp/proposals");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/hermes-mcp/tenants", () => {
  it("同意済みテナントID一覧を返す", async () => {
    mockListConsenting.mockResolvedValue(["carnation"]);
    const res = await authedGet("/v1/hermes-mcp/tenants");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantIds: ["carnation"] });
  });
});

describe("GET /v1/hermes-mcp/conversations", () => {
  it("tenant_id未指定は400", async () => {
    const res = await authedGet("/v1/hermes-mcp/conversations");
    expect(res.status).toBe(400);
    expect(mockIsConsentGranted).not.toHaveBeenCalled();
  });

  it("未同意テナントは403、searchConversationsは呼ばれない(同意チェック最優先)", async () => {
    mockIsConsentGranted.mockResolvedValue(false);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=other-tenant");
    expect(res.status).toBe(403);
    expect(mockSearchConversations).not.toHaveBeenCalled();
  });

  it("同意済みテナントは検索結果を返す", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockSearchConversations.mockResolvedValue([
      { sessionId: "s1", role: "user", content: "hi", createdAt: "x", judgeScore: 80, converted: true },
    ]);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(mockSearchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "carnation" }),
    );
  });

  it("不正なmin_judge_score(範囲外)は400", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&min_judge_score=150");
    expect(res.status).toBe(400);
    expect(mockSearchConversations).not.toHaveBeenCalled();
  });

  it("不正なlimit(範囲外)は400", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&limit=99999");
    expect(res.status).toBe(400);
  });

  it("converted_only=trueがsearchConversationsに伝搬する", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockSearchConversations.mockResolvedValue([]);
    await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&converted_only=true");
    expect(mockSearchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ convertedOnly: true }),
    );
  });
});

describe("POST /v1/hermes-mcp/proposals", () => {
  it("認証なしは401", async () => {
    const res = await request(makeApp()).post("/v1/hermes-mcp/proposals").send(VALID_TENANT_PROPOSAL);
    expect(res.status).toBe(401);
  });

  it("正常系: tenant提案(同意済み)を tuning_rules(source=hermes, is_active=false) へ保存し201・通知がclient_admin宛に送られる", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ proposal_id: "1", duplicate: false });
    expect(mockIsConsentGranted).toHaveBeenCalledWith("carnation");

    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO tuning_rules");
    expect(sql).toContain("'hermes'");
    expect(sql).toContain("false");
    expect(args).toEqual([
      "carnation",
      "保証訴求の改善",
      "保証訴求を初回応答に含める",
      expect.any(String),
      "tenant:carnation:warranty-pitch",
    ]);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: "client_admin",
        recipientTenantId: "carnation",
        link: "/admin/tenants/carnation",
      }),
    );
  });

  it("正常系: global提案は tenant_id='global' として保存され201・通知がsuper_admin宛に送られる(同意チェックは呼ばれない)", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_GLOBAL_PROPOSAL);

    expect(res.status).toBe(201);
    expect(mockIsConsentGranted).not.toHaveBeenCalled();

    const [, args] = mockQuery.mock.calls[0]!;
    expect(args[0]).toBe("global");

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: "super_admin", recipientTenantId: undefined, link: "/admin/tenants" }),
    );
  });

  it("未同意テナントは403、INSERTは呼ばれない(同意チェック最優先)", async () => {
    mockIsConsentGranted.mockResolvedValue(false);
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("重複投稿(dedup_key衝突、ON CONFLICT DO NOTHING)は200でduplicate:trueを返す(エラー扱いしない)", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicate: true });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: 不正なscopeは400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_GLOBAL_PROPOSAL, scope: "bogus" });
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: scope=tenantでtenant_id欠落は400", async () => {
    const { tenant_id: _drop, ...rest } = VALID_TENANT_PROPOSAL;
    const res = await authedPost("/v1/hermes-mcp/proposals", rest);
    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: scope=globalでtenant_idを渡すと400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_GLOBAL_PROPOSAL, tenant_id: "carnation" });
    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: titleが空文字は400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_GLOBAL_PROPOSAL, title: "" });
    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: dedup_key欠落は400", async () => {
    const { dedup_key: _drop, ...rest } = VALID_GLOBAL_PROPOSAL;
    const res = await authedPost("/v1/hermes-mcp/proposals", rest);
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/hermes-mcp/proposals", () => {
  const PENDING_TENANT_ROW = {
    id: 1,
    tenant_id: "carnation",
    trigger_pattern: "保証訴求の改善",
    status: "pending",
    dedup_key: "tenant:carnation:warranty-pitch",
    approved_at: null,
    rejected_at: null,
    created_at: "2026-08-20T00:00:00.000Z",
  };

  const REJECTED_GLOBAL_ROW = {
    id: 2,
    tenant_id: "global",
    trigger_pattern: "心理原則scarcityの全体採用を検討",
    status: "rejected",
    dedup_key: "global:scarcity-pattern",
    approved_at: null,
    rejected_at: "2026-08-21T00:00:00.000Z",
    created_at: "2026-08-19T00:00:00.000Z",
  };

  const ACTIVE_TENANT_ROW = {
    id: 3,
    tenant_id: "carnation",
    trigger_pattern: "初回応答の見直し",
    status: "active",
    dedup_key: "tenant:carnation:first-response",
    approved_at: "2026-08-22T00:00:00.000Z",
    rejected_at: null,
    created_at: "2026-08-18T00:00:00.000Z",
  };

  it("R6: tuning_rules(source='hermes')を読み、越境防止はshareConsentSqlPredicate()を経由する(生SQLで再実装しない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ proposals: [] });

    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("tr.source = 'hermes'");
    expect(sql).toContain("tr.tenant_id = 'global'");
    // 生SQLで判定を再実装せず shareConsentSqlPredicate() を経由していること
    // (モックはマーカー文字列を返すダミー実装なので、その出現で呼び出しを検証する)
    expect(sql).toContain("SHARE_PREDICATE(t.features)");
    expect(sql).toContain("ORDER BY tr.created_at DESC");
    expect(args).toEqual([50]); // 既定limit(hermesMcpRepository.tsのDEFAULT_LIMITに合わせる)
  });

  it("pending/rejectedの提案をtitle/status/dedup_key/decided_at付きで返す(未承認・却下は効果測定を呼ばない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [PENDING_TENANT_ROW, REJECTED_GLOBAL_ROW] });
    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toEqual([
      {
        proposal_id: "1",
        scope: "tenant",
        tenant_id: "carnation",
        title: "保証訴求の改善",
        status: "pending",
        dedup_key: "tenant:carnation:warranty-pitch",
        decided_at: null,
        created_at: "2026-08-20T00:00:00.000Z",
        effect: null,
      },
      {
        proposal_id: "2",
        scope: "global",
        title: "心理原則scarcityの全体採用を検討",
        status: "rejected",
        dedup_key: "global:scarcity-pattern",
        decided_at: "2026-08-21T00:00:00.000Z",
        created_at: "2026-08-19T00:00:00.000Z",
        effect: null,
      },
    ]);
    expect(mockGetRuleEffect).not.toHaveBeenCalled();
  });

  it("status='active'の提案のみ既存のDiD効果測定(getRuleEffect)を再利用して結果を含める", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_TENANT_ROW, PENDING_TENANT_ROW] });
    mockGetRuleEffect.mockResolvedValue({ status: "insufficient_data", minSampleSize: 5, progress: [] });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    expect(mockGetRuleEffect).toHaveBeenCalledTimes(1);
    expect(mockGetRuleEffect).toHaveBeenCalledWith(expect.anything(), 3);

    const active = res.body.proposals.find((p: { proposal_id: string }) => p.proposal_id === "3");
    expect(active.status).toBe("active");
    expect(active.decided_at).toBe("2026-08-22T00:00:00.000Z");
    expect(active.effect).toEqual({ status: "insufficient_data", minSampleSize: 5, progress: [] });

    const pending = res.body.proposals.find((p: { proposal_id: string }) => p.proposal_id === "1");
    expect(pending.effect).toBeNull();
  });

  it("effect計算はリクエストあたり上限10件で打ち切り、超過分は「未計算」を pending/rejected の null と区別できる形で返す", async () => {
    // 作成日時降順(SQLのORDER BY)で並んだ status='active' 行を11件用意する。
    const activeRows = Array.from({ length: 11 }, (_, i) => ({
      ...ACTIVE_TENANT_ROW,
      id: i + 1,
      dedup_key: `tenant:carnation:rule-${i + 1}`,
    }));
    mockQuery.mockResolvedValueOnce({ rows: activeRows });
    mockGetRuleEffect.mockResolvedValue({ status: "ok", comparison: {} });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    // 上限(10件)だけ実際にgetRuleEffectを呼ぶ。11件全部には呼ばない。
    expect(mockGetRuleEffect).toHaveBeenCalledTimes(10);
    // 先頭(=作成日時が新しい方)から順に計算する
    for (let i = 0; i < 10; i++) {
      expect(mockGetRuleEffect).toHaveBeenNthCalledWith(i + 1, expect.anything(), i + 1);
    }

    const proposals = res.body.proposals as Array<{ proposal_id: string; effect: unknown }>;
    // 上限内: 実際のgetRuleEffect結果
    for (let i = 0; i < 10; i++) {
      expect(proposals[i]!.effect).toEqual({ status: "ok", comparison: {} });
    }
    // 上限超過: nullではなく「未計算」を明示するマーカー(pending/rejectedのeffect: nullと
    // 区別できないと、Hermesが「効果ゼロ」と誤読するため)
    expect(proposals[10]!.effect).toEqual({ status: "not_computed", reason: "effect_limit_exceeded" });
    expect(proposals[10]!.effect).not.toBeNull();
  });

  it("limit未指定は既定50、200を超える指定は400でクエリを発行しない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const okRes = await authedGet("/v1/hermes-mcp/proposals?limit=10");
    expect(okRes.status).toBe(200);
    expect(mockQuery.mock.calls[0]![1]).toEqual([10]);

    mockQuery.mockClear();
    const badRes = await authedGet("/v1/hermes-mcp/proposals?limit=9999");
    expect(badRes.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("limitが整数でない場合も400", async () => {
    const res = await authedGet("/v1/hermes-mcp/proposals?limit=abc");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("DBエラー時は500", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const res = await authedGet("/v1/hermes-mcp/proposals");
    expect(res.status).toBe(500);
  });
});
