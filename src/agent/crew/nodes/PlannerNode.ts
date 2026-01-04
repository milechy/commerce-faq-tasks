import { runDialogGraph } from "../../orchestrator/langGraphOrchestrator";
import type { CrewGraphState, CrewNode, CrewNodeContext } from "../CrewGraph";

export class PlannerNode implements CrewNode {
  id: string;
  kind = "planner" as const;
  label?: string;

  constructor(opts: { id?: string; label?: string } = {}) {
    this.id = opts.id ?? "planner";
    this.label = opts.label ?? "PlannerNode";
  }

  async run(
    state: CrewGraphState,
    ctx: CrewNodeContext
  ): Promise<CrewGraphState> {
    const { input, meta } = state;

    const tenantId = input.tenantId ?? "crew";
    const locale = input.locale ?? "ja";

    const conversationId =
      input.sessionId ?? `${ctx.graphId}:${tenantId ?? "default"}`;

    const out = await runDialogGraph({
      tenantId,
      userMessage: input.message,
      locale: locale as "ja" | "en",
      conversationId,
      history: input.history,
    });

    return {
      ...state,
      phase: "planner",
      plannerPlan: out.plannerPlan,
      answerText: out.text,
      meta: {
        ...meta,
        route: out.route,
        plannerReasons: out.plannerReasons ?? meta.plannerReasons ?? [],
        orchestratorMode: "crewgraph",
        safetyTag: out.safetyTag ?? meta.safetyTag,
        requiresSafeMode:
          typeof out.requiresSafeMode === "boolean"
            ? out.requiresSafeMode
            : meta.requiresSafeMode,
        ragStats: out.ragStats ?? meta.ragStats,
        salesMeta: out.salesMeta ?? meta.salesMeta,
        plannerPlan: out.plannerPlan,
        graphVersion: (out as any).graphVersion ?? "langgraph-v1",
        kpiFunnel: meta.kpiFunnel,
      },
    };
  }
}
