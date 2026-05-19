import type { Request, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
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

    // Phase69-2: excluded_ids の入力検証（/agent.search と同等の上限）
    // null は undefined と同等（除外なし）として扱う
    const rawExcludedIds = (body.options as Record<string, unknown> | undefined)?.excluded_ids;
    if (rawExcludedIds != null) {
      const result = z.array(z.string()).max(500).safeParse(rawExcludedIds);
      if (!result.success) {
        res.status(400).json({ error: "invalid_excluded_ids", details: result.error.flatten() });
        return;
      }
    }

    const tenantId = (req as Request & { tenantId?: string }).tenantId ?? "demo-tenant";

    // Phase69-2: excluded_ids バリデーション（Zod 未導入のため手動チェック）
    const rawExcludedIds = (body as unknown as Record<string, unknown>).options
      ? ((body as unknown as Record<string, unknown>).options as Record<string, unknown>).excluded_ids
      : undefined;
    if (rawExcludedIds !== undefined) {
      if (!Array.isArray(rawExcludedIds)) {
        res.status(400).json({ error: "excluded_ids は配列で指定してください" });
        return;
      }
      if (rawExcludedIds.length > 500) {
        res.status(400).json({ error: "excluded_ids は500件以内で指定してください" });
        return;
      }
      const invalid = rawExcludedIds.find((el) => typeof el !== "string" || el.length > 200);
      if (invalid !== undefined) {
        res.status(400).json({ error: "excluded_ids の各要素は200文字以内の文字列で指定してください" });
        return;
      }
    }

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
