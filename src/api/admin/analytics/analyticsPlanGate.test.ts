// src/api/admin/analytics/analyticsPlanGate.test.ts
// GID: LP料金表(Standard〜: 会話分析 / Growth〜: 成果分析(CV計測))に基づくplan制限の
// 回帰テスト。pool可用性チェックの後段でplanを確認し、client_adminのみ対象とすることを
// 検証する。2026-08-29: summary/trends/evaluations(analytics)を Standard へ開放し、
// conversions(conversion)は Growth のまま据え置いた分割の固定。

const mockQuery = jest.fn();

jest.mock("../../../lib/db", () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
  getPool: () => ({ query: (...args: any[]) => mockQuery(...args) }),
}));
jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../lib/notifications", () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn(),
}));
jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
import { registerAnalyticsRoutes } from "./routes";

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata } : null;
    next();
  });
  registerAnalyticsRoutes(app);
  return app;
}

describe("GET /v1/admin/analytics/summary — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=starter → 403 plan_upgrade_required、以降のクエリは実行されない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [{ total: "0" }], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    mockQuery.mockResolvedValue({ rows: [{ total: "0" }], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).not.toBe(403);
    // 1件目のクエリがplan確認(`SELECT plan FROM tenants`)ではないことを確認
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });

  // 2026-08-29: analyticsをGrowthからStandardへ開放した本体。summaryはStandardで
  // 通ることを固定する(analyticsPlanGate回帰の中核)。
  it("client_admin + plan=standard → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [{ total: "0" }], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).not.toBe(403);
  });
});

// conversions(成果分析)はanalytics分割後もGrowthのまま据え置き。summaryがStandardで
// 通るようになった一方、こちらはStandardでは403になることを固定する(混同防止の回帰)。
describe("GET /v1/admin/analytics/conversions — plan ゲート(Growthのまま据え置き)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=standard → 403 plan_upgrade_required(analyticsとは別ゲート)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).not.toBe(403);
  });
});

// trends / evaluations は summary と同じ analytics ゲート(Standard〜)を通るはずだが、
// 個別には未検証だった(取り違えると全ゲートが静かに壊れる箇所なのに穴になっていた)。
describe("GET /v1/admin/analytics/trends — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=starter → 403 plan_upgrade_required", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/trends");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
  });

  it("client_admin + plan=standard → planゲートを通過する(403にならない、analytics開放の対象)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/trends");

    expect(res.status).not.toBe(403);
  });
});

describe("GET /v1/admin/analytics/evaluations — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=starter → 403 plan_upgrade_required(集計クエリは実行されない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/evaluations");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=standard → planゲートを通過する(403にならない、analytics開放の対象)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/evaluations");

    expect(res.status).not.toBe(403);
  });
});

// ★ゲート取り違え検知(穴2)★
// 個別エンドポイントのテストはそれぞれ独立しているため、「新しいエンドポイントを
// analyticsのつもりでconversionゲートに繋いだ」「逆に外し忘れた」といった取り違えは
// 見た目上どのテストも書き方に沿っていれば通ってしまう。エンドポイント一覧を
// 1箇所のテーブルにまとめ、standardプラン1本で「analytics系は全通過・conversion系は
// 全403」を一括検証する。新しいエンドポイントを足すときはこのテーブルに追加すること。
const ANALYTICS_GATE_ENDPOINTS: ReadonlyArray<{ path: string; feature: "analytics" | "conversion" }> = [
  { path: "/v1/admin/analytics/summary", feature: "analytics" },
  { path: "/v1/admin/analytics/trends", feature: "analytics" },
  { path: "/v1/admin/analytics/evaluations", feature: "analytics" },
  { path: "/v1/admin/analytics/conversions", feature: "conversion" },
  { path: "/v1/admin/analytics/knowledge-attribution", feature: "conversion" },
  { path: "/v1/admin/analytics/rule-effect/42", feature: "conversion" },
];

describe("ゲート取り違え検知: standardプランで analytics系は全通過・conversion系は全403", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it.each(ANALYTICS_GATE_ENDPOINTS.filter((e) => e.feature === "analytics").map((e) => e.path))(
    "%s は standard プランで通過する(403にならない = analyticsゲートに正しく繋がっている)",
    async (path) => {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" })).get(path);

      expect(res.status).not.toBe(403);
    },
  );

  it.each(ANALYTICS_GATE_ENDPOINTS.filter((e) => e.feature === "conversion").map((e) => e.path))(
    "%s は standard プランで403になる(analyticsゲートに紛れ込んでいない = conversionゲートのまま)",
    async (path) => {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

      const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" })).get(path);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("plan_upgrade_required");
    },
  );
});

// ★403のエラー形と文言(穴3)★
// admin-ui の isPlanUpgradeRequired は error フィールドの値に依存して赤帯表示を分岐する。
// message は機能別に出し分けているが、error はどちらの機能で403になっても
// 完全に同じ文字列でなければならない(ここが割れると正常系の分岐UIが壊れる)。
describe("403のエラー形と文言(admin-uiのisPlanUpgradeRequiredが依存する形)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("analytics機能の403はStandardを案内し、Growthとは言わない(逆側の文言が紛れ込んでいない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Standard");
    expect(res.body.message).not.toContain("Growth");
  });

  it("conversion機能の403はGrowthを案内し、Standardとは言わない(Standard開放後に嘘の案内をしない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
    expect(res.body.message).not.toContain("Standard");
  });

  it("★analyticsとconversionの403はmessageが違ってもerrorは完全一致する★", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    const analyticsRes = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
    const conversionRes = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(analyticsRes.status).toBe(403);
    expect(conversionRes.status).toBe(403);
    expect(analyticsRes.body.error).toBe(conversionRes.body.error);
    expect(analyticsRes.body.message).not.toBe(conversionRes.body.message);
  });
});

// ★テナント管理者がやりそうな乱暴な操作(穴5)★
describe("plan ゲートに対するイレギュラーな操作", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // 403を受けた直後にクエリパラメータで他テナントを指定して再試行しても、
  // client_adminのgateは常にJWTのtenant_idで判定するため回避できないことを固定する
  // (resolveTenantFilterはclient_adminの場合queryを無視してjwtTenantIdを使う実装だが、
  // 実装ではなく「回避できない」という観測可能な結果そのものを固定する)。
  it("client_adminが?tenant=で他テナントを指定してもgateはJWTのtenant_idで判定する(query改ざんで回避できない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary?tenant=tenant-with-growth-plan");

    expect(res.status).toBe(403);
    // plan確認クエリに渡されたtenantIdがJWTのtenant-aであり、queryのtenant-with-growth-planではない
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(["tenant-a"]);
  });

  // super_admin自身のapp_metadataにtenant_idが乗っていても(例: 自社所属テナントを
  // 持つ運用アカウント)、gateはsuper_adminである時点で無条件バイパスし、
  // データ絞り込みも自身のtenant_idではなく?tenantクエリが使われることを固定する。
  it("super_adminは自身のtenant_idを持っていてもgateをバイパスし、?tenantクエリのテナントでデータを返す", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin", tenant_id: "staff-own-tenant" }))
      .get("/v1/admin/analytics/evaluations?tenant=tenant-customer");

    expect(res.status).not.toBe(403);
    expect(res.body.tenant_id).toBe("tenant-customer");
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });

  // checkAnalyticsPlanAccessはgetTenantPlan(60秒TTLキャッシュ付き)ではなく
  // queryTenantPlanOrThrowを直接使う(planFeatures.ts参照)。プラン変更直後に
  // 前のプランの判定を60秒引きずらないことを、同一テナントへの連続リクエストで固定する。
  it("同一テナントへの連続リクエストは毎回plan確認クエリを実行する(TTLキャッシュに乗らない = プラン変更が即座に反映される)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    const res1 = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");
    expect(res1.status).toBe(403);

    // DB側でプランがgrowthへ更新された想定で2回目のリクエスト
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res2 = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");
    expect(res2.status).not.toBe(403);

    const planQueryCount = mockQuery.mock.calls.filter((c) =>
      /SELECT plan FROM tenants/.test(String(c[0])),
    ).length;
    expect(planQueryCount).toBe(2);
  });
});

// [H-5] GID 1217969425230400: knowledge-attribution / rule-effect はplanゲートを
// 一切通っていなかった(free_ad含む全プランが無制限に取得可能)。性質としては成果分析
// (conversion, Growth〜)なのでconversionsと同じゲートを適用する回帰を固定する。
describe("GET /v1/admin/analytics/knowledge-attribution — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=standard → 403 plan_upgrade_required(以降のクエリは実行されない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/knowledge-attribution");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/knowledge-attribution");

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/knowledge-attribution?tenant_id=tenant-a");

    expect(res.status).not.toBe(403);
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});

describe("GET /v1/admin/analytics/rule-effect/:ruleId — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=standard → 403 plan_upgrade_required(ルール参照クエリは実行されない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/rule-effect/42");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // fetchRuleMeta以降の汎用フォールバック(rule_not_found → 404)

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/rule-effect/42");

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/rule-effect/42");

    expect(res.status).not.toBe(403);
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});

// GID 1217969364194602 [H-7]: checkAnalyticsPlanAccess は queryTenantPlan(DB例外も
// free_adへ丸め込むfail-safe)を使っていたため、plan確認クエリ自体がDB障害で例外を
// 投げると「plan_upgrade_required」(403)に化けてしまい、実際のDB障害を隠していた。
// queryTenantPlanOrThrow への切り替えの回帰テスト。403でないことだけでなく、
// 意図した500が返ることまで確認する。
describe("plan確認クエリがDB障害の場合、plan_upgrade_requiredで覆い隠さない", () => {
  it("GET /v1/admin/analytics/summary — plan確認クエリが例外→500(403に化けない)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection reset"));

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(500);
    expect(res.body.error).not.toBe("plan_upgrade_required");
  });

  it("GET /v1/admin/analytics/conversions — plan確認クエリが例外→500(403に化けない)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection reset"));

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(500);
    expect(res.body.error).not.toBe("plan_upgrade_required");
  });

  it("super_adminはplanゲート自体をバイパスするため、plan確認クエリのDB障害の影響を受けない", async () => {
    // super_adminはcheckAnalyticsPlanAccessの時点でtrueを返しplan確認クエリを叩かないため、
    // 後続の集計クエリだけがrejectされる(= 通常のDBエラー500経路。プランゲートとは無関係)。
    mockQuery.mockRejectedValue(new Error("connection reset"));

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(500);
    expect(res.body.error).not.toBe("plan_upgrade_required");
  });
});
