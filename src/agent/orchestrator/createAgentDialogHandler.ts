import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { DialogTurnInput } from "../dialog/types";
import { AgentDialogOrchestrator } from "./AgentDialogOrchestrator";
import {
  maybeProbeLemonSliceReadiness,
  type LemonSliceAdapterMeta,
} from "./presentation/lemonSliceAdapter";

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

    // ------------------------------------------------------------
    // Phase22 (PR2b): 接続層（UI/adapter）側の readiness/failed/fallback ログ
    // - presentation-only。失敗しても dialog 実行に影響させない
    // - UI は readiness 確認できたときのみ成功表示（= readiness_ok ログは成功時のみ）
    // - PII 導線では avatar を使わない（ここで判断できる場合は明示的に無効化）
    // ------------------------------------------------------------
    let adapterMeta: LemonSliceAdapterMeta | undefined;
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
        {
          tenantId,
          sessionId,
          locale,
          piiMode,
        },
        logger
      );
    } catch (e) {
      // adapter 側で readiness/failed/fallback のログは出している前提。
      // ここでは会話フローを壊さない（Phase22: failure-tolerant）
      logger.debug({ err: e }, "phase22.avatar.adapter.probe.unhandled");
    }

    const payload = await orchestrator.run({
      body,
      tenantId,
    });

    // ------------------------------------------------------------
    // Phase22 (PR2b): UI 側が参照する adapter 状態（disabled/fallback 等）を meta に載せる
    // - additive（既存のレスポンス形を壊さない）
    // - "ready" は probe 成功時のみ入る（UIが嘘をつかない）
    // ------------------------------------------------------------
    const next = payload as any;

    // payload.meta が無い/型固定でも壊さないよう any でマージ
    const prevMeta = (next.meta ?? {}) as Record<string, unknown>;
    const prevAdapter = (prevMeta.adapter ?? {}) as Record<string, unknown>;

    if (adapterMeta) {
      next.meta = {
        ...prevMeta,
        adapter: {
          ...prevAdapter,
          avatar: adapterMeta,
        },
      };
    }

    res.json(next);
  };
}
