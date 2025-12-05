

// src/agent/orchestrator/sales/recommendPromptBuilder.ts
// Phase14: Recommend-flow helper — similar to Propose, but used for course/module recommendations.

import { getSalesTemplate, type SalesPhase } from "./salesRules";

/**
 * RecommendIntent — 英会話向けの「推奨」フェーズ Intent
 *
 * 目的：
 * - Clarify（診断）や Propose（提案）の後に、
 *   ユーザーのレベル・目標・状況に応じたコースや学習モジュールを提示する。
 *
 * 今後も slug を追加できるように union 形式で管理する。
 */
export type RecommendIntent =
  | "recommend_course_based_on_level"
  | "recommend_course_for_goal"
  | "recommend_addon_module";

const RECOMMEND_PHASE: SalesPhase = "recommend";

/**
 * Recommend 用の推奨文面テンプレートを構築する。
 * - 1) Notion の TuningTemplates を優先（phase=recommend, intent=...）
 * - 2) なければフェールバック（ハードコード文面）
 */
export function buildRecommendPrompt(opts: {
  intent: RecommendIntent;
  personaTags?: string[];
}): string {
  const tmpl = getSalesTemplate({
    phase: RECOMMEND_PHASE,
    intent: opts.intent,
    personaTags: opts.personaTags,
  });

  if (tmpl?.template) {
    return tmpl.template;
  }

  // --- fallback 文面 ---
  switch (opts.intent) {
    case "recommend_course_based_on_level":
      return [
        "レベル診断の内容を踏まえると、まずは基礎をしっかり固められるコースから始めるのがおすすめです。",
        "",
        "・日常会話でよく使う表現を集中的に練習できます",
        "・聞き取りの基礎を強化するカリキュラムが含まれています",
        "・初心者でも続けやすいペースで進みます",
        "",
        "もしよければ、",
        "「週◯回ぐらいなら続けられそう」「まずは聞き取りを強化したい」など、",
        "あなたの希望を教えていただけると、より最適なコースをご提案できます。",
      ].join("\n");

    case "recommend_course_for_goal":
      return [
        "お伺いした目標を踏まえると、目標に直結するコースを選ぶのが最短ルートです。",
        "",
        "例えばビジネス英会話が必要な場合：",
        "・実際の会議や商談を想定したロールプレイ練習",
        "・メール / チャットの英語表現トレーニング",
        "・海外チームとのコミュニケーションでよく使う表現",
        "",
        "「どんな場面で英語を使うことが多いか」教えていただければ、",
        "最適なカリキュラム構成をご提案します。",
      ].join("\n");

    case "recommend_addon_module":
      return [
        "現在の学習状況を見ると、特定スキルを重点的に強化するとさらに伸びやすくなります。",
        "",
        "例えば：",
        "・発音改善 → 聞き返されないクリアな発音を身につけたい方へ",
        "・文法集中 → 正確な表現をスムーズに使えるようになりたい方へ",
        "・リスニング強化 → 会議・動画視聴への対応力アップ",
        "",
        "気になるモジュールがあれば、目的に合わせて最適なものをご提案します。",
      ].join("\n");

    default:
      return [
        "学習状況を踏まえて、次に進むためのコースや学習プランをご提案できます。",
        "もし興味があれば、現在の課題や目標をもう少しだけ教えてください。",
      ].join("\n");
  }
}