// src/agent/orchestrator/sales/salesOrchestrator.ts
// Phase14: SalesFlow runtime orchestrator
// - Integrates SalesPipeline (upsell / CTA detection)
// - For Phase14 Step1, focuses on Propose stage integration using ProposePromptBuilder

import type { KpiFunnelMeta, SalesStage } from "../../dialog/types";
import { buildClosePrompt, type CloseIntent } from "./closePromptBuilder";
import { computeKpiFunnelFromPlan } from "./kpiFunnel";
import { buildProposePrompt, type ProposeIntent } from "./proposePromptBuilder";
import {
  buildRecommendPrompt,
  type RecommendIntent,
} from "./recommendPromptBuilder";
import {
  runSalesPipeline,
  type SalesDetectionContext,
  type SalesMeta,
  type SalesPipelineOptions,
} from "./salesPipeline";

// Extend SalesMeta with simple stage flags
export type ExtendedSalesMeta = SalesMeta & {
  proposeTriggered?: boolean;
  recommendTriggered?: boolean;
  closeTriggered?: boolean;
};

/**
 * SalesOrchestrator に入力される情報。
 * - detection: SalesPipeline が利用するコンテキスト（ユーザー発話 / history / PlannerPlan など）
 * - previousMeta: 直前までの SalesMeta（前ターンの結果）
 * - options: SalesPipelineOptions（tenant や pipelineKind 指定など）
 * - proposeIntent: Propose フェーズで利用したい intent（英会話向けなど）
 * - recommendIntent: Recommend フェーズで利用したい intent
 * - closeIntent: Close フェーズで利用したい intent
 * - personaTags: ユーザーのペルソナ（["社会人", "初心者"] など）
 */
export type SalesOrchestratorInput = {
  detection: SalesDetectionContext;
  previousMeta?: ExtendedSalesMeta;
  options?: SalesPipelineOptions;
  proposeIntent?: ProposeIntent;
  recommendIntent?: RecommendIntent;
  closeIntent?: CloseIntent;
  personaTags?: string[];
};

/**
 * SalesOrchestrator の出力結果。
 * - meta: SalesMeta に KPI ファネル情報を拡張したもの
 * - nextStage: 次に進むべき SalesStage（"propose" / "recommend" / "close" など）
 * - prompt: nextStage に応じて組み立てられた文面（Propose / Recommend / Close 用テンプレなど）
 */
export type SalesOrchestratorResult = {
  meta: ExtendedSalesMeta & {
    kpiFunnel?: KpiFunnelMeta;
  };
  nextStage?: SalesStage;
  prompt?: string;
};

/**
 * SalesFlow のランタイム本体。
 * - SalesPipeline で upsell / CTA を検出し、
 * - KPI ファネル情報（awareness / consideration / conversion）を付与し、
 * - 必要に応じて Propose 用の提案文を生成する。
 *
 * Phase14 Step1 では「Propose 外部化の統合」が主眼のため、
 * - upsellTriggered が新たに true になったときに Propose ステージを起動する、というシンプルなロジックにしている。
 */
export function runSalesOrchestrator(
  input: SalesOrchestratorInput
): SalesOrchestratorResult {
  const {
    detection,
    previousMeta,
    options,
    proposeIntent,
    recommendIntent,
    closeIntent,
    personaTags,
  } = input;

  // 1) SalesPipeline による upsell / CTA 検出
  const meta = runSalesPipeline(
    detection,
    previousMeta,
    options
  ) as ExtendedSalesMeta;

  // 2) PlannerPlan から KPI ファネル情報を計算
  const kpiFunnel = computeKpiFunnelFromPlan(detection.plan);

  const metaWithFunnel: SalesOrchestratorResult["meta"] = {
    ...meta,
    kpiFunnel,
    // 前ターンで立っていたフラグは基本的に引き継ぐ（runSalesPipeline は stage フラグを管理しない想定）
    proposeTriggered:
      previousMeta?.proposeTriggered ?? meta.proposeTriggered ?? false,
    recommendTriggered:
      previousMeta?.recommendTriggered ?? meta.recommendTriggered ?? false,
    closeTriggered:
      previousMeta?.closeTriggered ?? meta.closeTriggered ?? false,
  };

  const hasProposed =
    metaWithFunnel.proposeTriggered ?? previousMeta?.proposeTriggered ?? false;
  const hasRecommended =
    metaWithFunnel.recommendTriggered ??
    previousMeta?.recommendTriggered ??
    false;
  const hasClosed =
    metaWithFunnel.closeTriggered ?? previousMeta?.closeTriggered ?? false;

  // 3) 前ターンとの差分を見て、必要なら Sales ステージを起動
  let nextStage: SalesStage | undefined;
  let prompt: string | undefined;

  // シンプルなルール:
  // - まだ Propose を出していなければ Propose を優先（intent が未指定ならスキップ）
  // - 次に Recommend（intent が未指定ならスキップ）
  // - 最後に Close（intent が未指定ならスキップ）
  if (!hasProposed && proposeIntent) {
    nextStage = "propose";
    prompt = buildProposePrompt({
      intent: proposeIntent,
      personaTags,
    });
    metaWithFunnel.proposeTriggered = true;
  } else if (!hasRecommended && recommendIntent) {
    nextStage = "recommend";
    prompt = buildRecommendPrompt({
      intent: recommendIntent,
      personaTags,
    });
    metaWithFunnel.recommendTriggered = true;
  } else if (!hasClosed && closeIntent) {
    nextStage = "close";
    prompt = buildClosePrompt({
      intent: closeIntent,
      personaTags,
    });
    metaWithFunnel.closeTriggered = true;
  }

  return {
    meta: metaWithFunnel,
    nextStage,
    prompt,
  };
}
