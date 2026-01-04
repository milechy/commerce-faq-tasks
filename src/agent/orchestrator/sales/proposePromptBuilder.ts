// src/agent/orchestrator/sales/proposePromptBuilder.ts
// Phase14: Propose-flow facing helper that pulls templates from SalesTemplateProvider

import { getSalesTemplate, type SalesPhase, type SalesTemplate } from "./salesRules";

/**
 * 英会話向け Propose Intent
 * - Phase14: まずは体験レッスン提案のみからスタートし、順次拡張していく想定。
 *
 * 例:
 * - "trial_lesson_offer": 初回の無料/割引体験レッスンを提案する
 *
 * 将来的には:
 * - "monthly_plan_basic"
 * - "monthly_plan_premium"
 * などを追加していく。
 */
export type ProposeIntent =
  | "trial_lesson_offer"              // 初回の体験レッスン提案
  | "propose_monthly_plan_basic"      // ベーシックな月額プラン提案
  | "propose_monthly_plan_premium"    // プレミアムな月額プラン提案
  | "propose_subscription_upgrade";   // 既存ユーザー向けアップグレード提案

const PROPOSE_PHASE: SalesPhase = "propose";

/**
 * Phase15: テンプレートメタ情報付きのビルド結果。
 * - prompt: 実際に LLM に渡すプロンプト全文
 * - template: 利用した SalesTemplate（source / matrixKey などを含む）
 */
export type BuiltSalesPromptResult = {
  prompt: string;
  template: SalesTemplate;
};

/**
 * Propose 用の提案文を構築するユーティリティ。
 * - まず Notion 由来のテンプレ (TuningTemplates) を優先して取得
 * - 見つからない場合はフォールバック文面を返す
 */
export function buildProposePrompt(opts: {
  intent: ProposeIntent;
  personaTags?: string[]; // ["社会人", "初心者"] など
}): string {
  const tmpl = getSalesTemplate({
    phase: PROPOSE_PHASE,
    intent: opts.intent,
    personaTags: opts.personaTags,
  });

  if (tmpl?.template) {
    return tmpl.template;
  }

  // --- フォールバック文面（Notion にテンプレが無い場合用） ---
  switch (opts.intent) {
    case "trial_lesson_offer":
      return [
        "ありがとうございます！",
        "お話を踏まえて、一度オンライン英会話の体験レッスンを受けてみませんか？",
        "",
        "・25分程度で、現在のレベルに合わせて講師が会話をリードします",
        "・ビデオ通話ツール（例: Zoom）で実施します",
        "・平日夜や土日など、ご都合の良い時間帯を選べます",
        "",
        "もしご興味があれば、",
        "「体験レッスンを受けたい」「平日19時以降が良い」など、",
        "ご希望の日時や曜日をざっくり教えてください。",
      ].join("\n");

    case "propose_monthly_plan_basic":
      return [
        "体験レッスンの内容を踏まえて、まずは無理なく続けやすい「ベーシックプラン」から始めてみませんか？",
        "",
        "・週1〜2回のレッスンが目安です",
        "・仕事や学業と両立しやすいボリュームです",
        "・基礎的な会話力をコツコツ伸ばしたい方におすすめです",
        "",
        "もしご興味があれば、",
        "「ベーシックプランの詳細を知りたい」「週◯回くらいから始めたい」など、",
        "今イメージしている頻度やご予算を教えてください。",
      ].join("\n");

    case "propose_monthly_plan_premium":
      return [
        "短期間でしっかり成果を出したい方向けに、「プレミアムプラン」もご用意しています。",
        "",
        "・週3〜5回のレッスンが目安です",
        "・復習サポートやフィードバックがより手厚くなります",
        "・海外出張や転職など、期限付きの目標がある方におすすめです",
        "",
        "「本気でレベルアップしたい」「◯ヶ月後までに◯◯したい」など、",
        "もし具体的な目標があれば、あわせて教えていただけると最適な頻度をご提案できます。",
      ].join("\n");

    case "propose_subscription_upgrade":
      return [
        "いつもレッスンをご利用いただきありがとうございます！",
        "最近の学習状況を拝見すると、そろそろ一段階上のプランにアップグレードしても良いタイミングかもしれません。",
        "",
        "・より多くのレッスン回数を確保できます",
        "・弱点にフォーカスしたカリキュラムを組みやすくなります",
        "・講師の指名や時間帯の選択肢も広がります",
        "",
        "「最近こういう場面で英語を使うことが増えてきた」など、",
        "今の使い方や今後の予定を教えていただければ、ぴったりなアップグレード案をご提案します。",
      ].join("\n");

    default:
      // 将来的に intent を増やしたときの安全策
      return [
        "ありがとうございます！",
        "次のステップとして、こちらからご提案をさせてください。",
        "",
        "ご興味がありそうなプランや進め方をこちらで整理するので、",
        "気になる点や不安な点があれば、あわせて教えていただけると嬉しいです。",
      ].join("\n");
  }
}

/**
 * Phase15: SalesFlow 用に、テンプレートメタ情報も含めて返すラッパー関数。
 * 既存の buildProposePrompt の挙動（文字列プロンプト生成）はそのまま利用しつつ、
 * SalesRules.getSalesTemplate から取得した SalesTemplate をメタとして同梱する。
 */
export function buildProposePromptWithMeta(opts: {
  intent: ProposeIntent;
  personaTags?: string[];
}): BuiltSalesPromptResult {
  const prompt = buildProposePrompt(opts);

  const template =
    getSalesTemplate({
      phase: PROPOSE_PHASE,
      intent: opts.intent,
      personaTags: opts.personaTags,
    }) ?? {
      // 念のため、null の場合にも最低限のメタ情報を持つテンプレートを生成する
      id: "fallback:propose:runtime",
      phase: PROPOSE_PHASE,
      intent: opts.intent,
      personaTags: opts.personaTags,
      template: prompt,
      source: "fallback",
      matrixKey: `propose|${opts.intent}|${opts.personaTags?.[0] ?? "ANY"}`,
    };

  return {
    prompt,
    template,
  };
}
