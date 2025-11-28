import type {
  CrewNode,
  CrewGraphState,
  CrewNodeContext,
} from "../CrewGraph";
import type { DialogAgentResponse } from "../../dialog/types";

/**
 * FinalNode
 * Planner / KPI などで組み立てられた CrewGraphState から
 * 最終的な DialogAgentResponse を構築して state.dialogResponse に格納する。
 */
export class FinalNode implements CrewNode {
  id = "final";
  kind = "final" as const;
  label = "FinalNode";

  async run(
    state: CrewGraphState,
    _ctx: CrewNodeContext,
  ): Promise<CrewGraphState> {
    const needsClarification = state.plannerPlan?.needsClarification ?? false;

    const response: DialogAgentResponse = {
      sessionId: state.input.sessionId ?? "unknown-session",
      answer: state.answerText ?? "",
      steps: state.plannerPlan?.steps ?? [],
      final: !needsClarification,
      needsClarification,
      clarifyingQuestions: state.plannerPlan?.clarifyingQuestions ?? [],
      meta: {
        ...state.meta,
      },
    };

    return {
      ...state,
      phase: "final",
      dialogResponse: response,
    };
  }
}