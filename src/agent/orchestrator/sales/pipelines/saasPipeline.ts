// SaaS 業種向け SalesPipeline テンプレ定義
import type { SalesPipelineKind } from "../salesPipeline";

export interface IndustryPipeline {
  kind: SalesPipelineKind;
  upsellHints: string[];
  ctaHints: string[];
}

export const saasPipeline: IndustryPipeline = {
  kind: "saas",
  upsellHints: [
    "上位プラン",
    "プレミアム",
    "月額",
    "アップグレード",
    "ユーザー数",
    "seat",
    "プロフェッショナル",
  ],
  ctaHints: [
    "申し込み",
    "契約",
    "トライアル",
    "開始したい",
    "サインアップ",
  ],
};
