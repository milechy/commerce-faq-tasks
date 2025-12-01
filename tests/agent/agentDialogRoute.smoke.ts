

// tests/agent/agentDialogRoute.smoke.ts
//
// /agent.dialog ハンドラの LangGraph / Local 経路が DialogAgentResponse 形式で
// 応答することを確認するスモークテスト。

import type { Request, Response } from "express";
import pino from "pino";
import { createAgentDialogHandler } from "../../src/agent/http/agentDialogRoute";
import type { DialogAgentResponse } from "../../src/agent/dialog/types";

// runDialogTurn / runDialogGraph をモック
jest.mock("../../src/agent/dialog/dialogAgent", () => ({
  runDialogTurn: jest.fn(),
}));

jest.mock("../../src/agent/orchestrator/langGraphOrchestrator", () => ({
  runDialogGraph: jest.fn(),
}));

// モックのインポート
import { runDialogTurn } from "../../src/agent/dialog/dialogAgent";
import { runDialogGraph } from "../../src/agent/orchestrator/langGraphOrchestrator";

function createMockRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });

  const res = {
    json,
    status,
  } as unknown as Response;

  return { res, json, status };
}

function createMockReq(body: any): Request {
  const req = {
    body,
    header: (name: string) => {
      if (name.toLowerCase() === "x-tenant-id") return undefined;
      return undefined;
    },
  } as unknown as Request;

  return req;
}

describe("/agent.dialog handler (DialogAgentResponse compatibility)", () => {
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns DialogAgentResponse shape in local mode via runDialogTurn", async () => {
    // LangGraph を使わないローカルモード
    process.env.DIALOG_ORCHESTRATOR_MODE = "local";

    (runDialogTurn as jest.Mock).mockResolvedValue({
      sessionId: "local-session",
      answer: "local-answer",
      steps: [],
      final: true,
      needsClarification: false,
      clarifyingQuestions: [],
      meta: {
        route: "20b",
        plannerReasons: ["local-planner"],
        orchestratorMode: "local",
        graphVersion: "local-v0",
      },
    });

    const handler = createAgentDialogHandler(logger, {});
    const req = createMockReq({
      sessionId: "local-session",
      message: "hello",
      history: [],
    });
    const { res, json } = createMockRes();

    await handler(req, res);

    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][0] as DialogAgentResponse;

    // DialogAgentResponse の基本構造をチェック
    expect(payload).toHaveProperty("sessionId", "local-session");
    expect(payload).toHaveProperty("answer", "local-answer");
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(typeof payload.final).toBe("boolean");
    expect(typeof payload.needsClarification).toBe("boolean");
    expect(Array.isArray(payload.clarifyingQuestions)).toBe(true);
    expect(payload).toHaveProperty("meta");

    // meta の基本フィールド
    expect(payload.meta.route).toBe("20b");
    expect(Array.isArray(payload.meta.plannerReasons)).toBe(true);
    expect(payload.meta.orchestratorMode).toBe("local");
    expect(typeof payload.meta.graphVersion).toBe("string");
  });

  it("returns DialogAgentResponse shape in langgraph mode via runDialogGraph", async () => {
    process.env.DIALOG_ORCHESTRATOR_MODE = "langgraph";

    (runDialogGraph as jest.Mock).mockResolvedValue({
      text: "lg-answer",
      route: "120b",
      plannerReasons: ["lg-planner"],
      safetyTag: "safe",
      requiresSafeMode: false,
      ragStats: {
        searchMs: 10,
        rerankMs: 5,
        totalMs: 20,
      },
      salesMeta: {
        pipelineKind: "generic",
        upsellTriggered: false,
        ctaTriggered: false,
        notes: [],
      },
      graphVersion: "langgraph-v1",
      plannerPlan: {
        id: "plan-1",
        steps: [
          {
            id: "step-1",
            stage: "propose",
            title: "Propose something",
            description: "desc",
          },
        ],
        final: true,
        meta: {},
      },
    });

    const handler = createAgentDialogHandler(logger, {});
    const req = createMockReq({
      sessionId: "lg-session",
      message: "hello",
      history: [],
      options: {
        language: "ja",
      },
    });
    const { res, json } = createMockRes();

    await handler(req, res);

    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][0] as DialogAgentResponse;

    expect(payload.sessionId).toBe("lg-session");
    expect(payload.answer).toBe("lg-answer");
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(payload.steps[0]?.id).toBe("step-1");
    expect(payload.meta.route).toBe("120b");
    expect(payload.meta.graphVersion).toBe("langgraph-v1");

    // KPI ファネルも算出されているはず（propose -> consideration）
    expect(payload.meta.kpiFunnel).toBeDefined();
    expect(payload.meta.kpiFunnel?.currentStage).toBe("consideration");
  });
});