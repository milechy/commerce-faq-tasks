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
  /** テンプレートのソース（Notion / fallback など）。Provider 側で任意に設定可能。 */
  source?: "notion" | "fallback" | string;
  /**
   * TemplateMatrix / TemplateGaps と突き合わせるためのセルキー。
   * 例: "propose|trial_lesson_offer|beginner"
   */
  matrixKey?: string;
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
  const fromProvider = currentSalesTemplateProvider(opts);

  if (fromProvider) {
    return fromProvider;
  }

  // Provider からテンプレートが見つからなかった場合のフォールバック:
  // Phase15 では、少なくとも phase ごとの最低限テンプレートを返す。
  return getFallbackSalesTemplate(opts);
}

/**
 * Provider からテンプレートが取得できなかった場合に利用する
 * 最低限のフォールバックテンプレート。
 *
 * - Notion / DB が未設定のテナント
 * - テンプレマトリクス上で穴になっているフェーズ
 * などでも、SalesFlow 自体が動作し続けることを目的とする。
 */
function getFallbackSalesTemplate(opts: {
  phase: SalesPhase;
  intent?: string;
  personaTags?: string[];
}): SalesTemplate {
  const { phase, intent, personaTags } = opts;
  const tags = personaTags ?? [];
  const isBeginner = tags.includes("beginner");

  let templateText: string;

  switch (phase) {
    case "clarify":
      templateText =
        "あなたはヒアリング担当です。ユーザーの現状・目的・制約条件（予算や時間帯など）を丁寧に質問し、SalesFlow の次の提案フェーズに進めるための情報を整理してください。専門用語は避け、わかりやすい言葉で対話してください。";
      break;

    case "propose":
      if (isBeginner) {
        templateText =
          "ユーザーは初心者想定です。これまでのヒアリング内容を踏まえて、1〜2 個の具体的なプラン案と料金の目安を、専門用語を避けてシンプルに提案してください。最後に「この中だとどれが気になりましたか？」のように、ユーザーに選びやすい聞き方をしてください。";
      } else {
        templateText =
          "これまでのヒアリング内容を踏まえて、ユーザーに合いそうな 1〜2 個の具体的なプラン案と料金の目安を提案してください。各プランの違いとメリットを短く整理し、ユーザーが比較しやすい形で提示してください。";
      }
      break;

    case "recommend":
      templateText =
        "すでに提案したプラン案を前提に、ユーザーに最も合いそうな選択肢を 1 つ推薦してください。その理由（レベル・目的・通いやすさ・予算など）を簡潔に説明し、もし合わなそうであれば代替案も 1 つだけ示してください。";
      break;

    case "close":
      templateText =
        "これまでの対話内容を要約しつつ、ユーザーが感じていそうな不安（料金・継続できるか・レベル感など）を 1 つずつ確認しながら、次の具体的なステップ（体験予約、申込フォームの案内など）を提案してください。押し付けにならないよう、ユーザーのペースに合わせて選択肢を提示してください。";
      break;

    default:
      templateText =
        "テンプレートが見つかりませんでした。率直に状況を説明し、ユーザーの要望をもう一度丁寧に確認してください。";
      break;
  }

  const fallbackIdParts = ["fallback", phase];
  if (isBeginner) {
    fallbackIdParts.push("beginner");
  }

  return {
    id: fallbackIdParts.join(":"),
    phase,
    intent,
    personaTags: tags,
    template: templateText,
    source: "fallback",
    matrixKey: `${phase}|${intent ?? "ANY"}|${isBeginner ? "beginner" : "ANY"}`,
  };
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
