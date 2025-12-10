import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { DialogTurnInput } from "../dialog/types";
import { AgentDialogOrchestrator } from "./AgentDialogOrchestrator";

// NOTE:
// このファイルは /agent.dialog HTTP ルート専用の軽量ハンドラ。
// Phase10 では「レスポンス形」をテストで固定したいので、
// ここで DialogAgentResponse 互換オブジェクトを直接組み立てる。

export type AgentDialogDeps = {
  // 現状の HTTP テストでは Webhook は利用しないため any で緩く定義
  webhookNotifier?: any;
};

export function createAgentDialogHandler(
  logger: Logger,
  _deps: AgentDialogDeps
) {
  // Phase11: /agent.dialog は AgentDialogOrchestrator 経由で LangGraph / CrewGraph を実行する。
  const orchestrator = new AgentDialogOrchestrator(logger);

  return async (req: Request, res: Response) => {
    // NOTE: body は DialogTurnInput としてそのまま Orchestrator に渡す（options.personaTags なども含む）
    const body = req.body as DialogTurnInput | undefined;

    if (!body || typeof body.message !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const tenantId = (req as any).tenantId ?? "demo-tenant";

    const payload = await orchestrator.run({
      body,
      tenantId,
    });

    res.json(payload);
  };
}
