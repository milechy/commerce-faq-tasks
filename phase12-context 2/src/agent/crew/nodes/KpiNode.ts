import type {
  CrewNode,
  CrewGraphState,
  CrewNodeContext,
} from "../CrewGraph";
import { computeKpiFunnelFromPlan } from "../../orchestrator/sales/kpiFunnel";

export class KpiNode implements CrewNode {
  id: string;
  kind = "kpi" as const;
  label?: string;

  constructor(opts: { id?: string; label?: string } = {}) {
    this.id = opts.id ?? "kpi";
    this.label = opts.label ?? "KpiNode";
  }

  async run(
    state: CrewGraphState,
    _ctx: CrewNodeContext,
  ): Promise<CrewGraphState> {
    const kpiFunnel = computeKpiFunnelFromPlan(state.plannerPlan);

    return {
      ...state,
      phase: "kpi",
      meta: {
        ...state.meta,
        kpiFunnel,
      },
    };
  }
}
