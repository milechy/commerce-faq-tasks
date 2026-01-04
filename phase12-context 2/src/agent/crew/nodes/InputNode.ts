import type { CrewGraphState, CrewNode, CrewNodeContext } from "../CrewGraph";

/**
 * InputNode
 * CrewGraph のエントリーポイント。
 * ここでは特に加工は行わず、phase を "input" にセットするだけの薄いノード。
 */
export class InputNode implements CrewNode {
  id = "input";
  kind = "input" as const;
  label = "InputNode";

  async run(
    state: CrewGraphState,
    _ctx: CrewNodeContext
  ): Promise<CrewGraphState> {
    return {
      ...state,
      phase: "input",
    };
  }
}
