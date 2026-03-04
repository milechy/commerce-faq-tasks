

// src/agent/crew/CrewGraph.ts
//
// CrewGraph の基盤となる型定義と、シンプルな直列実行ランナー。
// Phase10 では、「LangGraph を含む最小限の CrewGraph」を構築するための
// 骨組みとして利用する。
import type {
  PlannerPlan,
  DialogAgentMeta,
  DialogAgentResponse,
} from "../dialog/types";

/**
 * CrewGraph 内での処理フェーズ。
 * v1 では線形な遷移を前提としており、将来的に分岐やループを導入する余地を残している。
 */
export type CrewGraphPhase = "input" | "planner" | "sales" | "kpi" | "final";

/**
 * CrewGraph 全体で共有されるステート。
 * 各ノードは CrewGraphState を受け取り、更新した CrewGraphState を返す。
 */
export interface CrewGraphState {
  phase: CrewGraphPhase;

  // 入力（ユーザーメッセージ / 履歴 / ロケールなど）
  input: {
    message: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    locale: string;
    tenantId?: string;
    sessionId?: string;
  };

  // プランナーが生成したプラン（LangGraph / CrewGraph いずれでも可）
  plannerPlan?: PlannerPlan;

  // モデルが生成した最終回答テキスト
  answerText?: string;

  // /agent.dialog と共通のメタ情報
  meta: DialogAgentMeta;

  // グラフの最終段階で組み立てられる DialogAgentResponse
  dialogResponse?: DialogAgentResponse;
}

/**
 * ノードの種類。
 * Phase10 の v1 では input -> planner -> sales -> kpi -> final のような
 * シンプルな直列構成を想定する。
 */
export type CrewNodeKind = "input" | "planner" | "sales" | "kpi" | "final";

/**
 * ノード実行時に渡されるコンテキスト。
 * ログ用の graphId など、将来的に外部依存を差し込むための拡張ポイントとする。
 */
export interface CrewNodeContext {
  graphId: string;
}

/**
 * CrewGraph の各ノード。
 * run は CrewGraphState を受け取り、更新した CrewGraphState を返す。
 */
export interface CrewNode {
  id: string;
  kind: CrewNodeKind;
  label?: string;

  run(state: CrewGraphState, ctx: CrewNodeContext): Promise<CrewGraphState>;
}

/**
 * CrewGraph 自体の定義。
 * Phase10 では nodes を配列で保持し、entryNodeId 以降を直列実行する構造とする。
 */
export interface CrewGraphDefinition {
  id: string;
  entryNodeId: string;
  nodes: CrewNode[];
}

/**
 * CrewGraph を実行するシンプルなランナー。
 *
 * v1 の仕様:
 * - entryNodeId に一致するノードを起点として、以降の nodes を順番に実行する
 * - 各ノードの実行後、state.phase が "final" になったらそこで終了する
 */
export async function runCrewGraph(
  graph: CrewGraphDefinition,
  initialState: CrewGraphState,
  ctx: CrewNodeContext,
): Promise<CrewGraphState> {
  const startIndex = graph.nodes.findIndex(
    (node) => node.id === graph.entryNodeId,
  );

  if (startIndex === -1) {
    throw new Error(
      `CrewGraph "${graph.id}" does not contain entryNodeId "${graph.entryNodeId}"`,
    );
  }

  let state = initialState;

  for (let i = startIndex; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    state = await node.run(state, ctx);

    if (state.phase === "final") {
      break;
    }
  }

  return state;
}