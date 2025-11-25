// src/agent/orchestrator/sales/salesPipeline.ts

import { PlannerPlan } from "../../dialog/types";
import { getSalesRules, type SalesRules } from "./salesRules";

export type SalesMeta = {
  upsellTriggered?: boolean;
  ctaTriggered?: boolean;
  notes?: string[];
};

export type SalesDetectionContext = {
  userMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  plan?: PlannerPlan;
};

/**
 * PlannerPlan（SalesStage）ベースのアップセル検出。
 */
function detectUpsellFromPlan(
  plan: PlannerPlan | undefined,
  rules: SalesRules
): {
  triggered: boolean;
  notes: string[];
} {
  if (!plan || !Array.isArray(plan.steps)) {
    return { triggered: false, notes: [] };
  }

  let triggered = false;
  const notes: string[] = [];

  for (const step of plan.steps as any[]) {
    const stage = step?.stage;
    const title = String(step?.title ?? "");
    const description = String(step?.description ?? "");
    const textForStep = `${title} ${description}`.toLowerCase();

    if (stage !== "recommend") continue;

    const hasPremiumHint = rules.premiumHints.some((k) =>
      textForStep.includes(k.toLowerCase())
    );
    const hasProducts =
      Array.isArray(step.productIds) && step.productIds.length > 0;

    if (hasPremiumHint || hasProducts) {
      triggered = true;
      notes.push("planner:recommend-with-upsell-hint");
    }
  }

  return { triggered, notes };
}

/**
 * PlannerPlan（SalesStage）ベースの CTA 検出。
 */
function detectCtaFromPlan(
  plan: PlannerPlan | undefined,
  _rules: SalesRules
): {
  triggered: boolean;
  notes: string[];
} {
  if (!plan || !Array.isArray(plan.steps)) {
    return { triggered: false, notes: [] };
  }

  let triggered = false;
  const notes: string[] = [];

  for (const step of plan.steps as any[]) {
    const stage = step?.stage;
    const cta = step?.cta;

    if (stage === "close" && cta) {
      triggered = true;
      notes.push(`planner:cta:${String(cta)}`);
    }
  }

  return { triggered, notes };
}

/**
 * ユーザー発話テキストベースのアップセル判定（簡易キーワード）。
 */
function detectUpsellFromText(
  ctx: SalesDetectionContext,
  rules: SalesRules
): {
  triggered: boolean;
  notes: string[];
} {
  const text = [ctx.userMessage, ...ctx.history.map((m) => m.content)]
    .join(" ")
    .toLowerCase();

  const triggered = rules.upsellKeywords.some((k) =>
    text.includes(k.toLowerCase())
  );

  const notes: string[] = [];
  if (triggered) {
    notes.push("heuristic:upsell-keyword-detected");
  }

  return { triggered, notes };
}

/**
 * ユーザー発話テキストベースの CTA 判定（簡易キーワード）。
 */
function detectCtaFromText(
  ctx: SalesDetectionContext,
  rules: SalesRules
): {
  triggered: boolean;
  notes: string[];
} {
  const text = [ctx.userMessage, ...ctx.history.map((m) => m.content)]
    .join(" ")
    .toLowerCase();

  const triggered = rules.ctaKeywords.some((k) =>
    text.includes(k.toLowerCase())
  );

  const notes: string[] = [];
  if (triggered) {
    notes.push("heuristic:cta-keyword-detected");
  }

  return { triggered, notes };
}

/**
 * 既存の SalesMeta と新しい検出結果をマージする。
 */
function mergeSalesMeta(
  prev: SalesMeta | undefined,
  parts: Array<{ kind: "upsell" | "cta"; triggered: boolean; notes: string[] }>
): SalesMeta {
  const prevMeta: SalesMeta = prev ?? {
    upsellTriggered: false,
    ctaTriggered: false,
    notes: [],
  };

  const upsellTriggered =
    prevMeta.upsellTriggered ||
    parts.some((p) => p.kind === "upsell" && p.triggered);

  const ctaTriggered =
    prevMeta.ctaTriggered || parts.some((p) => p.kind === "cta" && p.triggered);

  const allNotes = [
    ...(prevMeta.notes ?? []),
    ...parts.flatMap((p) => p.notes),
  ];
  const dedupedNotes = Array.from(new Set(allNotes));

  return {
    upsellTriggered,
    ctaTriggered,
    notes: dedupedNotes,
  };
}

/**
 * SalesPipeline のメイン関数。
 * - PlannerPlan とユーザー発話テキストからアップセル / CTA を検出し、
 *   SalesMeta を返す。
 */
export function runSalesPipeline(
  ctx: SalesDetectionContext,
  prev?: SalesMeta,
  options?: { tenantId?: string; rulesOverride?: SalesRules }
): SalesMeta {
  const rules =
    options?.rulesOverride ?? getSalesRules({ tenantId: options?.tenantId });

  const upsellPlan = detectUpsellFromPlan(ctx.plan, rules);
  const ctaPlan = detectCtaFromPlan(ctx.plan, rules);
  const upsellHeur = detectUpsellFromText(ctx, rules);
  const ctaHeur = detectCtaFromText(ctx, rules);

  const merged = mergeSalesMeta(prev, [
    { kind: "upsell", ...upsellPlan },
    { kind: "cta", ...ctaPlan },
    { kind: "upsell", ...upsellHeur },
    { kind: "cta", ...ctaHeur },
  ]);

  return merged;
}
