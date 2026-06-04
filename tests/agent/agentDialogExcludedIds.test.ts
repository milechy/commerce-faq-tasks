// tests/agent/agentDialogExcludedIds.test.ts
// Phase69-2 Round 5 (Codex Round 5 MEDIUM): dialog excluded_ids 入力検証テスト

import express from "express";
import * as http from "http";
import { createAgentDialogHandler } from "../../src/agent/http/agentDialogRoute";
import pino from "pino";

// AgentDialogOrchestrator の run をモック — バリデーション以降の LLM 呼び出しを抑制
jest.mock("../../src/agent/http/AgentDialogOrchestrator", () => ({
  AgentDialogOrchestrator: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({
      answer: "mock answer",
      steps: [],
      sessionId: "mock-session",
      needsClarification: false,
      clarifyingQuestions: [],
      meta: {
        route: "20b",
        plannerReasons: [],
        orchestratorMode: "langgraph",
        safetyTag: "none",
        requiresSafeMode: false,
        ragStats: {},
        salesMeta: undefined,
        plannerPlan: undefined,
        graphVersion: "langgraph-v1",
        kpiFunnel: undefined,
        multiStepPlan: {},
        sessionId: "mock-session",
        adapter: { status: "disabled", provider: "none" },
      },
    }),
  })),
}));

// maybeProbeLemonSliceReadiness もモック
jest.mock("../../src/agent/http/presentation/lemonSliceAdapter", () => ({
  maybeProbeLemonSliceReadiness: jest.fn().mockResolvedValue({
    status: "disabled",
    provider: "none",
  }),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  const logger = pino({ level: "silent" });
  const handler = createAgentDialogHandler(logger, {});
  app.post("/dialog/turn", handler);
  return app;
}

function request(
  app: ReturnType<typeof buildApp>,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          method: "POST",
          path: "/dialog/turn",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.write(bodyStr);
      req.end();
    });
  });
}

describe("dialog /dialog/turn — excluded_ids バリデーション (Phase69-2 Round 5)", () => {
  it("excluded_ids が 501 件超過の場合 400 を返す", async () => {
    const app = buildApp();
    const oversized = Array.from({ length: 501 }, (_, i) => String(i));
    const res = await request(app, {
      message: "test query",
      options: { excluded_ids: oversized },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_excluded_ids");
  });

  it("excluded_ids が 500 件以下の場合は通常処理 (200) される", async () => {
    const app = buildApp();
    const withinLimit = Array.from({ length: 500 }, (_, i) => String(i));
    const res = await request(app, {
      message: "test query",
      options: { excluded_ids: withinLimit },
    });
    expect(res.status).toBe(200);
  });

  it("excluded_ids が undefined / null / 空配列でも 400 にならない", async () => {
    const app = buildApp();

    const resUndef = await request(app, {
      message: "test query",
      options: {},
    });
    expect(resUndef.status).toBe(200);

    const resEmpty = await request(app, {
      message: "test query",
      options: { excluded_ids: [] },
    });
    expect(resEmpty.status).toBe(200);
  });
});
