// EC 業種向け SalesPipeline テンプレ定義
import type { SalesPipelineKind } from "../salesPipeline";

export interface IndustryPipeline {
  kind: SalesPipelineKind;
  upsellHints: string[];
  ctaHints: string[];
}

export const ecPipeline: IndustryPipeline = {
  kind: "ec",
  upsellHints: [
    "関連商品",
    "おすすめセット",
    "バンドル",
    "セット割",
    "上位モデル",
  ],
  ctaHints: [
    "購入",
    "カート",
    "チェックアウト",
    "今すぐ買う",
  ],
};
