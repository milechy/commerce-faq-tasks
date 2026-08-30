// src/api/admin/tenants/analyticsSummaryRoutes.test.ts
// テナント詳細「📉 アナリティクス」タブが常時500だった不具合の回帰テスト。
//
// chat_sessions の時刻列は started_at(chat-history/migration.sql)であり created_at は
// 存在しない。にもかかわらず created_at で絞っていたため、PostgreSQL が
// `column "created_at" does not exist` を返し、
// GET /v1/admin/tenants/:id/analytics-summary が常に500になっていた。
//
// 列名の誤りは型で防げない(SQLは文字列)ため、実際にDBへ渡るSQLそのものを検査する。

import express from "express";
import type { Express } from "express";
import { request } from "../../../../tests/helpers/testServer";
import type { Pool } from "pg";
import { registerAnalyticsSummaryRoutes } from "./analyticsSummaryRoutes";

jest.mock("../../../lib/billing/posthogUsageTracker", () => ({
  getMonthlyLLMUsageFromPostHog: jest.fn().mockResolvedValue(null),
}));

import { getMonthlyLLMUsageFromPostHog } from "../../../lib/billing/posthogUsageTracker";

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({ app_metadata: { role: "super_admin" } });
const CLIENT_ADMIN_TOKEN = makeDevJwt({ app_metadata: { role: "client_admin", tenant_id: "carnation" } });

const mockQuery = jest.fn();
const db = { query: (...args: unknown[]) => mockQuery(...args) } as unknown as Pool;

/** 実行された全SQLを連結して返す（何本目かに依存せず検査する） */
function allSql(): string {
  return mockQuery.mock.calls.map((c) => String(c[0])).join("\n---\n");
}
/**
 * chat_sessions を主テーブルとするSQLだけを抜き出す(conversationsRowクエリ)。
 * cvMacro/cvMicro/cvRank/alertの各クエリはuserSourceExists()のEXISTS部分文文で
 * `FROM chat_sessions cs`(エイリアス付き)を副問い合わせとして含むため、
 * エイリアス無しの `FROM chat_sessions` (改行が続く)だけにマッチさせて区別する。
 */
function chatSessionSql(): string[] {
  return mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => /FROM\s+chat_sessions\s*\n/.test(s));
}
/** conversion_attributions を参照しているSQL(cvMacro/cvMicro/cvRank/alertの4本)だけを抜き出す */
function cvSql(): string[] {
  return mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => /FROM\s+conversion_attributions/.test(s));
}

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "development";
  process.env.ALLOW_INSECURE_DEV_AUTH = "1"; // [P1] dev-decode opt-in（署名検証スキップ）
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  app = express();
  app.use(express.json());
  registerAnalyticsSummaryRoutes(app, db);
});

describe("GET /v1/admin/tenants/:id/analytics-summary", () => {
  it("200を返す（実在しない列を参照して500にならない）", async () => {
    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  it("chat_sessions は started_at で絞る（created_at は存在しない列）", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = chatSessionSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).toMatch(/started_at\s*>=/);
      // chat_sessions 側の絞り込みに created_at を使っていないこと。
      // (conversion_attributions の created_at は実在するので、chat_sessions のSQLだけを見る)
      expect(sql).not.toMatch(/AND\s+created_at\s*>=/);
    }
  });

  it("PR-3 (GID 1216970103691946): chat_sessions のクエリにsource='user'絞り込みが入っている", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = chatSessionSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).toContain("chat_sessions.metadata->>'source' = 'user'");
    }
  });

  it("全クエリが tenant_id で絞られる（テナント越境しない）", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(mockQuery.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).toMatch(/tenant_id\s*=\s*\$1/);
      expect(call[1]).toContain("carnation");
    }
  });

  it("DBが列不存在エラーを返しても500で止まり、生のSQLエラーを漏らさない", async () => {
    mockQuery.mockRejectedValue(new Error('column "created_at" does not exist'));

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("does not exist");
  });

  it("未知のperiodでも既定(30日)にフォールバックし、例外にならない", async () => {
    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=not_a_period")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(allSql()).toMatch(/FROM\s+chat_sessions/);
  });

  // GID 1217810442450208: cvMacroRow/cvMicroRow/cvRankRow/alertRow の4クエリに
  // 実ユーザー判定(userSourceExists)が無く、e2e/chat-test 由来の
  // conversion_attributions を実CVと一緒に数えていた欠陥の回帰テスト。
  it("GID 1217810442450208: conversion_attributions の4クエリ全てにsource='user'絞り込みが入っている", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = cvSql();
    // cvMacroRow / cvMicroRow / cvRankRow / alertRow の4本が揃っていること
    expect(sqls.length).toBe(4);
    for (const sql of sqls) {
      expect(sql).toMatch(/metadata->>'source'\s*=\s*'user'/);
    }
  });

  // 結合列を固定しないと第3引数("id" vs "session_id")の誤りを検出できない。
  // conversion_attributions.session_id は chat_sessions.id(UUID)を参照するため、
  // 誤って第3引数を省略/"session_id"にすると cs.session_id(TEXT) = ...session_id(UUID) の
  // 暗黙キャスト不可で本番が全呼び出し500になる(PR #958で実証済み)。
  it("GID 1217810442450208: conversion_attributions の4クエリ全てが cs.id で結合している(第3引数=\"id\")", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = cvSql();
    expect(sqls.length).toBe(4);
    for (const sql of sqls) {
      expect(sql).toMatch(/cs\.id\s*=\s*conversion_attributions\.session_id/);
      expect(sql).not.toMatch(/cs\.session_id\s*=\s*conversion_attributions\.session_id/);
    }
  });

  // 2引数の ROUND() は numeric 版しか存在しない。COUNT(*)/float の結果
  // (double precision)をそのまま渡すと `function round(double precision, integer)
  // does not exist` で落ちる。started_at の修正後に実際に踏んだ二段目の不具合。
  it("ROUND に渡す前に numeric へキャストする（double precision のままだと落ちる）", async () => {
    await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    const sqls = chatSessionSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      if (!/ROUND\s*\(/i.test(sql)) continue;
      // ROUND(...) の第1引数が ::numeric でキャストされていること
      expect(sql).toMatch(/ROUND\s*\([\s\S]*?::numeric\s*,\s*\d+\s*\)/i);
      // float を直接 ROUND に渡す形に戻っていないこと
      expect(sql).not.toMatch(/ROUND\s*\(\s*COUNT\(\*\)\s*\/[^,]*,\s*\d+\s*\)/i);
    }
  });
});

// GID 1217969364194602 [H-7]: このタブはCV内訳(macro/micro/rank分布)・source不一致
// アラートまで返し、routes.ts の /v1/admin/analytics/conversions と同じ「成果分析」の
// 性質を持つのにplanゲートが一切無かった。conversion(Growth〜)を追加した回帰テスト。
describe("GET /v1/admin/tenants/:id/analytics-summary — plan ゲート", () => {
  it("client_admin + plan=starter → 403 plan_upgrade_required、以降のクエリは実行されない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=standard → 403(analyticsは開放済みだがconversionはGrowthのまま)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [] }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).not.toBe(403);
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});

// GID 1217969364194602 [H-7]: llm_usage.cost_jpy はPostHogの $ai_cost(LLM呼び出しの
// 原価)をJPY換算しただけの値で、テナントへの請求額ではない(costCalculator.ts の
// MARGIN_MULTIPLIER 参照)。client_adminに見せると粗利率を開示することになるため
// super_admin限定に絞った回帰テスト。
describe("GET /v1/admin/tenants/:id/analytics-summary — LLM原価はsuper_admin限定", () => {
  const mockedGetMonthlyLLMUsage = getMonthlyLLMUsageFromPostHog as jest.Mock;

  beforeEach(() => {
    mockedGetMonthlyLLMUsage.mockReset();
  });

  it("client_admin(plan=growthでplanゲート通過済み)にはllm_usageを返さず、PostHogも呼ばない", async () => {
    mockedGetMonthlyLLMUsage.mockResolvedValue({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      estimatedCostUsd: 1.23,
      totalGenerations: 3,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.llm_usage).toBeNull();
    expect(mockedGetMonthlyLLMUsage).not.toHaveBeenCalled();
  });

  // ★穴4: プランを上げても原価は開示しない(プランと原価開示は無関係という設計の固定)★
  // growthはconversionゲート(このエンドポイントが要求する最低プラン)を通過する最下段、
  // enterpriseは最上段。両端を見て「プランに関わらずclient_adminには一切出ない」ことを固定する。
  it.each(["growth", "enterprise"])(
    "client_admin(plan=%s)にはllm_usageを返さない(プランを上げてもcost_jpyは開示されない)",
    async (plan) => {
      mockedGetMonthlyLLMUsage.mockResolvedValue({
        totalInputTokens: 100,
        totalOutputTokens: 50,
        estimatedCostUsd: 1.23,
        totalGenerations: 3,
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ plan }] }); // plan確認
      mockQuery.mockResolvedValue({ rows: [] });

      const res = await request(app)
        .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.llm_usage).toBeNull();
      expect(mockedGetMonthlyLLMUsage).not.toHaveBeenCalled();
    },
  );

  it("super_adminにはllm_usage(原価)を返す", async () => {
    mockedGetMonthlyLLMUsage.mockResolvedValue({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      estimatedCostUsd: 1.23,
      totalGenerations: 3,
    });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.llm_usage).not.toBeNull();
    expect(res.body.llm_usage.cost_jpy).toBe(Math.round(1.23 * 150));
  });

  // ★穴4の是正: 上記のfindCostKeyPaths(denylist)は「costという名前を含むキー」しか
  // 見ておらず、原理的に弱い。margin/unit_price/provider_feeのような別名で漏れても、
  // 配列要素のようなキー名を持たない生の値が混ざっても素通りしてしまう。
  // tests/lp/planFeatureBulletInvariants.test.ts で実証済みの「denylist→allowlistへの
  // 反転」を踏襲し、レスポンスのキーパス全体をroleごとに固定する方式に置き換える
  // (denylist方式のテストは、この allowlist が完全に上位互換のため削除した)。
  //
  // キーパスの表現: ネストしたオブジェクトは "cv.macro.r2c_db" のようにドット区切りへ
  // 潰す。配列が絡む場合はインデックスを持たず "path[]" にまとめる(このレスポンスに
  // 現状配列は無いが、将来追加されたときにインデックス爆発を起こさないための決定。
  // 要素ごとの順序はこのテストの関心事ではなく、「どんな形のキーが出現し得るか」を
  // 固定したいだけ)。値がnullのキー(llm_usageの client_admin での見え方)は「キー自体は
  // 存在するが、それ以上は展開しない」ものとして扱う(実装(analyticsSummaryRoutes.ts)を
  // 確認済み: llmUsage は isSuperAdmin でなければ null がそのままJSONに載る。null は
  // typeof "object" だが値そのものなので、そこで再帰を止めれば自然にこの表現になる)。
  function collectKeyPaths(value: unknown, path = ""): Set<string> {
    const paths = new Set<string>();
    if (Array.isArray(value)) {
      const arrayPath = `${path}[]`;
      for (const item of value) {
        for (const p of collectKeyPaths(item, arrayPath)) paths.add(p);
      }
      return paths;
    }
    if (value === null || typeof value !== "object") return paths;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${key}` : key;
      paths.add(currentPath);
      for (const p of collectKeyPaths(v, currentPath)) paths.add(p);
    }
    return paths;
  }

  // super_adminに返す全キーパス(実装を正としてここに書き下す)。
  const SUPER_ADMIN_ALLOWED_KEY_PATHS: readonly string[] = [
    "period",
    "conversations",
    "conversations.total",
    "conversations.avg_per_day",
    "cv",
    "cv.macro",
    "cv.macro.r2c_db",
    "cv.macro.ga4",
    "cv.macro.posthog",
    "cv.macro.ranked_a",
    "cv.macro.ranked_d",
    "cv.micro",
    "cv.micro.r2c_db",
    "cv.micro.ga4",
    "cv.micro.posthog",
    "llm_usage",
    "llm_usage.tokens",
    "llm_usage.cost_jpy",
    "llm_usage.generations",
    "alerts",
    "alerts.source_mismatch_count",
    "alerts.ranked_d_count",
  ];

  // llm_usageの中身(原価)にのみ属するキーパス。client_adminのallowlistから
  // 機械的に除外するために使う(値を2箇所で決め打ちしない)。
  const LLM_USAGE_ONLY_PATHS = SUPER_ADMIN_ALLOWED_KEY_PATHS.filter((p) =>
    p.startsWith("llm_usage."),
  );

  // client_adminはsuper_adminと同じキーパス集合から、llm_usageの中身(原価)だけを
  // 除いたもの。"llm_usage" 自体は(値がnullでも)キーとして残るため除外しない。
  const CLIENT_ADMIN_ALLOWED_KEY_PATHS: readonly string[] =
    SUPER_ADMIN_ALLOWED_KEY_PATHS.filter((p) => !p.startsWith("llm_usage."));

  /**
   * 実際のキーパス集合とallowlistを突合する。allowlistに無いキーパスが1つでも
   * あれば「未知のもの」として即座に落ちる(denylistと違い、何が危険かを
   * 推測する必要がない)。
   */
  function assertExactKeyPaths(
    actual: Set<string>,
    allowed: readonly string[],
    label: string,
  ): void {
    const allowedSet = new Set(allowed);
    const extra = [...actual].filter((p) => !allowedSet.has(p)).sort();
    const missing = allowed.filter((p) => !actual.has(p)).sort();
    if (extra.length > 0) {
      throw new Error(
        `[${label}] 未分類のキーパスが増えた: [${extra.join(", ")}]。\n` +
          "新しいフィールドをレスポンスに追加した場合、super_admin限定にすべきかを判断した上で、" +
          "このファイル内のSUPER_ADMIN_ALLOWED_KEY_PATHS(client_adminにも見せるならCLIENT_ADMIN_ALLOWED_KEY_PATHSにも)に追記すること。",
      );
    }
    if (missing.length > 0) {
      throw new Error(
        `[${label}] allowlistにあるキーパスがレスポンスから消えた: [${missing.join(", ")}]。\n` +
          "意図した削除ならallowlist側からも削除すること。",
      );
    }
  }

  it("super_adminのレスポンスのキーパス集合がallowlistと完全一致する(未知のキーが無い)", async () => {
    mockedGetMonthlyLLMUsage.mockResolvedValue({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      estimatedCostUsd: 1.23,
      totalGenerations: 3,
    });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    assertExactKeyPaths(collectKeyPaths(res.body), SUPER_ADMIN_ALLOWED_KEY_PATHS, "super_admin");
  });

  it("client_adminのレスポンスのキーパス集合がallowlistと完全一致する(llm_usageの中身だけが無い)", async () => {
    mockedGetMonthlyLLMUsage.mockResolvedValue({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      estimatedCostUsd: 1.23,
      totalGenerations: 3,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    assertExactKeyPaths(collectKeyPaths(res.body), CLIENT_ADMIN_ALLOWED_KEY_PATHS, "client_admin");
  });

  it("super_adminとclient_adminのキーパス差分はllm_usageの中身(3キー)だけである", () => {
    // 「差がllm_usageだけであること」を明示的に固定する。将来super_admin限定の
    // フィールドが増えたら、それも意図した追加であることをここで宣言させるため、
    // 差分の中身そのものを検証する(件数だけの比較にしない)。
    const diff = SUPER_ADMIN_ALLOWED_KEY_PATHS.filter(
      (p) => !CLIENT_ADMIN_ALLOWED_KEY_PATHS.includes(p),
    ).sort();
    expect(diff).toEqual([...LLM_USAGE_ONLY_PATHS].sort());
    expect(diff.every((p) => p.startsWith("llm_usage."))).toBe(true);
  });
});
