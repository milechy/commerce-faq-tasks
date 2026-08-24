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
});
