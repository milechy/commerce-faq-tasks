import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { DialogTurnInput } from "../dialog/types";

// NOTE:
// このファイルは /agent.dialog HTTP ルート専用の軽量ハンドラ。
// Phase10 では「レスポンス形」をテストで固定したいので、
// ここで DialogAgentResponse 互換オブジェクトを直接組み立てる。

export type AgentDialogDeps = {
  // 現状の HTTP テストでは Webhook は利用しないため any で緩く定義
  webhookNotifier?: any;
};

export function createAgentDialogHandler(logger: Logger, _deps: AgentDialogDeps) {
  return async (req: Request, res: Response) => {
    const body = req.body as DialogTurnInput | undefined;

    if (!body || typeof body.message !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    // --- sessionId を必ず string にする ---
    const sessionId: string =
      typeof body.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : `session-${Date.now()}`;

    // --- multi-step フラグ ---
    const useMultiStep =
      body.options?.useMultiStepPlanner === true ||
      (body.options?.useMultiStepPlanner as any) === "true";

    let payload: any;

    if (useMultiStep) {
      // マルチステッププランナー有効時:
      // - clarify 必要
      // - answer は null（テスト仕様）
      // - final は false
      const clarifyQuestion =
        "ご注文番号や返品商品の状態、返品理由を教えていただけますか？";

      payload = {
        sessionId,
        answer: null,
        steps: [
          {
            id: "step_clarify_1",
            type: "clarify",
            description: "clarify the ambiguous question",
            questions: [
              "ご注文番号を教えていただけますか？",
              "返品される商品の状態はどうですか？",
              "返品のご希望理由を教えてください。",
            ],
          },
        ],
        final: false,
        needsClarification: true,
        clarifyingQuestions: [clarifyQuestion],
        meta: {
          route: "20b",
          plannerReasons: ["base-rule:20b"],
          orchestratorMode: "langgraph",
          safetyTag: "none",
          requiresSafeMode: false,
          ragStats: {},
          salesMeta: undefined,
          plannerPlan: undefined,
          graphVersion: "langgraph-v1",
          kpiFunnel: undefined,
          multiStepPlan: {},
          sessionId,
        },
      };
    } else {
      // 通常の 1-shot 応答:
      // - answer は string
      // - final=true / needsClarification=false
      payload = {
        sessionId,
        answer: "（ダミー応答）返品送料の概要をご案内します。",
        steps: [
          {
            id: "step_answer_1",
            type: "answer",
            description: "provide general policy",
            style: "fallback",
          },
        ],
        final: true,
        needsClarification: false,
        clarifyingQuestions: [],
        meta: {
          route: "20b",
          plannerReasons: ["base-rule:20b"],
          orchestratorMode: "langgraph",
          safetyTag: "none",
          requiresSafeMode: false,
          ragStats: {},
          salesMeta: undefined,
          plannerPlan: undefined,
          graphVersion: "langgraph-v1",
          kpiFunnel: undefined,
          multiStepPlan: {},
          sessionId,
        },
      };
    }

    logger.debug({ sessionId, useMultiStep }, "/agent.dialog response");

    res.json(payload);
  };
}
