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
 * Sales フローにおけるフェーズ（Clarify / Propose / Recommend / Close）。
 * - Phase13 では、Notion 上の TuningTemplates と 1:1 で対応させる想定。
 */
export type SalesPhase = "clarify" | "propose" | "recommend" | "close";

/**
 * Sales テンプレート 1 件分の定義。
 * - Notion の TuningTemplates DB から読み込まれる行とほぼ同等の構造を想定。
 */
export type SalesTemplate = {
  /** テンプレート行を一意に識別する ID（Notion ページ ID や内部 ID） */
  id: string;
  /** Clarify / Propose / Recommend / Close のいずれか */
  phase: SalesPhase;
  /** intent（level_diagnosis / goal_setting など）が紐づく場合に利用 */
  intent?: string;
  /** ペルソナタグ（"beginner" / "business" など） */
  personaTags?: string[];
  /** 実際にプロンプトとして利用するテンプレート文面 */
  template: string;
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
 * Sales テンプレートを提供するための抽象プロバイダ型。
 *
 * - Phase13: Notion TuningTemplates からロードしたテンプレをここに差し込む想定
 * - 何も設定されていない場合は、null を返すデフォルト実装になる
 */
export type SalesTemplateProvider = (opts: {
  tenantId?: string;
  phase: SalesPhase;
  intent?: string;
  personaTags?: string[];
}) => SalesTemplate | null;

/** 現在有効な SalesTemplateProvider。 */
let currentSalesTemplateProvider: SalesTemplateProvider = () => null;

/**
 * 外部から SalesTemplateProvider を差し替えるためのフック。
 *
 * - Phase13: Notion ベースのローダから呼び出される想定
 * - テストコードでのモック差し替えにも利用
 */
export function setSalesTemplateProvider(provider: SalesTemplateProvider) {
  currentSalesTemplateProvider = provider;
}

/**
 * Sales テンプレートを取得するためのユーティリティ関数。
 *
 * - 呼び出し側は phase / intent / personaTags を指定するだけでよい
 * - 実際にどこからテンプレがロードされるか（ハードコード / Notion / DB）は
 *   Provider の実装に委譲される。
 */
export function getSalesTemplate(opts: {
  tenantId?: string;
  phase: SalesPhase;
  intent?: string;
  personaTags?: string[];
}): SalesTemplate | null {
  return currentSalesTemplateProvider(opts);
}

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
