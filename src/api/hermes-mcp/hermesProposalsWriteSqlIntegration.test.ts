// src/api/hermes-mcp/hermesProposalsWriteSqlIntegration.test.ts
//
// POST /v1/hermes-mcp/proposals の書き込みを実 Postgres に対して検証する。
//
// CLAUDE.md(このディレクトリ)より:
//   「書き込みは E2E で検証できない。e2eWriteGuard が非GETを403にする。
//    結合テストで通すのが唯一の手段。」
// routes.test.ts はDBをモックしてSQL文字列/引数を見ているだけで、実際の
// (tenant_id, dedup_key) の部分一意インデックス(uniq_tuning_rules_tenant_dedup_key)
// がHermesの想定どおりに効くかは一度も実行されていない。ここでは
//   1) POSTした提案がGETで実際に読み戻せること(書いた後に読める)
//   2) 同じdedup_keyでもscope(tenant_id)が異なれば別提案として両方保存される
//      (一意制約が (tenant_id, dedup_key) の複合であること)
//   3) 同一テナント・同一dedup_keyの再投稿は実際のON CONFLICTでduplicate:trueになる
// を実DBで固定する。
//
// ★安全装置★ hermesConsentSqlIntegration.test.ts と同じ専用環境変数を使う。
import { Pool } from "pg";
import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { registerHermesMcpRoutes } from "./routes";

const DB_URL = process.env.HERMES_MCP_SQL_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

const API_KEY = "test-hermes-mcp-write-key";

let db: Pool;

jest.mock("../../lib/db", () => ({
  getPool: () => db,
}));

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

d("POST /v1/hermes-mcp/proposals — 書き込みの実DB検証", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tuning_rules RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, features) VALUES ('carnation', 'carnation', $1::jsonb)`,
      [JSON.stringify({ learning: { learn: true, share: true } })],
    );
    process.env.HERMES_MCP_API_KEY = API_KEY;
  });

  afterEach(() => {
    delete process.env.HERMES_MCP_API_KEY;
  });

  const TENANT_PROPOSAL = {
    scope: "tenant",
    tenant_id: "carnation",
    title: "保証訴求の改善",
    rationale: "会話ログから保証質問への回答が購入に繋がるパターンを確認",
    suggested_action: "保証訴求を初回応答に含める",
    dedup_key: "tenant:carnation:warranty-pitch",
  };

  it("POSTした提案が直後のGETで実際に読み戻せる(書き込みはE2Eで検証できないため結合テストで確認する)", async () => {
    const postRes = await authedPost("/v1/hermes-mcp/proposals", TENANT_PROPOSAL);
    expect(postRes.status).toBe(201);
    expect(postRes.body.duplicate).toBe(false);

    const getRes = await authedGet("/v1/hermes-mcp/proposals");
    expect(getRes.status).toBe(200);
    expect(getRes.body.proposals).toEqual([
      expect.objectContaining({
        proposal_id: postRes.body.proposal_id,
        tenant_id: "carnation",
        title: "保証訴求の改善",
        status: "pending",
        dedup_key: "tenant:carnation:warranty-pitch",
      }),
    ]);
  });

  it("同一テナント・同一dedup_keyの再投稿は実際のON CONFLICTでduplicate:trueになり、行は増えない", async () => {
    const first = await authedPost("/v1/hermes-mcp/proposals", TENANT_PROPOSAL);
    expect(first.status).toBe(201);

    const second = await authedPost("/v1/hermes-mcp/proposals", TENANT_PROPOSAL);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true });

    const count = await db.query("SELECT COUNT(*)::int AS n FROM tuning_rules");
    expect(count.rows[0]!.n).toBe(1);
  });

  it("同じdedup_keyでもscope(tenant_id)が異なれば一意制約に衝突せず両方保存される", async () => {
    const sharedDedupKey = "shared-insight-slug";

    const tenantRes = await authedPost("/v1/hermes-mcp/proposals", {
      ...TENANT_PROPOSAL,
      dedup_key: sharedDedupKey,
    });
    expect(tenantRes.status).toBe(201);
    expect(tenantRes.body.duplicate).toBe(false);

    const globalRes = await authedPost("/v1/hermes-mcp/proposals", {
      scope: "global",
      title: "心理原則scarcityの全体採用を検討",
      rationale: "複数の同意済みテナントで共通するパターンを確認",
      suggested_action: "デフォルト戦略に追加検討",
      dedup_key: sharedDedupKey,
    });
    expect(globalRes.status).toBe(201);
    expect(globalRes.body.duplicate).toBe(false);

    const rows = await db.query(
      "SELECT tenant_id, dedup_key FROM tuning_rules WHERE dedup_key = $1 ORDER BY tenant_id",
      [sharedDedupKey],
    );
    expect(rows.rows).toEqual([
      { tenant_id: "carnation", dedup_key: sharedDedupKey },
      { tenant_id: "global", dedup_key: sharedDedupKey },
    ]);
  });
});

/**
 * D8-2: アップセル提案が本番プロンプトへ混入しないことを、端から端まで実DBで固定する。
 *
 * ★ステータス列の更新だけを見ない★
 * 「承認したら status='active' になった」ことを確認しても、本番に効くかどうかは
 * is_active しか決めない(D8)。ここでは実際に getActiveRulesForTenant を呼び、
 * アップセル提案が返らないことまで確認する。
 *
 * 併せて、コード側の分岐が全部漏れた場合の最後の砦である
 * CHECK 制約 tuning_rules_upsell_never_active_check が実際に効くことも確認する。
 * これはモックDBでは原理的に検証できない。
 */
d("D8-2: アップセル提案は承認しても本番プロンプトに入らない（実DB）", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tuning_rules RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, plan, features) VALUES ('carnation', 'carnation', 'standard', $1::jsonb)`,
      [JSON.stringify({ learning: { learn: true, share: true } })],
    );
    process.env.HERMES_MCP_API_KEY = API_KEY;
  });

  afterEach(() => {
    delete process.env.HERMES_MCP_API_KEY;
  });

  const UPSELL = {
    scope: "tenant",
    tenant_id: "carnation",
    title: "会話が込み枠を超えています",
    rationale: "9月は込み枠1000会話に対して1500会話",
    suggested_action: "Growthプランへの変更を提案する",
    dedup_key: "tenant:carnation:upsell:202609",
    proposal_type: "upsell",
    upsell: {
      signal: "text_overage",
      current_plan: "standard",
      recommended_plan: "growth",
      period_yyyymm: "202609",
    },
  };

  it("★端から端まで: 投稿 → 承認 → getActiveRulesForTenant に載らない★", async () => {
    const { approveTuningRule } = await import("../admin/evaluations/evaluationsRepository");
    const { getActiveRulesForTenant, buildTuningPromptSection } =
      await import("../admin/tuning/tuningRulesRepository");

    // 1) 投稿: is_active=false / proposal_type='upsell' で着地する
    const post = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(post.status).toBe(201);
    const id = Number(post.body.proposal_id);

    const before = await db.query(
      `SELECT is_active, status, proposal_type, trigger_pattern FROM tuning_rules WHERE id = $1`, [id]);
    expect(before.rows[0]).toMatchObject({
      is_active: false, status: "pending", proposal_type: "upsell",
      trigger_pattern: "upsell:202609:text_overage",
    });

    // 2) 承認: status は active になるが is_active は false のまま
    const approved = await approveTuningRule(id, "carnation");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("active");
    expect(approved!.is_active).toBe(false);

    // 3) ★本番の読み出し経路に載らない★（ステータスだけ見て満足しない）
    const activeRules = await getActiveRulesForTenant("carnation");
    expect(activeRules.map((r) => r.id)).not.toContain(id);

    // 4) プロンプト文字列にも現れない（最終形で確認する）
    const prompt = buildTuningPromptSection(activeRules);
    expect(prompt).not.toContain("Growth");
    expect(prompt).not.toContain("upsell");
  });

  it("★CHECK 制約が最後の砦として効く（コード側の分岐が全部漏れても止まる）★", async () => {
    const post = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    const id = Number(post.body.proposal_id);

    await expect(
      db.query(`UPDATE tuning_rules SET is_active = true WHERE id = $1`, [id])
    ).rejects.toThrow(/tuning_rules_upsell_never_active_check|check constraint/i);
  });

  it("behavior 提案は従来どおり承認で本番プロンプトに入る（巻き添えにしない）", async () => {
    const { approveTuningRule } = await import("../admin/evaluations/evaluationsRepository");
    const { getActiveRulesForTenant } = await import("../admin/tuning/tuningRulesRepository");

    // 従来型(proposal_type 省略)。別 describe の定数を跨いで使わず、ここで定義する。
    const post = await authedPost("/v1/hermes-mcp/proposals", {
      scope: "tenant",
      tenant_id: "carnation",
      title: "保証訴求の改善",
      rationale: "会話ログから保証質問への回答が購入に繋がるパターンを確認",
      suggested_action: "保証訴求を初回応答に含める",
      dedup_key: "tenant:carnation:warranty-pitch",
    });
    const id = Number(post.body.proposal_id);

    const approved = await approveTuningRule(id, "carnation");
    expect(approved!.is_active).toBe(true);
    expect(approved!.proposal_type).toBe("behavior");

    const activeRules = await getActiveRulesForTenant("carnation");
    expect(activeRules.map((r) => r.id)).toContain(id);
  });

  it("★同月・同シグナルの再投稿は trigger_pattern の UNIQUE で弾かれ duplicate になる★", async () => {
    const first = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(first.status).toBe(201);

    // dedup_key を変えても trigger_pattern が同じなら 23505。
    // ON CONFLICT は (tenant_id, dedup_key) しか見ないため、ここを握らないと500になる。
    const second = await authedPost("/v1/hermes-mcp/proposals", {
      ...UPSELL, dedup_key: "tenant:carnation:upsell:202609:retry",
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true });

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tuning_rules WHERE proposal_type = 'upsell'`);
    expect(rows[0].n).toBe(1);
  });

  it("別月なら別提案として保存される（毎月の提案が潰し合わない）", async () => {
    await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    const oct = await authedPost("/v1/hermes-mcp/proposals", {
      ...UPSELL,
      dedup_key: "tenant:carnation:upsell:202610",
      upsell: { ...UPSELL.upsell, period_yyyymm: "202610" },
    });
    expect(oct.status).toBe(201);

    const { rows } = await db.query(
      `SELECT trigger_pattern FROM tuning_rules WHERE proposal_type='upsell' ORDER BY trigger_pattern`);
    expect(rows.map((r) => r.trigger_pattern)).toEqual([
      "upsell:202609:text_overage", "upsell:202610:text_overage",
    ]);
  });

  it("★listRules は既定で upsell を返さない（FAQ一覧に営業提案が混ざらない）★", async () => {
    const { listRules } = await import("../admin/tuning/tuningRulesRepository");

    await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    await authedPost("/v1/hermes-mcp/proposals", {
      scope: "tenant", tenant_id: "carnation",
      title: "保証訴求の改善", rationale: "根拠",
      suggested_action: "保証訴求を初回応答に含める",
      dedup_key: "tenant:carnation:warranty",
    });

    // 既定(フィルタ未指定) → behavior だけ
    const def = await listRules("carnation");
    expect(def.map((r) => r.trigger_pattern)).toEqual(["保証訴求の改善"]);

    // 明示的に upsell を求めた面だけが営業提案を受け取る
    const ups = await listRules("carnation", { proposalType: "upsell" });
    expect(ups.map((r) => r.trigger_pattern)).toEqual(["upsell:202609:text_overage"]);

    // all は両方
    const all = await listRules("carnation", { proposalType: "all" });
    expect(all).toHaveLength(2);
  });

  it("source フィルタと併用しても upsell は既定で除外される", async () => {
    const { listRules } = await import("../admin/tuning/tuningRulesRepository");
    await authedPost("/v1/hermes-mcp/proposals", UPSELL);

    // AIReportTab と同じ絞り込み(source=judge,hermes / status=pending)
    const rows = await listRules("carnation", {
      source: ["judge", "hermes"], status: "pending",
    });
    expect(rows).toHaveLength(0);
  });

  it("現プランと食い違う提案は409で保存されない", async () => {
    await db.query(`UPDATE tenants SET plan = 'growth' WHERE id = 'carnation'`);
    const res = await authedPost("/v1/hermes-mcp/proposals", UPSELL);
    expect(res.status).toBe(409);

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tuning_rules`);
    expect(rows[0].n).toBe(0);
  });
});

/**
 * 並行リクエストの実DB競合検証(2026-09-04 テスト強化)。
 *
 * routes.test.ts(モックDB)は「1回目成功→2回目 mockRejectedValueOnce で
 * 23505」という順序を人為的に作っているだけで、実際に2つのリクエストが
 * "同時に" 実行されたとき ON CONFLICT が本当に排他制御として機能するかは
 * 検証していない。Hermes は無人 cron から複数プロセス/複数タイミングで
 * 同じ提案を送りうるため、Promise.all で本物の競合を作って確認する。
 */
d("POST /v1/hermes-mcp/proposals — 並行リクエストの実DB競合", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tuning_rules RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, features) VALUES ('carnation', 'carnation', $1::jsonb)`,
      [JSON.stringify({ learning: { learn: true, share: true } })],
    );
    process.env.HERMES_MCP_API_KEY = API_KEY;
  });

  afterEach(() => {
    delete process.env.HERMES_MCP_API_KEY;
  });

  const PROPOSAL = {
    scope: "tenant", tenant_id: "carnation",
    title: "保証訴求の改善", rationale: "根拠",
    suggested_action: "保証訴求を初回応答に含める",
    dedup_key: "tenant:carnation:concurrent-test",
  };

  it("★同一 dedup_key を同時に10並列でPOSTしても、成功は1件だけで行も1件だけ★", async () => {
    // ★同一 app インスタンスに対して並行させる★
    // testServer ヘルパーは「異なる app への同時リクエスト」を検出すると例外を
    // 投げる安全装置を持つ(後勝ちで転送先が入れ替わり、誤った結果を静かに返す
    // 事故を防ぐため)。authedPost が呼び出しごとに makeApp() する実装のままだと
    // これに抵触するので、ここでは1つの app を使い回す。
    const app = makeApp();
    const post = (body: object) =>
      request(app).post("/v1/hermes-mcp/proposals").set("Authorization", `Bearer ${API_KEY}`).send(body);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post(PROPOSAL)),
    );

    const succeeded = results.filter((r) => r.status === 201 && r.body.duplicate === false);
    const duplicated = results.filter((r) => r.status === 200 && r.body.duplicate === true);

    expect(succeeded).toHaveLength(1);
    expect(duplicated).toHaveLength(9);
    // 500 が1件も無いこと(23505 が duplicate として正しく吸収されている)
    expect(results.every((r) => r.status !== 500)).toBe(true);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM tuning_rules WHERE dedup_key = $1`,
      [PROPOSAL.dedup_key],
    );
    expect(rows[0].n).toBe(1);
  });

  it("異なる dedup_key を同時に5並列でPOSTすると全件成功し、5行とも保存される", async () => {
    const app = makeApp();
    const post = (body: object) =>
      request(app).post("/v1/hermes-mcp/proposals").set("Authorization", `Bearer ${API_KEY}`).send(body);
    // ★title(=trigger_pattern)も一意にする★
    // uniq_tuning_rules_tenant_trigger (tenant_id, trigger_pattern) が別途効いており、
    // dedup_key を変えても trigger_pattern が同じなら 23505 → duplicate に丸められる
    // (これは既存仕様。routes.ts の該当コメント参照)。ここで確認したいのは
    // dedup_key 経路の並行成功なので、意図的に trigger_pattern も分ける。
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post({
          ...PROPOSAL,
          title: `保証訴求の改善-${i}`,
          dedup_key: `tenant:carnation:concurrent-${i}`,
        })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tuning_rules`);
    expect(rows[0].n).toBe(5);
  });
});

/**
 * 二重承認・二重却下の実DB競合検証(2026-09-04 テスト強化)。
 *
 * 管理画面で承認ボタンを二度連打する、または複数タブで同じ提案を開いて
 * 別々に承認するユーザー操作は現実的に起こりうる。approveTuningRule /
 * rejectTuningRule は「承認済みのものをもう一度承認する」を想定しているか、
 * 同時実行で不整合(is_active と status が食い違う等)が起きないかを確認する。
 */
d("D8-2: 承認/却下の二重実行（実DB）", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tuning_rules RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE tenants CASCADE");
    await db.query(
      `INSERT INTO tenants (id, name, plan, features) VALUES ('carnation', 'carnation', 'standard', $1::jsonb)`,
      [JSON.stringify({ learning: { learn: true, share: true } })],
    );
    process.env.HERMES_MCP_API_KEY = API_KEY;
  });

  afterEach(() => {
    delete process.env.HERMES_MCP_API_KEY;
  });

  it("★同じ upsell 提案を10並列で承認しても is_active は常に false のまま(CHECK制約 + D8-2導出が競合下でも守る)★", async () => {
    const { approveTuningRule } = await import("../admin/evaluations/evaluationsRepository");

    const post = await authedPost("/v1/hermes-mcp/proposals", {
      scope: "tenant", tenant_id: "carnation",
      title: "会話が込み枠を超えています", rationale: "根拠",
      suggested_action: "Growthプランへの変更を提案する",
      dedup_key: "tenant:carnation:upsell:concurrent-approve",
      proposal_type: "upsell",
      upsell: { signal: "text_overage", current_plan: "standard", recommended_plan: "growth", period_yyyymm: "202609" },
    });
    const id = Number(post.body.proposal_id);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => approveTuningRule(id, "carnation")),
    );

    // 全呼び出しが成功し、どの結果を見ても is_active=false(upsellが有効化されない)
    expect(results.every((r) => r !== null)).toBe(true);
    expect(results.every((r) => r!.is_active === false)).toBe(true);

    const { rows } = await db.query(`SELECT is_active, status FROM tuning_rules WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ is_active: false, status: "active" });
  });

  it("behavior 提案を承認→却下→承認と連続実行しても最終状態と is_active が食い違わない", async () => {
    const { approveTuningRule, rejectTuningRule } = await import("../admin/evaluations/evaluationsRepository");

    const post = await authedPost("/v1/hermes-mcp/proposals", {
      scope: "tenant", tenant_id: "carnation",
      title: "保証訴求の改善", rationale: "根拠",
      suggested_action: "保証訴求を初回応答に含める",
      dedup_key: "tenant:carnation:toggle-test",
    });
    const id = Number(post.body.proposal_id);

    await approveTuningRule(id, "carnation");
    await rejectTuningRule(id, "carnation");
    const final = await approveTuningRule(id, "carnation");

    expect(final!.status).toBe("active");
    expect(final!.is_active).toBe(true);

    const { rows } = await db.query(
      `SELECT is_active, status, approved_at, rejected_at FROM tuning_rules WHERE id = $1`, [id]);
    // D8: 最終的に承認状態なら rejected_at は NULL に戻っていること(承認↔却下の対称性)
    expect(rows[0].is_active).toBe(true);
    expect(rows[0].status).toBe("active");
    expect(rows[0].rejected_at).toBeNull();
    expect(rows[0].approved_at).not.toBeNull();
  });

  it("存在しないIDの承認は null を返し、例外を投げない(操作ミス・二重クリックで既に削除済み等)", async () => {
    const { approveTuningRule } = await import("../admin/evaluations/evaluationsRepository");
    const result = await approveTuningRule(999999, "carnation");
    expect(result).toBeNull();
  });

  it("他テナントのIDを承認しようとすると null(越境防止)", async () => {
    const { approveTuningRule } = await import("../admin/evaluations/evaluationsRepository");
    const post = await authedPost("/v1/hermes-mcp/proposals", {
      scope: "tenant", tenant_id: "carnation",
      title: "保証訴求の改善", rationale: "根拠",
      suggested_action: "保証訴求を初回応答に含める",
      dedup_key: "tenant:carnation:cross-tenant-test",
    });
    const id = Number(post.body.proposal_id);

    const result = await approveTuningRule(id, "other-tenant-not-owner");
    expect(result).toBeNull();

    // 越境試行後も元の行は pending のまま変化していない
    const { rows } = await db.query(`SELECT status, is_active FROM tuning_rules WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ status: "pending", is_active: false });
  });
});
