// src/agent/orchestrator/sales/salesIntentDetector.ts
// Phase14+: SalesFlow intent detector.
// ルールは config/salesIntentRules.yaml から読み込み、
// 取得できなかった場合は従来のハードコード判定にフォールバックする。

import fs from 'node:fs'
import path from 'node:path'
import type { DialogMessage } from '../../dialog/types'
import type { ProposeIntent } from './proposePromptBuilder'
import type { RecommendIntent } from './recommendPromptBuilder'
import type { CloseIntent } from './closePromptBuilder'

// js-yaml は CJS 環境なので require で読み込む
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as typeof import('js-yaml')

export type DetectedSalesIntents = {
  proposeIntent?: ProposeIntent
  recommendIntent?: RecommendIntent
  closeIntent?: CloseIntent
}

export type SalesIntentDetectionInput = {
  userMessage: string
  history?: DialogMessage[]
  // Planner の詳細構造には依存しない。必要になったら型を広げる。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan: any
}

type PhaseRuleBase<TIntent extends string> = {
  intent: TIntent
  name?: string
  patterns?: {
    any?: string[]
    require?: string[]
  }
}

type SalesIntentRuleConfig = {
  propose?: PhaseRuleBase<ProposeIntent>[]
  recommend?: PhaseRuleBase<RecommendIntent>[]
  close?: PhaseRuleBase<CloseIntent>[]
}

let cachedRules: SalesIntentRuleConfig | null = null
let rulesLoadErrorLogged = false

function normalize(text: string): string {
  return text.toLowerCase()
}

function loadRulesFromYaml(): SalesIntentRuleConfig | null {
  if (cachedRules) return cachedRules

  try {
    const filePath = path.resolve(process.cwd(), 'config/salesIntentRules.yaml')
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = yaml.load(raw) as SalesIntentRuleConfig | undefined
    if (!parsed) {
      throw new Error('salesIntentRules.yaml is empty or invalid')
    }
    cachedRules = parsed
    return cachedRules
  } catch (err) {
    if (!rulesLoadErrorLogged) {
      // ログ基盤には依存せず、最低限の警告だけ出す
      // eslint-disable-next-line no-console
      console.warn(
        '[salesIntentDetector] failed to load config/salesIntentRules.yaml. falling back to built-in rules.',
        err,
      )
      rulesLoadErrorLogged = true
    }
    return null
  }
}

function matchesRule<TIntent extends string>(
  text: string,
  rule: PhaseRuleBase<TIntent>,
): boolean {
  const patterns = rule.patterns ?? {}
  const anyPatterns = patterns.any ?? []
  const requirePatterns = patterns.require ?? []

  if (anyPatterns.length > 0) {
    const anyMatched = anyPatterns.some((p) => {
      const needle = normalize(p)
      return needle.length > 0 && text.includes(needle)
    })
    if (!anyMatched) return false
  }

  if (requirePatterns.length > 0) {
    const allMatched = requirePatterns.every((p) => {
      const needle = normalize(p)
      return needle.length > 0 && text.includes(needle)
    })
    if (!allMatched) return false
  }

  return true
}

function detectFromRules<TIntent extends string>(
  text: string,
  rules?: PhaseRuleBase<TIntent>[],
): TIntent | undefined {
  if (!rules || rules.length === 0) return undefined
  for (const rule of rules) {
    if (matchesRule(text, rule)) {
      return rule.intent
    }
  }
  return undefined
}

function detectSalesIntentsFromYaml(
  input: SalesIntentDetectionInput,
): DetectedSalesIntents | null {
  const rules = loadRulesFromYaml()
  if (!rules) return null

  const text = normalize(input.userMessage)

  const proposeIntent = detectFromRules(text, rules.propose)
  const recommendIntent = detectFromRules(text, rules.recommend)
  const closeIntent = detectFromRules(text, rules.close)

  return {
    proposeIntent,
    recommendIntent,
    closeIntent,
  }
}

/**
 * 旧来のハードコード版ルール。
 * YAML が読めない場合のフォールバックとしてのみ利用する。
 */
function detectSalesIntentsLegacy(
  input: SalesIntentDetectionInput,
): DetectedSalesIntents {
  const { userMessage } = input
  const text = normalize(userMessage)

  let proposeIntent: ProposeIntent | undefined
  let recommendIntent: RecommendIntent | undefined
  let closeIntent: CloseIntent | undefined

  // --- Propose: 料金・体験レッスン系 ---------------------------
  if (/料金|値段|金額|費用/.test(text) || /プラン/.test(text)) {
    if (/体験|トライアル|お試し/.test(text)) {
      proposeIntent = 'trial_lesson_offer'
    } else {
      proposeIntent = 'propose_monthly_plan_basic'
    }
  }

  // --- Recommend: コース・レベル・目標相談系 -------------------
  if (
    /自分に合うコース|どのコース|おすすめのコース/.test(text) ||
    ((/コース|プラン/.test(text) && /知りたい|教えて|おすすめ/.test(text)) ||
      /レベル/.test(text))
  ) {
    recommendIntent = 'recommend_course_based_on_level'
  }

  if (/目標|ゴール|TOEIC|TOEFL|ビジネス英語|昇進/.test(text)) {
    recommendIntent = 'recommend_course_for_goal'
  }

  // --- Close: 次のステップ・開始の背中押し系 -------------------
  if (
    /どう進めるのが良さそう|どう進めるのがよさそう|次のステップ|どう始める/.test(
      text,
    ) ||
    /始めたい|申し込みたい|申込みたい|もう始めてもいい/.test(text)
  ) {
    closeIntent = 'close_next_step_confirmation'
  }

  if (/体験レッスン/.test(text) && /どうでした|受けてみて|感想/.test(text)) {
    closeIntent = 'close_after_trial'
  }

  if (/高い|値段が気になる|続けられるか心配|もったいない/.test(text)) {
    closeIntent = 'close_handle_objection_price'
  }

  return {
    proposeIntent,
    recommendIntent,
    closeIntent,
  }
}

export function detectSalesIntents(
  input: SalesIntentDetectionInput,
): DetectedSalesIntents {
  const fromYaml = detectSalesIntentsFromYaml(input)
  if (fromYaml) return fromYaml
  return detectSalesIntentsLegacy(input)
}
