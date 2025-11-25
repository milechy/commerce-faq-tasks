export type SalesPipelineKind = "generic" | "saas" | "ec" | "reservation";

export type SalesMeta = {
  /**
   * このセッションで適用されている SalesPipeline の種別。
   * Phase9 では、業種別テンプレ (SaaS / EC / 予約 など) を識別するために利用する。
   */
  pipelineKind?: SalesPipelineKind;
  upsellTriggered?: boolean;
  ctaTriggered?: boolean;
  notes?: string[];
};

export type SalesDetectionContext = {
  userMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  plan?: PlannerPlan;
};

export type SalesPipelineOptions = {
  /**
   * 将来的に tenant ごとに SalesRules / SalesPipeline を出し分けるための識別子。
   */
  tenantId?: string;
  /**
   * ルールを明示的に差し替えたい場合のオーバーライド。
   * - テストや一時的な実験用途を想定
   */
  rulesOverride?: SalesRules;
  /**
   * 適用したい SalesPipeline の種別 (generic / saas / ec / reservation など)。
   * 未指定の場合は "generic" が利用される。
   */
  pipelineKind?: SalesPipelineKind;
};

export function runSalesPipeline(
  ctx: SalesDetectionContext,
  prev?: SalesMeta,
  options?: SalesPipelineOptions
): SalesMeta {
  const rules =
    options?.rulesOverride ?? getSalesRules({ tenantId: options?.tenantId });
  const pipelineKind: SalesPipelineKind = options?.pipelineKind ?? "generic";

  // ...rest of function body...

  const merged = mergeSalesMeta(prev, [
    { kind: "upsell", ...upsellPlan },
    { kind: "cta", ...ctaPlan },
    { kind: "upsell", ...upsellHeur },
    { kind: "cta", ...ctaHeur },
  ]);

  return {
    ...merged,
    pipelineKind,
  };
}
