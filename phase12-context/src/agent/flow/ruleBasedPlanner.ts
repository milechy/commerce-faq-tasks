

// src/agent/flow/ruleBasedPlanner.ts
//
// Rule-based dialog planner (skeleton).
// Phase11 ではまだ実際のロジックは実装せず、PlannerPlan を返すための
// インターフェースのみ定義しておく。
//
// 今後、shipping / returns / payment / product-info などの典型 FAQ については、
// ここでルールベースに PlannerPlan を構築し、LLM Planner の呼び出し頻度を
// 減らして p95 レイテンシを削減する想定。

import type { PlannerPlan } from "../dialog/types";
import type { DialogInput } from "../orchestrator/langGraphOrchestrator";

/**
 * ルールベースの PlannerPlan を構築するエントリポイント。
 *
 * Phase11 時点ではまだ実装は行わず、常に null を返して LLM Planner に
 * フォールバックさせる。これにより、インターフェースだけ先に固定しておき、
 * Phase12 以降で shipping / returns などの定型問い合わせに対する
 * Rule-based Planner を段階的に追加できる。
 *
 * @param input DialogInput (/agent.dialog の入力サマリ)
 * @param intent detectIntentHint で推定した intent ヒント
 * @returns PlannerPlan が構築できた場合はその値。未対応 intent などの場合は null。
 */
export function buildRuleBasedPlan(
  input: DialogInput,
  intent: string,
): PlannerPlan | null {
  // NOTE:
  // - Phase11 では挙動を一切変えないため、ここでは常に null を返す。
  // - 将来的には intent ごとに buildShippingPlan / buildReturnsPlan などを
  //   実装し、PlannerPlan を返すように拡張する。

  void input;
  void intent;

  return null;
}