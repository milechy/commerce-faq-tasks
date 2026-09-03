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

// tenant-economics は売上側の数量を computeExpectedBilling(唯一の出どころ)から取る。
// ここでの関心は「金額が漏れないこと」なので、数量だけを返すスタブにする。
jest.mock("../../lib/billing/stripeSync", () => ({
  computeExpectedBilling: jest.fn(),
}));

import { isHermesDataConsentGranted, listHermesConsentingTenantIds } from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";
import { createNotification } from "../../lib/notifications";
import { getRuleEffect } from "../admin/analytics/ruleEffect";
import { computeExpectedBilling } from "../../lib/billing/stripeSync";

const mockIsConsentGranted = isHermesDataConsentGranted as jest.Mock;
const mockListConsenting = listHermesConsentingTenantIds as jest.Mock;
const mockSearchConversations = searchConversations as jest.Mock;
const mockCreateNotification = createNotification as jest.Mock;
const mockGetRuleEffect = getRuleEffect as jest.Mock;
const mockComputeExpectedBilling = computeExpectedBilling as jest.Mock;

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
  mockComputeExpectedBilling.mockReset().mockResolvedValue({
    totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0,
    billedQuantity: 0, fallbackMultiplier: 1, textUnits: 0, avatarMinutes: 0,
  });
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

  // [穴4] 外部エージェントが送りうる乱暴なlimit値。同意チェックより後で
  // 落ちる想定だが、いずれもsearchConversationsを呼ばず400で止まることを固定する。
  it.each([["0", "0"], ["-1", "負数"], ["1.5", "小数"], ["abc", "数値でない文字列"]])(
    "不正なlimit(%s: %s)は400でsearchConversationsを呼ばない",
    async (value, _label) => {
      mockIsConsentGranted.mockResolvedValue(true);
      const res = await authedGet(`/v1/hermes-mcp/conversations?tenant_id=carnation&limit=${value}`);
      expect(res.status).toBe(400);
      expect(mockSearchConversations).not.toHaveBeenCalled();
    },
  );

  it("limitを配列で渡す(?limit=1&limit=2)は数値パースされず既定値にフォールバックする(クラッシュしない)", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockSearchConversations.mockResolvedValue([]);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&limit=1&limit=2");
    expect(res.status).toBe(200);
    expect(mockSearchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it("tenant_idが空文字は400(同意チェックより前で弾かれる)", async () => {
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=");
    expect(res.status).toBe(400);
    expect(mockIsConsentGranted).not.toHaveBeenCalled();
  });

  it("tenant_idを配列で渡す(?tenant_id=a&tenant_id=b)は400(文字列以外を同意チェックに渡さない)", async () => {
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=a&tenant_id=b");
    expect(res.status).toBe(400);
    expect(mockIsConsentGranted).not.toHaveBeenCalled();
  });

  it("min_judge_scoreが数値でない文字列は400", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    const res = await authedGet("/v1/hermes-mcp/conversations?tenant_id=carnation&min_judge_score=abc");
    expect(res.status).toBe(400);
    expect(mockSearchConversations).not.toHaveBeenCalled();
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
      // D8-2: proposal_type を省略した既存 Hermes の投稿は behavior として着地する
      // (後方互換。既存の投稿側を1行も変えずに新種別を足せていることの確認)。
      "behavior",
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

  // H-7(GID 1217972930945091): 採択率 = active / (active + rejected) の分母は
  // Hermesが同じdedup_keyで再提案しても二重に増えてはいけない。ON CONFLICT DO
  // NOTHINGは既存行を一切UPDATEしないため、却下済み(status='rejected')の行に
  // 対して再投稿しても、その行はrejectedのまま(pendingに戻って母数の判定待ちに
  // 逆戻りすることも、rejectedのままもう1行増えて母数が二重計上されることもない)。
  // 上のテストと挙動は同じだが、ここではその「なぜそれでよいか」を明示するために
  // 分けて固定する。INSERT文自体にUPDATEやstatus書き換えの経路が無いことも
  // SQL文で確認する(欠陥があればここが失敗する)。
  it("却下済み(rejected)の提案が同じdedup_keyで再投稿されても、既存行のstatusはDBに一切触れられない(pendingに復活せず、母数も二重に増えない)", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    // ON CONFLICT DO NOTHING が発火した体(=既存rejected行に一切触れず、
    // 新しい行も挿入されない)を rows: [] で表現する。
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await authedPost("/v1/hermes-mcp/proposals", VALID_TENANT_PROPOSAL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicate: true });

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // INSERT ... ON CONFLICT ... DO NOTHING であること(DO UPDATEではない)。
    // DO UPDATEだと既存rejected行のstatusが書き換わりうる。
    expect(sql).toMatch(/INSERT INTO tuning_rules/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, dedup_key\)[\s\S]*DO NOTHING/);
    expect(sql).not.toMatch(/DO UPDATE/);
    // 通知も飛ばない(既存行への言及・再通知はしない)
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

  it("active提案が0件(pending/rejectedのみ)のときgetRuleEffectは一度も呼ばれない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await authedGet("/v1/hermes-mcp/proposals");
    expect(res.status).toBe(200);
    expect(mockGetRuleEffect).not.toHaveBeenCalled();
  });

  // [穴2] 既存の「effect計算は上限10件で打ち切り」テストはstatus='active'のみ
  // 11件という均一な行で検証しており、「上限10はactiveだけを数えるか」は
  // 未検証だった。pending/rejectedがactiveの間に挟まった状態(=作成日時降順の
  // 実際のSQL結果でありうる並び)で、pendingがeffect計算のスロットを消費しない
  // ことをここで固定する。もしpending/rejectedもカウントしていると、
  // 本来10件計算できるはずのactiveがそれより少ない件数しか計算されず、
  // Hermesから見て「未計算」が静かに増える(効果ゼロとは誤読しないが、
  // 承認判断に使える情報が理由なく減る)。
  it("上限10件はstatus='active'の行だけを数える。pending/rejectedが間に挟まってもactiveの計算対象は10件のまま", async () => {
    const activeRow = (id: number) => ({ ...ACTIVE_TENANT_ROW, id, dedup_key: `tenant:carnation:rule-${id}` });
    const pendingRow = (id: number) => ({ ...PENDING_TENANT_ROW, id, dedup_key: `tenant:carnation:pending-${id}` });

    // created_at DESC(SQL側のORDER BY)で返ってくる想定の並び: pending/rejectedが
    // 随所に混ざった状態でactiveが合計11件(id: 1〜11)ある。
    const rows = [
      pendingRow(100),
      activeRow(1),
      activeRow(2),
      activeRow(3),
      pendingRow(101),
      activeRow(4),
      activeRow(5),
      activeRow(6),
      activeRow(7),
      activeRow(8),
      pendingRow(102),
      activeRow(9),
      activeRow(10),
      activeRow(11), // 上限超過分(11件目のactive)
      pendingRow(103),
    ];
    mockQuery.mockResolvedValueOnce({ rows });
    mockGetRuleEffect.mockResolvedValue({ status: "ok", comparison: {} });

    const res = await authedGet("/v1/hermes-mcp/proposals");

    expect(res.status).toBe(200);
    // pendingが4件挟まっていても、activeの計算回数は10件のまま変わらない
    expect(mockGetRuleEffect).toHaveBeenCalledTimes(10);

    const proposals = res.body.proposals as Array<{
      proposal_id: string;
      status: string;
      effect: unknown;
    }>;
    const activeProposals = proposals.filter((p) => p.status === "active");
    const pendingProposals = proposals.filter((p) => p.status === "pending");

    expect(activeProposals).toHaveLength(11);
    // 上限内の10件は実計算結果
    for (const p of activeProposals.slice(0, 10)) {
      expect(p.effect).toEqual({ status: "ok", comparison: {} });
    }
    // 11件目のactiveだけが「未計算」マーカー
    expect(activeProposals[10]!.effect).toEqual({ status: "not_computed", reason: "effect_limit_exceeded" });

    // pendingは常にeffect: null(未計算マーカーとは異なる。pending/rejectedは
    // そもそも効果測定の対象外であり、上限超過とは区別する)
    expect(pendingProposals).toHaveLength(4);
    for (const p of pendingProposals) {
      expect(p.effect).toBeNull();
    }
  });

  it("limit=0は無効(400)でクエリを発行しない", async () => {
    const res = await authedGet("/v1/hermes-mcp/proposals?limit=0");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("limitが負数は400でクエリを発行しない", async () => {
    const res = await authedGet("/v1/hermes-mcp/proposals?limit=-1");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("limitが小数(整数でない)は400", async () => {
    const res = await authedGet("/v1/hermes-mcp/proposals?limit=1.5");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("limitを配列で渡す(?limit=1&limit=2)と数値パースされず既定値50にフォールバックする(クラッシュしない)", async () => {
    // expressはクエリパラメータが重複すると配列にする。typeof rawLimit === "string"の
    // チェックに落ちるため、意図せず無効化された形になる(400にはならず既定値になる)。
    // 想定外の入力形でも500やクラッシュにならないことを固定する。
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await authedGet("/v1/hermes-mcp/proposals?limit=1&limit=2");
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0]![1]).toEqual([50]);
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

// ---------------------------------------------------------------------------
// GET /v1/hermes-mcp/tenant-economics
// ---------------------------------------------------------------------------
describe("GET /v1/hermes-mcp/tenant-economics", () => {
  const OK_PLAN = { rows: [{ plan: "standard" }] };

  it("Bearerトークンなしは401", async () => {
    const res = await request(makeApp()).get("/v1/hermes-mcp/tenant-economics?tenant_id=c&period=202609");
    expect(res.status).toBe(401);
  });

  it("★未同意は403（存在確認すら与えない）★", async () => {
    mockIsConsentGranted.mockResolvedValue(false);
    const res = await authedGet("/v1/hermes-mcp/tenant-economics?tenant_id=carnation&period=202609");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "tenant_not_consented" });
    // 同意チェックが他の何よりも先 = DBに触れていない
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("存在しないテナントも403に倒す（存在有無を与えない）", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await authedGet("/v1/hermes-mcp/tenant-economics?tenant_id=nope&period=202609");
    expect(res.status).toBe(403);
  });

  it("tenant_id 必須", async () => {
    const res = await authedGet("/v1/hermes-mcp/tenant-economics?period=202609");
    expect(res.status).toBe(400);
  });

  it("period の形式を検証する（13月・日付形式を弾く）", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    for (const p of ["202613", "202600", "2026-09", "x"]) {
      const res = await authedGet(`/v1/hermes-mcp/tenant-economics?tenant_id=c&period=${p}`);
      expect([p, res.status]).toEqual([p, 400]);
    }
  });

  it("★レスポンスに金額を表すキーが1つも無い★（Hermes の生成文に金額を通さない）", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockQuery.mockResolvedValue(OK_PLAN);
    mockComputeExpectedBilling.mockResolvedValue({
      totalRequests: 0, totalCostCents: 99999, billableUnits: 0, unstampedRows: 0,
      billedQuantity: 0, fallbackMultiplier: 1, textUnits: 1500, avatarMinutes: 40,
    });

    const res = await authedGet("/v1/hermes-mcp/tenant-economics?tenant_id=carnation&period=202609");
    expect(res.status).toBe(200);
    // 一度赤くしてから通すこと(意図的に cost_total_cents を混ぜても漏れない形か)
    expect(JSON.stringify(res.body)).not.toMatch(/_jpy|_cents|margin|cost|profit|price|原価|粗利/i);
  });

  it("数量・率・シグナルを返す（超過を検出できる）", async () => {
    mockIsConsentGranted.mockResolvedValue(true);
    mockQuery.mockResolvedValue(OK_PLAN);
    mockComputeExpectedBilling.mockResolvedValue({
      totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0,
      billedQuantity: 0, fallbackMultiplier: 1, textUnits: 1500, avatarMinutes: 40,
    });

    const res = await authedGet("/v1/hermes-mcp/tenant-economics?tenant_id=carnation&period=202609");
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("standard");
    expect(res.body.usage.text_conversations).toBe(1500);
    expect(res.body.usage.text_overage).toBe(500);
    expect(res.body.signals).toContain("text_overage");
    expect(res.body.next_plan_candidate).toBe("growth");
    expect(res.body.boundary).toBe("jst_calendar_month");
    expect(res.body.period_from).toBe("2026-08-31T15:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/hermes-mcp/proposals — D8-2 アップセル提案
// ---------------------------------------------------------------------------
describe("POST /v1/hermes-mcp/proposals（アップセル）", () => {
  const UPSELL = {
    ...VALID_TENANT_PROPOSAL,
    dedup_key: "tenant:carnation:upsell:202609",
    proposal_type: "upsell",
    upsell: {
      signal: "text_overage",
      current_plan: "standard",
      recommended_plan: "growth",
      period_yyyymm: "202609",
    },
  };

  beforeEach(() => {
    mockIsConsentGranted.mockResolvedValue(true);
    // 1回目: プラン突合 / 2回目: INSERT
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: "standard" }] })
      .mockResolvedValue({ rows: [{ id: 7 }] });
  });

  it("★global scope のアップセルは400（全テナントへ営業提案が出るのを防ぐ）★", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", {
      ...VALID_GLOBAL_PROPOSAL, proposal_type: "upsell",
      upsell: UPSELL.upsell,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("upsell_requires_tenant_scope");
  });

  it("未知の proposal_type は400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_TENANT_PROPOSAL, proposal_type: "sales" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_proposal_type");
  });

  it("upsell 本体が無ければ400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", { ...VALID_TENANT_PROPOSAL, proposal_type: "upsell" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("upsell_required");
  });

  it("未知のシグナルは400（Hermes からの任意文字列を通さない）", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", {
      ...UPSELL, upsell: { ...UPSELL.upsell, signal: "make_them_pay" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_upsell_signal");
  });

  it("未知のプラン名は400", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", {
      ...UPSELL, upsell: { ...UPSELL.upsell, recommended_plan: "platinum" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_plan");
  });

  it("★現プランと食い違う提案は409（Hermes の古いスナップショットを弾く）★", async () => {
    mockQuery.mockReset().mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    const res = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("plan_mismatch");
    expect(res.body.actual_plan).toBe("growth");
  });

  it("正常系: proposal_type='upsell' で is_active=false のまま保存する", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(res.status).toBe(201);

    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO tuning_rules"))!;
    const [sql, args] = insertCall;
    expect(sql).toContain("false");
    expect(args[5]).toBe("upsell");
  });

  it("★trigger_pattern はサーバが決定的に組み立てる（UNIQUE 衝突を構造的に防ぐ）★", async () => {
    const res = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(res.status).toBe(201);

    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO tuning_rules"))!;
    const args = insertCall[1] as unknown[];
    // Hermes の title をそのまま使わない（毎月同じ文言で衝突するため）
    expect(args[1]).toBe("upsell:202609:text_overage");
    expect(args[1]).not.toBe(UPSELL.title);
    // title は evidence 側に保存する（失わない）
    expect(String(args[3])).toContain("hermes_title");
  });

  it("★投稿時の通知はテナントに送らない（未承認の営業提案を届けない）★", async () => {
    await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: "super_admin", recipientTenantId: undefined }),
    );
  });

  it("trigger_pattern の UNIQUE 衝突(23505)は duplicate として返す（成功を装わない）", async () => {
    mockQuery.mockReset()
      .mockResolvedValueOnce({ rows: [{ plan: "standard" }] })
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicate: true });
  });

  it("23505 以外の例外は500のまま（本当の失敗を duplicate に丸めない）", async () => {
    mockQuery.mockReset()
      .mockResolvedValueOnce({ rows: [{ plan: "standard" }] })
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "42703" }));
    const res = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(res.status).toBe(500);
  });
});
