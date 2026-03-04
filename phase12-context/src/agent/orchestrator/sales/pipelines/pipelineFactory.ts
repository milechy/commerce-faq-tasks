

// src/agent/orchestrator/sales/pipelines/pipelineFactory.ts

import type { SalesPipelineKind } from "../salesPipeline";
import { saasPipeline } from "./saasPipeline";
import { ecPipeline } from "./ecPipeline";
import { reservationPipeline } from "./reservationPipeline";

/**
 * SalesPipelineKind ごとに、人間にも分かりやすいラベルや説明文を紐づけるための設定。
 *
 * Phase9 の段階ではロジック自体はまだ共通ですが、
 * - ダッシュボード表示
 * - ログ / トレース
 * - 将来のパイプライン分岐
 * のために、ここで種別ごとのメタ情報を一元管理します。
 */
export type SalesPipelineConfig = {
  kind: SalesPipelineKind;
  label: string;
  description: string;
};

const PIPELINE_CONFIGS: Record<SalesPipelineKind, SalesPipelineConfig> = {
  generic: {
    kind: "generic",
    label: "汎用 (Generic)",
    description:
      "特定業種に依存しない、シンプルなアップセル / CTA 検出ロジックを提供するパイプライン。",
  },
  saas: {
    kind: "saas",
    label: "SaaS",
    description:
      "月額課金やプラン構成を前提とした、SaaS ビジネス向けの営業パイプライン (将来拡張予定)。",
  },
  ec: {
    kind: "ec",
    label: "EC",
    description:
      "カート・商品推薦・バンドル販売など、EC サイト向けの営業パイプライン (将来拡張予定)。",
  },
  reservation: {
    kind: "reservation",
    label: "予約",
    description:
      "サロン / クリニック / 飲食店などの予約ビジネス向けの営業パイプライン (将来拡張予定)。",
  },
};

/**
 * 指定された kind に対応するパイプライン設定を返す。
 * 未知の kind や undefined の場合は、常に generic にフォールバックする。
 */
export function getSalesPipelineConfig(
  kind: SalesPipelineKind | undefined,
): SalesPipelineConfig {
  if (!kind) return PIPELINE_CONFIGS.generic;

  return PIPELINE_CONFIGS[kind] ?? PIPELINE_CONFIGS.generic;
}

/**
 * tenantId などの情報から PipelineKind を推定するためのフック。
 *
 * Phase9 ではまだ何も推定せず、常に "generic" を返す実装に留めておきます。
 * 将来的に以下のようなルールを追加していく想定です:
 * - テナント設定テーブルから kind を参照
 * - サブドメイン / テナントキーのパターンで推測
 */
export function inferPipelineKindFromTenant(
  tenantId?: string,
): SalesPipelineKind {
  void tenantId; // 未来の拡張用パラメータ、現在は未使用
  return "generic";
}

/**
 * 明示指定された kind があればそれを優先し、無い場合は tenant 情報などから推定する。
 * 上位レイヤー (modelRouter など) からは、この関数だけを使えばよい想定です。
 */
export function resolveSalesPipelineKind(args: {
  explicitKind?: SalesPipelineKind;
  tenantId?: string;
}): SalesPipelineKind {
  if (args.explicitKind) return args.explicitKind;
  return inferPipelineKindFromTenant(args.tenantId);
}

/**
 * pipelineKind に応じて対応する IndustryPipeline を返す。
 * 未知の kind や generic の場合は null を返して、
 * SalesPipeline.ts 側でデフォルト/ルールベースの判定を行わせる。
 */
export function getIndustryPipelineByKind(kind: SalesPipelineKind) {
  switch (kind) {
    case "saas":
      return saasPipeline;
    case "ec":
      return ecPipeline;
    case "reservation":
      return reservationPipeline;
    default:
      return null; // generic または未知の kind は業種特化テンプレなし
  }
}