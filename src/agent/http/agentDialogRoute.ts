import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { DialogTurnInput } from "../dialog/types";
import { AgentDialogOrchestrator } from "./AgentDialogOrchestrator";
import { maybeProbeLemonSliceReadiness } from "./presentation/lemonSliceAdapter";

export type AgentDialogDeps = {
  webhookNotifier?: unknown;
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

    const tenantId = (req as Request & { tenantId?: string }).tenantId ?? "demo-tenant";

    // PR2b: adapter 状態（presentation-only）
    let adapterMeta: import("../dialog/types").AdapterMeta | undefined = undefined;

    try {
      const options = body.options ?? {};
      const locale: "ja" | "en" = options.language === "en" ? "en" : "ja";
      const bodyAny = body as unknown as Record<string, unknown>;
      const sessionId: string | undefined =
        typeof body.sessionId === "string"
          ? body.sessionId
          : typeof bodyAny.conversationId === "string"
          ? bodyAny.conversationId as string
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
