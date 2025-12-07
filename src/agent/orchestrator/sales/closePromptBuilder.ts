// src/agent/orchestrator/sales/closePromptBuilder.ts
// Phase14: Close-flow helper — final decision / closing messages.

import { getSalesTemplate, type SalesPhase, type SalesTemplate } from "./salesRules";
import type { BuiltSalesPromptResult } from "./proposePromptBuilder";

/**
 * CloseIntent — 英会話向けの「クロージング」フェーズ Intent
 *
 * Clarify / Propose / Recommend を経て、
 * 最後の一押しや不安解消、次の一歩を後押しするための文面を扱う。
 */
export type CloseIntent =
  | "close_after_trial"
  | "close_handle_objection_price"
  | "close_next_step_confirmation";

const CLOSE_PHASE: SalesPhase = "close";

/**
 * Close 用のクロージング文面テンプレートを構築する。
 * - 1) Notion の TuningTemplates を優先（phase=close, intent=...）
 * - 2) なければフェールバック（ハードコード文面）
 */
export function buildClosePrompt(opts: {
  intent: CloseIntent;
  personaTags?: string[];
}): string {
  const tmpl = getSalesTemplate({
    phase: CLOSE_PHASE,
    intent: opts.intent,
    personaTags: opts.personaTags,
  });

  if (tmpl?.template) {
    return tmpl.template;
  }

  // --- fallback 文面 ---
  switch (opts.intent) {
    case "close_after_trial":
      return [
        "体験レッスンおつかれさまでした！  ",
        "今日の内容を踏まえると、このまま継続いただくと着実にステップアップできそうです。",
        "",
        "・今のレベルに合ったカリキュラムを進められる  ",
        "・週◯回のペースなら無理なく続けられる  ",
        "・学習記録も残るので成果が見えやすい  ",
        "",
        "もしよければ、このまま本登録を進めてみませんか？  ",
        "ご不安な点があれば、何でも気軽に相談してくださいね。",
      ].join("\n");

    case "close_handle_objection_price":
      return [
        "料金面でご不安があるとのこと、率直に共有していただきありがとうございます。",
        "",
        "英会話学習は“投資”の側面があるため、しっかり納得したうえで進めることが大切です。",
        "",
        "・まずは低負荷で始められるプラン  ",
        "・必要になったタイミングでアップグレード可能  ",
        "・レッスン回数も柔軟に調整できます  ",
        "",
        "「月にこれくらいなら無理なく続けられそう」  ",
        "といった目安があれば、それにあわせた最適なプランをご提案します！",
      ].join("\n");

    case "close_next_step_confirmation":
      return [
        "ここまでお話ししてきた内容を踏まえると、次のステップに進む準備は整っています！",
        "",
        "・目標やレベルも明確になった  ",
        "・必要なプランの方向性も見えてきた  ",
        "・無理なく続けられるペースも確認できた  ",
        "",
        "もし「やってみようかな」という気持ちが少しでもあれば、  ",
        "まずは最初の1ヶ月だけ始めてみませんか？",
        "",
        "いつでもプラン変更や休会もできるので、安心してスタートできますよ。",
      ].join("\n");

    default:
      return [
        "ここまでの内容を踏まえて、いつでも次の一歩をお手伝いできます。",
        "気になる点や不安な点があれば、遠慮なく相談してくださいね。",
      ].join("\n");
  }
}

/**
 * Phase15: Close ステージ向けのテンプレートメタ付きビルダー。
 * 既存の buildClosePrompt の挙動はそのまま利用し、SalesTemplate 情報を付与する。
 */
export function buildClosePromptWithMeta(opts: {
  intent: CloseIntent;
  personaTags?: string[];
}): BuiltSalesPromptResult {
  const prompt = buildClosePrompt(opts);

  const template =
    getSalesTemplate({
      phase: CLOSE_PHASE,
      intent: opts.intent,
      personaTags: opts.personaTags,
    }) ?? {
      id: "fallback:close:runtime",
      phase: CLOSE_PHASE,
      intent: opts.intent,
      personaTags: opts.personaTags,
      template: prompt,
      source: "fallback",
      matrixKey: `close|${opts.intent}|${opts.personaTags?.[0] ?? "ANY"}`,
    };

  return {
    prompt,
    template,
  };
}
