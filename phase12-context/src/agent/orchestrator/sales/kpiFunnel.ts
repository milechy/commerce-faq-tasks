// src/agent/orchestrator/sales/kpiFunnel.ts

import type {
  PlannerPlan,
  PlannerStep,
  SalesStage,
  KpiFunnelStage,
  KpiFunnelMeta,
} from "../../dialog/types";

const FUNNEL_ORDER: KpiFunnelStage[] = [
  "awareness",
  "consideration",
  "conversion",
];

function mapSalesStageToFunnel(stage: SalesStage): KpiFunnelStage {
  switch (stage) {
    case "clarify":
      return "awareness";
    case "propose":
    case "recommend":
      return "consideration";
    case "close":
      return "conversion";
  }
}

/**
 * PlannerPlan から KPI ファネル情報を計算するユーティリティ。
 * plan が undefined / null / steps 空 の場合は undefined を返し、meta.kpiFunnel 自体を省略できるようにする。
 */
export function computeKpiFunnelFromPlan(
  plan?: PlannerPlan | null,
): KpiFunnelMeta | undefined {
  if (!plan || !plan.steps || plan.steps.length === 0) return undefined;

  const stepsCountByStage: Record<KpiFunnelStage, number> = {
    awareness: 0,
    consideration: 0,
    conversion: 0,
  };

  for (const step of plan.steps as PlannerStep[]) {
    const funnelStage = mapSalesStageToFunnel(step.stage);
    stepsCountByStage[funnelStage] += 1;
  }

  const reachedStages: KpiFunnelStage[] = FUNNEL_ORDER.filter(
    (stage) => stepsCountByStage[stage] > 0,
  );

  let currentStage: KpiFunnelStage | undefined;
  for (const stage of FUNNEL_ORDER) {
    if (stepsCountByStage[stage] > 0) {
      currentStage = stage;
    }
  }

  if (!currentStage && reachedStages.length === 0) {
    return undefined;
  }

  return {
    currentStage,
    reachedStages,
    stepsCountByStage,
  };
}
