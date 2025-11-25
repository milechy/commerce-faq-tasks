// src/agent/crew/CrewOrchestrator.ts

import { runDialogGraph } from "../orchestrator/langGraphOrchestrator";
import type { CrewAgentInput, CrewAgentOutput } from "./CrewAgent";

export class CrewOrchestrator {
  name = "CommerceAI Crew";

  async run(input: CrewAgentInput): Promise<CrewAgentOutput> {
    const out = await runDialogGraph({
      tenantId: "crew",
      userMessage: input.message,
      locale: "ja",
      conversationId: "crew-conv",
      history: input.history ?? [],
    });

    return {
      text: out.text,
      reasoning: out.plannerReasons?.join("\n"),
      meta: {
        route: out.route,
        plannerPlan: out.plannerPlan,
        salesMeta: out.salesMeta,
        ragStats: out.ragStats,
      },
    };
  }
}
