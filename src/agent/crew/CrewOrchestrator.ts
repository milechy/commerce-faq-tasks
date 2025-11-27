import type { CrewAgentInput, CrewAgentOutput } from "./CrewAgent";
import type { DialogAgentMeta } from "../dialog/types";
import { computeKpiFunnelFromPlan } from "../orchestrator/sales/kpiFunnel";
import { runCrewGraph } from "./CrewGraph";
import type { CrewGraphState, CrewGraphDefinition } from "./CrewGraph";
import { InputNode } from "./nodes/InputNode";
import { PlannerNode } from "./nodes/PlannerNode";
import { FinalNode } from "./nodes/FinalNode";
import { KpiNode } from "./nodes/KpiNode";

export class CrewOrchestrator {
  name = "CommerceAI Crew";

  private graph: CrewGraphDefinition = {
    id: "crew-dialog-graph-v1",
    entryNodeId: "input",
    nodes: [new InputNode(), new PlannerNode(), new KpiNode(), new FinalNode()],
  };

  async run(input: CrewAgentInput): Promise<CrewAgentOutput> {
    const initialState: CrewGraphState = {
      phase: "input",
      input: {
        message: input.message,
        history: input.history ?? [],
        locale: input.context?.locale ?? "ja",
        tenantId: input.context?.tenantId,
        sessionId: input.context?.sessionId,
      },
      plannerPlan: undefined,
      answerText: undefined,
      meta: {
        route: "20b",
        plannerReasons: [],
        orchestratorMode: "crewgraph",
        safetyTag: undefined,
        requiresSafeMode: undefined,
        ragStats: undefined,
        salesMeta: undefined,
        plannerPlan: undefined,
        graphVersion: "crewgraph-v1",
        kpiFunnel: undefined,
      },
      dialogResponse: undefined,
    };

    const finalState = await runCrewGraph(this.graph, initialState, {
      graphId: this.graph.id,
    });

    const kpiFunnel =
      computeKpiFunnelFromPlan(finalState.plannerPlan) ??
      finalState.meta.kpiFunnel;

    const meta: DialogAgentMeta = {
      ...finalState.meta,
      kpiFunnel,
    };

    const answer =
      finalState.dialogResponse?.answer ?? finalState.answerText ?? "";

    const reasoning = meta.plannerReasons.join("\n");

    return {
      text: answer,
      reasoning,
      meta,
    };
  }
}
