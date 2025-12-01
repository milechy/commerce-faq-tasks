// src/agent/orchestrator/sales/clarifyPromptBuilder.ts
// Phase13: Clarify-flow facing helper that pulls templates from SalesTemplateProvider

import { getSalesTemplate, type SalesPhase } from "./salesRules";

/**
 * 英会話向け Clarify Intent
 * - Phase13: とりあえず level_diagnosis / goal_setting に絞る
 */
export type ClarifyIntent = "level_diagnosis" | "goal_setting";

const CLARIFY_PHASE: SalesPhase = "clarify";

/**
 * Clarify 用の質問文を構築するユーティリティ。
 * - まず Notion 由来のテンプレ (TuningTemplates) を優先して取得
 * - 見つからない場合はフォールバック文面を返す
 */
export function buildClarifyPrompt(opts: {
  intent: ClarifyIntent;
  personaTags?: string[]; // ["社会人", "初心者"] など
}): string {
  const tmpl = getSalesTemplate({
    phase: CLARIFY_PHASE,
    intent: opts.intent,
    personaTags: opts.personaTags,
  });

  if (tmpl?.template) {
    return tmpl.template;
  }

  // --- フォールバック文面（Notion にテンプレが無い場合用） ---
  switch (opts.intent) {
    case "level_diagnosis":
      return [
        "現在の英語レベルについて教えてください。",
        "例:",
        "1. ほとんど話せない",
        "2. 簡単な自己紹介ならできる",
        "3. 仕事で時々英語を使っている",
        "4. 仕事で英語を頻繁に使っている",
      ].join("\n");
    case "goal_setting":
      return [
        "英会話で達成したいゴールを教えてください。",
        "例:",
        "・日常会話をストレスなく続けたい",
        "・仕事のミーティングで自信を持って話したい",
        "・海外出張・駐在に備えたい",
      ].join("\n");
    default:
      return "英会話について、今の状況と知りたいことを教えてください。";
  }
}