// src/agent/orchestrator/sales/salesRules.ts

/**
 * SalesRules は、営業対話の中で「どの発話をどの意図として扱うか」を
 * 判定するための、軽量なヒューリスティック定義です。
 *
 * Phase9 以降では、Notion / DB などの外部ストアからロードされた値を
 * この型にマッピングして利用します。
 */
export type SalesRules = {
  /** Recommend ステージで「上位プラン」っぽさを判定するヒント語句 */
  premiumHints: string[];
  /** ユーザー発話からアップセル意図を拾うためのキーワード */
  upsellKeywords: string[];
  /** ユーザー発話から CTA 意図を拾うためのキーワード */
  ctaKeywords: string[];
};

/**
 * プロジェクト共通で利用されるデフォルト SalesRules。
 *
 * - 外部にルール定義が存在しないテナント
 * - テスト環境
 * などでは、この値がフォールバックとして利用されます。
 */
export const defaultSalesRules: SalesRules = {
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
 * SalesRules を提供するための抽象プロバイダ型。
 *
 * Phase9 では、別モジュール（例: rulesLoader.ts）側で
 * - Notion / DB からルールをロード
 * - テナントごとのキャッシュ
 * を行い、その結果をこの Provider に差し込む想定です。
 */
export type SalesRulesProvider = (opts?: { tenantId?: string }) => SalesRules;

/**
 * 現在有効な SalesRulesProvider。
 * 何も設定されていない場合は defaultSalesRules を返すプロバイダになります。
 */
let currentSalesRulesProvider: SalesRulesProvider = () => defaultSalesRules;

/**
 * 外部から SalesRulesProvider を差し替えるためのフック。
 *
 * - Phase9: rulesLoader から呼ばれる想定
 * - テストコードでのモック差し替えにも利用
 */
export function setSalesRulesProvider(provider: SalesRulesProvider) {
  currentSalesRulesProvider = provider;
}

/**
 * 呼び出し側からは、従来どおり getSalesRules を使うだけでよい。
 * 実際にどこからルールがロードされるか（ハードコード / Notion / DB）は
 * Provider の実装に委譲されます。
 */
export function getSalesRules(opts?: { tenantId?: string }): SalesRules {
  return currentSalesRulesProvider(opts);
}
