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
  weight?: number
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

function buildDetectionText(input: SalesIntentDetectionInput): string {
  const history = input.history ?? []
  const recentHistory = history.slice(-5)
  const historyText = recentHistory.map((m) => m.content || '').join('\n')

  const fullText = `${input.userMessage}\n${historyText}`
  return normalize(fullText)
}

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

function computeRuleScore<TIntent extends string>(
  text: string,
  rule: PhaseRuleBase<TIntent>,
): number {
  const patterns = rule.patterns ?? {}
  const anyPatterns = patterns.any ?? []
  const requirePatterns = patterns.require ?? []

  // require: いずれか 1 つ以上のヒットが必須（OR 条件）
  if (requirePatterns.length > 0) {
    const hasRequired = requirePatterns.some((p) => {
      const needle = normalize(p)
      return needle.length > 0 && text.includes(needle)
    })
    if (!hasRequired) return 0
  }

  // any: ヒット数をスコアとしてカウント
  const hitCount =
    anyPatterns.length > 0
      ? anyPatterns.filter((p) => {
          const needle = normalize(p)
          return needle.length > 0 && text.includes(needle)
        }).length
      : 0

  if (hitCount <= 0) return 0

  const weight = typeof rule.weight === 'number' ? rule.weight : 1
  return hitCount * weight
}

function detectFromRules<TIntent extends string>(
  text: string,
  rules?: PhaseRuleBase<TIntent>[],
): TIntent | undefined {
  if (!rules || rules.length === 0) return undefined

  let bestIntent: TIntent | undefined
  let bestScore = 0

  for (const rule of rules) {
    const score = computeRuleScore(text, rule)
    if (score > bestScore) {
      bestScore = score
      bestIntent = rule.intent
    }
  }

  return bestIntent
}

function detectSalesIntentsFromYaml(
  input: SalesIntentDetectionInput,
): DetectedSalesIntents | null {
  const rules = loadRulesFromYaml()
  if (!rules) return null

  const text = buildDetectionText(input)

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
