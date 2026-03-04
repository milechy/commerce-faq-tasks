// 予約業種向け SalesPipeline テンプレ定義
import type { SalesPipelineKind } from "../salesPipeline";

export interface IndustryPipeline {
  kind: SalesPipelineKind;
  upsellHints: string[];
  ctaHints: string[];
}

export const reservationPipeline: IndustryPipeline = {
  kind: "reservation",
  upsellHints: [
    "オプション",
    "延長",
    "おすすめメニュー",
    "セットメニュー",
  ],
  ctaHints: [
    "予約したい",
    "空きがありますか",
    "日時指定",
    "予約確定",
  ],
};
