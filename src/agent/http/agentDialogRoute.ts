import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { DialogTurnInput } from "../dialog/types";
import { AgentDialogOrchestrator } from "./AgentDialogOrchestrator";
import { maybeProbeLemonSliceReadiness } from "./presentation/lemonSliceAdapter";

export type AgentDialogDeps = {
  webhookNotifier?: any;
};

export function createAgentDialogHandler(
  logger: Logger,
  _deps: AgentDialogDeps
) {
  const orchestrator = new AgentDialogOrchestrator(logger);

  return async (req: Request, res: Response) => {
    const body = req.body as DialogTurnInput | undefined;

    if (!body || typeof body.message !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const tenantId = (req as any).tenantId ?? "demo-tenant";

    // PR2b: adapter 状態（presentation-only）
    let adapterMeta: any = undefined;

    try {
      const options = (body as any).options ?? {};
      const locale: "ja" | "en" = options.language === "en" ? "en" : "ja";
      const sessionId: string | undefined =
        typeof (body as any).sessionId === "string"
          ? (body as any).sessionId
          : typeof (body as any).conversationId === "string"
          ? (body as any).conversationId
          : undefined;

      const piiMode = options.piiMode === true;

      adapterMeta = await maybeProbeLemonSliceReadiness(
        { tenantId, sessionId, locale, piiMode },
        logger
      );
    } catch (e) {
      // failure-tolerant: dialog 実行を壊さない
      logger.debug({ err: e }, "phase22.avatar.adapter.probe.unhandled");
      adapterMeta = undefined;
    }

    const payload = await orchestrator.run({
      body,
      tenantId,
      adapterMeta,
    });

    res.json(payload);
  };
}
