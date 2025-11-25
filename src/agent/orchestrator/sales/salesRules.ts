// src/agent/orchestrator/sales/salesRules.ts

export type SalesRules = {
  /** Recommend ステージで「上位プラン」っぽさを判定するヒント語句 */
  premiumHints: string[];
  /** ユーザー発話からアップセル意図を拾うためのキーワード */
  upsellKeywords: string[];
  /** ユーザー発話から CTA 意図を拾うためのキーワード */
  ctaKeywords: string[];
};

const defaultSalesRules: SalesRules = {
  premiumHints: [
    "上位",
    "プレミアム",
    "ハイグレード",
    "高いプラン",
    "upgrade",
    "higher",
    "premium",
  ],
  upsellKeywords: [
    "おすすめ",
    "他に",
    "似た",
    "おすすめの商品",
    "upgrade",
    "higher plan",
  ],
  ctaKeywords: [
    "購入",
    "買いたい",
    "予約",
    "申し込み",
    "order",
    "buy",
    "checkout",
  ],
};

/**
 * 将来的に Notion / DB からテナント別にルールを取得するための拡張ポイント。
 *
 * Phase8 現時点では defaultSalesRules を返すだけだが、
 * ここを差し替えることで、外部ストアからのロードが可能になる。
 */
export function getSalesRules(opts?: { tenantId?: string }): SalesRules {
  // TODO: Phase9〜:
  //  - tenantId ごとに Notion DB / Postgres 等から SalesRules をロード
  //  - キャッシュ層をかませる
  void opts; // 未使用抑制（将来用）
  return defaultSalesRules;
}
