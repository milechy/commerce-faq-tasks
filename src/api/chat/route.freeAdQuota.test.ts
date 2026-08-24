// src/api/chat/route.freeAdQuota.test.ts
// /api/chat の free_ad プラン月次上限（Asana 1217759064329998）の回帰テスト。
//
// 上限判定そのもの(境界値・TZ非依存)は src/lib/billing/planQuota.test.ts が
// 純関数として固定している。ここでは「plan取得 → usage_logs集計 → 403分岐」の
// 配線が正しいこと、free_ad以外は既存動作が一切変わらないこと、
// DB障害時にfail-open(チャット全体を止めない)することを固定する。

import express from "express";
import request from "supertest";
import pino from "pino";

const mockSaveMessage = jest.fn().mockResolvedValue(undefined);
jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: (...args: unknown[]) => mockSaveMessage(...args),
}));

jest.mock("../admin/knowledge/knowledgeGapRepository", () => ({
  saveKnowledgeGap: jest.fn().mockResolvedValue(undefined),
}));

const mockTrackUsage = jest.fn();
jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));
jest.mock("../../lib/sentiment/client", () => ({
  analyzeSentiment: jest.fn().mockResolvedValue(null),
}));

const mockRunDialogTurn = jest.fn();
jest.mock("../../agent/dialog/dialogAgent", () => ({
  runDialogTurn: (...args: unknown[]) => mockRunDialogTurn(...args),
}));

jest.mock("../../agent/dialog/salesContextStore", () => ({
  getSalesSessionMeta: jest.fn().mockReturnValue(undefined),
}));

const mockGetTenantPlan = jest.fn();
jest.mock("../../lib/billing/planFeatures", () => ({
  getTenantPlan: (...args: unknown[]) => mockGetTenantPlan(...args),
}));

const mockPoolQuery = jest.fn();
jest.mock("../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
}));

import { createChatHandler } from "./route";
import { requestIdMiddleware } from "../../lib/request-id";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req: any, _res, next) => {
    req.tenantId = "tenant-1";
    req.lang = "ja";
    next();
  });
  app.post("/api/chat", createChatHandler(pino({ level: "silent" })));
  return app;
}

function countRow(count: number) {
  return { rows: [{ count: String(count) }] };
}

beforeEach(() => {
  mockSaveMessage.mockClear();
  mockTrackUsage.mockClear();
  mockGetTenantPlan.mockReset();
  mockPoolQuery.mockReset();
  mockRunDialogTurn.mockReset().mockResolvedValue({
    sessionId: "sess-1",
    answer: "ご質問ありがとうございます。",
    needsClarification: false,
    steps: [],
    final: true,
    meta: {},
  });
});

describe("POST /api/chat — free_ad プランの月次上限", () => {
  it("正常系: free_ad以外(starter)のテナントは usage_logs集計を一切見ずに通る(既存動作を変えない)", async () => {
    mockGetTenantPlan.mockResolvedValue("starter");

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockRunDialogTurn).toHaveBeenCalledTimes(1);
  });

  it("正常系: growth/enterpriseも同様にusage_logs集計を見ない", async () => {
    for (const plan of ["growth", "enterprise"]) {
      mockGetTenantPlan.mockResolvedValue(plan);
      const res = await request(makeApp())
        .post("/api/chat")
        .send({ message: "こんにちは" });
      expect(res.status).toBe(200);
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("正常系: free_ad かつ 上限未満(199件)なら通る", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(199));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockRunDialogTurn).toHaveBeenCalledTimes(1);
  });

  it("境界値: free_ad かつ ちょうど上限(200件)なら403 plan_upgrade_required", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(200));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    // 正常系の分岐であることを示す: 次の行動(プラン変更・翌月リセット)を案内する文言を含む
    expect(res.body.message).toEqual(expect.stringContaining("プラン"));
    // 上限到達時は本処理(LLM呼び出し等)に進まない
    expect(mockRunDialogTurn).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("境界値: 上限超過(201件)でも403", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(201));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(403);
  });

  it("集計クエリに tenant_id・feature_used='chat'・当月範囲が渡っている", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(0));

    await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining("feature_used = 'chat'"));
    expect(params[0]).toBe("tenant-1");
    expect(params[1]).toBeInstanceOf(Date);
    expect(params[2]).toBeInstanceOf(Date);
    expect((params[2] as Date).getTime()).toBeGreaterThan((params[1] as Date).getTime());
  });

  it("異常系(fail-open): getTenantPlanが例外を投げてもチャットは処理を続ける(全テナント停止を避ける)", async () => {
    mockGetTenantPlan.mockRejectedValue(new Error("pool not initialized"));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockRunDialogTurn).toHaveBeenCalledTimes(1);
  });

  it("異常系(fail-open): 集計クエリが例外を投げてもチャットは処理を続ける", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockRejectedValue(new Error("db timeout"));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockRunDialogTurn).toHaveBeenCalledTimes(1);
  });

  it("イレギュラー: 上限到達後も同じテナントが連続でリクエストすると毎回403になる(1回だけ許可、ではない)", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(250));

    const app = makeApp();
    const res1 = await request(app).post("/api/chat").send({ message: "1回目" });
    const res2 = await request(app).post("/api/chat").send({ message: "2回目" });

    expect(res1.status).toBe(403);
    expect(res2.status).toBe(403);
  });

  // ---------------------------------------------------------------------
  // 境界値・異常系: DB応答の形が想定と違う場合
  // ---------------------------------------------------------------------

  it("境界値: 集計クエリが空配列(rows:[])を返しても例外にならず0件扱いで通る", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockRunDialogTurn).toHaveBeenCalledTimes(1);
  });

  // COUNT(*)::text は実運用では必ず数字文字列を返すため通常発生しないが、
  // 万一クエリの列定義が変わって非数値が返っても「静かに壊れて全ブロック」に
  // ならないことを固定する。NaN比較は常にfalseになるため、isFreeAdMonthlyQuotaExceeded
  // 側の負数ガード(count<0)もすり抜けて「ブロックしない」側へ倒れる — 例外や
  // クラッシュにはならず、soft-gateとしてfail-open方向で一貫している。
  it("異常系: 集計値が非数値文字列でも例外を投げずfail-open(ブロックしない)側に倒れる", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue({ rows: [{ count: "not-a-number" }] });

    const res = await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    expect(res.status).toBe(200);
  });

  it("異常系: count列がnull/undefinedでも0件扱いで通る", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue({ rows: [{ count: null }] });

    const res = await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------
  // イレギュラー: plan文字列の表記ゆれ
  // ---------------------------------------------------------------------

  it("イレギュラー: 'Free_Ad'のような大文字小文字違いはfree_adと一致せず、通常テナントとして扱われる(集計クエリを見ない)", async () => {
    mockGetTenantPlan.mockResolvedValue("Free_Ad");
    mockPoolQuery.mockResolvedValue(countRow(999));

    const res = await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("イレギュラー: 前後に空白が付いた' free_ad 'は一致せず通常テナントとして扱われる", async () => {
    mockGetTenantPlan.mockResolvedValue(" free_ad ");
    mockPoolQuery.mockResolvedValue(countRow(999));

    const res = await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // イレギュラー: セッション中にプランが変わる（管理者がその場でアップグレード/変更）
  // ---------------------------------------------------------------------

  it("イレギュラー: 同一テナントで1回目free_ad(上限到達)→管理者がgrowthへ変更→2回目は即座に通る(planはリクエスト毎に再取得され、キャッシュされない)", async () => {
    const app = makeApp();

    mockGetTenantPlan.mockResolvedValueOnce("free_ad");
    mockPoolQuery.mockResolvedValueOnce(countRow(200));
    const res1 = await request(app).post("/api/chat").send({ message: "1回目" });
    expect(res1.status).toBe(403);

    mockGetTenantPlan.mockResolvedValueOnce("growth");
    const res2 = await request(app).post("/api/chat").send({ message: "2回目" });
    expect(res2.status).toBe(200);
    // growth判定時はusage_logs集計を追加で見ない(1回目の1コールのみのまま)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("イレギュラー: 1回目starter(素通り)→管理者がfree_adへ変更(既に上限超過)→2回目は即座に403になる", async () => {
    const app = makeApp();

    mockGetTenantPlan.mockResolvedValueOnce("starter");
    const res1 = await request(app).post("/api/chat").send({ message: "1回目" });
    expect(res1.status).toBe(200);

    mockGetTenantPlan.mockResolvedValueOnce("free_ad");
    mockPoolQuery.mockResolvedValueOnce(countRow(300));
    const res2 = await request(app).post("/api/chat").send({ message: "2回目" });
    expect(res2.status).toBe(403);
  });

  // ---------------------------------------------------------------------
  // 既知のリスク: fire-and-forget trackUsage による並行リクエストの競合
  // ---------------------------------------------------------------------
  //
  // trackUsage は setImmediate の fire-and-forget であり、判定時点ではまだ
  // usage_logs へINSERTされていない(route.ts のコメント参照)。そのため、
  // 同一テナントから閾値ちょうど手前で複数リクエストがほぼ同時に来ると、
  // 両方とも「まだ199件」を見て両方許可され、結果的に上限を超える。
  // これはソフトなコスト制御ガードとして許容している設計上のトレードオフだが、
  // 「壊れない」ことと「意図どおりの挙動」であることの両方をテストで固定する
  // (将来ここを厳密な原子的カウンタに変更する場合の比較対象にもなる)。
  it("既知のリスク(意図的に許容): 上限直前で2つのリクエストがほぼ同時に来ると、両方とも199件を見て両方許可される(合計は201件になり得る)", async () => {
    const app = makeApp();
    mockGetTenantPlan.mockResolvedValue("free_ad");
    // 2リクエストとも同じスナップショット(199件)を見る — fire-and-forgetのため
    // 1本目のtrackUsageがまだusage_logsに反映されていない状況を模す。
    mockPoolQuery.mockResolvedValue(countRow(199));

    const [res1, res2] = await Promise.all([
      request(app).post("/api/chat").send({ message: "並行1" }),
      request(app).post("/api/chat").send({ message: "並行2" }),
    ]);

    // 両方とも許可される(=合計は201件相当になり得る、上限200を1件超える)。
    // これは既知の設計上の許容範囲であり、バグとして再発見しないようにテストで残す。
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  // ---------------------------------------------------------------------
  // イレギュラー: SQLインジェクション類の文字列を含むtenantId
  // ---------------------------------------------------------------------

  it("イレギュラー: tenantIdに引用符やSQL断片が含まれても集計クエリはパラメータ化されており、そのまま$1として渡る", async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantId = "tenant-1'; DROP TABLE tenants;--";
      req.lang = "ja";
      next();
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createChatHandler: freshHandler } = require("./route") as typeof import("./route");
    app.post("/api/chat", freshHandler(pino({ level: "silent" })));

    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(0));

    const res = await request(app).post("/api/chat").send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    // 文字列連結ではなくバインドパラメータとしてそのまま渡っている(エスケープ不要)
    expect(params[0]).toBe("tenant-1'; DROP TABLE tenants;--");
  });
});

// ---------------------------------------------------------------------
// 月境界ちょうどのリクエスト(実際の /api/chat 経由の統合テスト)
// ---------------------------------------------------------------------
//
// 境界値の正しさ自体は src/lib/billing/planQuota.test.ts が純関数として
// 網羅済み。ここでは「route.ts が現在時刻を正しく getMonthRangeJst へ渡し、
// 集計クエリの monthStart/monthEnd に反映されること」という配線を、
// jest.useFakeTimers() で時刻を固定した実際のHTTPリクエスト経由で確認する。
describe("POST /api/chat — free_ad 月境界ちょうどのリクエスト(実ルート経由)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("JST月末23:59:59.999ちょうどのリクエストは当月の範囲で集計される", async () => {
    jest.useFakeTimers({ now: new Date("2026-08-31T14:59:59.999Z") }); // JST 2026-08-31 23:59:59.999
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(0));

    const res = await request(makeApp()).post("/api/chat").send({ message: "月末ぎりぎり" });

    expect(res.status).toBe(200);
    const [, params] = mockPoolQuery.mock.calls[0] as [string, [string, Date, Date]];
    expect(params[1].toISOString()).toBe("2026-07-31T15:00:00.000Z"); // 8月1日 00:00 JST
    expect(params[2].toISOString()).toBe("2026-08-31T15:00:00.000Z"); // 9月1日 00:00 JST
  });

  it("JST翌月00:00:00.000ちょうどのリクエストは新しい月の範囲で集計される(前の月のカウントを引き継がない)", async () => {
    jest.useFakeTimers({ now: new Date("2026-08-31T15:00:00.000Z") }); // JST 2026-09-01 00:00:00.000
    mockGetTenantPlan.mockResolvedValue("free_ad");
    mockPoolQuery.mockResolvedValue(countRow(0));

    const res = await request(makeApp()).post("/api/chat").send({ message: "月またぎ直後" });

    expect(res.status).toBe(200);
    const [, params] = mockPoolQuery.mock.calls[0] as [string, [string, Date, Date]];
    expect(params[1].toISOString()).toBe("2026-08-31T15:00:00.000Z"); // 9月1日 00:00 JST
    expect(params[2].toISOString()).toBe("2026-09-30T15:00:00.000Z"); // 10月1日 00:00 JST
  });

  it("月末ぎりぎりに前月分で上限到達していたテナントが、翌月00:00の瞬間に新しい月としてリセットされ通る", async () => {
    mockGetTenantPlan.mockResolvedValue("free_ad");

    jest.useFakeTimers({ now: new Date("2026-08-31T14:59:59.999Z") });
    mockPoolQuery.mockResolvedValueOnce(countRow(200)); // 前月分は上限到達
    const resBeforeMidnight = await request(makeApp()).post("/api/chat").send({ message: "月末" });
    expect(resBeforeMidnight.status).toBe(403);

    jest.setSystemTime(new Date("2026-08-31T15:00:00.000Z")); // 日付をまたぐ
    mockPoolQuery.mockResolvedValueOnce(countRow(0)); // 新しい月はまだ0件
    const resAfterMidnight = await request(makeApp()).post("/api/chat").send({ message: "月初" });
    expect(resAfterMidnight.status).toBe(200);
  });
});
