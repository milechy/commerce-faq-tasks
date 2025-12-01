// src/agent/flow/queryPlanner.ts

import { QueryPlan } from '../types'

type LlmQueryPlanRaw = {
  search_query?: string
  top_k?: number
  language?: 'ja' | 'en' | 'other'
  filters?: {
    category?: string
    categories?: string[]
    must_terms?: string[]
    should_terms?: string[]
    exclude_terms?: string[]
  }
}

export interface PlanOptions {
  topK?: number
  /**
   * 将来 LLM プランナーを入れるときのための locale ヒント。
   * 今は 'auto' 扱いで、日本語/その他をざっくり判定するだけ。
   */
  locale?: 'ja' | 'en' | 'auto'
}

/**
 * Query Planner のインターフェース。
 * 将来 LLM ベースの Planner を追加する場合は、この I/F を実装して差し替える想定。
 */
export interface QueryPlanner {
  plan(input: string, options?: PlanOptions): QueryPlan
}

/**
 * 現状の軽量ルールベース Planner。
 * - 自然文の末尾処理（「教えて」「とは」「?」）を削る
 * - 空白を正規化
 * - シンプルなカテゴリ推定（返品 / 配送 / 支払い など）を filters に詰める
 */
export class RuleBasedQueryPlanner implements QueryPlanner {
  plan(input: string, options: PlanOptions = {}): QueryPlan {
    const locale = options.locale ?? detectLocale(input)
    const normalized = normalizeQuestion(input, locale)

    const topK = clamp(options.topK ?? 8, 1, 20)
    const filters = inferFilters(
  normalized,
  locale === 'en' ? 'en' : 'ja',
);

    return {
      searchQuery: normalized,
      topK,
      filters,
    }
  }
}

/**
 * デフォルトの Planner。
 * Phase2 現時点では RuleBased のみだが、
 * 将来 LLM プランナーを組み込む場合はここで差し替え/ラップする。
 */
const defaultPlanner: QueryPlanner = new RuleBasedQueryPlanner()

/**
 * 既存のシンプルなエントリポイント。
 * - シグネチャは従来どおり (sync)
 * - 実装は Strategy を差し替え可能な形にしてある
 */
export function planQuery(input: string, options: PlanOptions = {}): QueryPlan {
  return defaultPlanner.plan(input, options)
}

/**
 * 日本語の自然文から余計な語尾や記号を取り除いて検索クエリにする。
 * ランタイム安全性のため、q が string 以外の場合は空文字を返す。
 */
function normalizeQuestion(q: string, locale: 'ja' | 'en' | 'auto'): string {
  if (typeof q !== 'string') {
    // 想定外ケースだが、例外は投げず安全側で空文字を返す。
    return ''
  }

  let s = q.trim().replace(/\s+/g, ' ')

  // 末尾の ? / ？ をざっくり削る
  s = s.replace(/[?？]+$/g, '')

  if (locale === 'ja' || locale === 'auto') {
    // よくある日本語の語尾をざっくり削る
    s = s.replace(
      /(について教えてください|について教えて|を教えてください|を教えて|とは|って何|ってなに)$/g,
      '',
    )
  } else {
    // 簡易英語対応（将来 LLM に寄せていく）
    s = s.replace(
      /(please tell me about|please tell me|what is|what are)$/gi,
      '',
    )
  }

  s = s.trim()

  // 全部削れちゃった場合は元のを返す（安全側）
  if (!s) return q.trim()

  return s
}

/**
 * 超ざっくりした locale 判定。
 * - ひらがな/カタカナ/漢字 があれば ja
 * - それ以外は en 扱い
 */
function detectLocale(text: string): 'ja' | 'en' {
  if (/[ぁ-んァ-ン一-龥]/.test(text)) return 'ja'
  return 'en'
}

/**
 * FAQ カテゴリの簡易推定。
 * - 将来 LLM プランナーを入れるときは、ここを LLM 由来の intent / slot に置き換え可能。
 */
function inferFilters(
  text: string,
  locale: 'ja' | 'en',
): Record<string, unknown> | null {
  const lower = text.toLowerCase()

  const categories: string[] = []

  if (locale === 'ja') {
    if (/[返品返金キャンセル]/.test(text)) {
      categories.push('returns')
    }
    if (/[送料配送配達出荷発送]/.test(text)) {
      categories.push('shipping')
    }
    if (/[支払い決済クレジットカード]/.test(text)) {
      categories.push('payment')
    }
    if (/[ポイントクーポン割引]/.test(text)) {
      categories.push('promotion')
    }
  } else {
    if (/\b(return|refund|cancel)/.test(lower)) {
      categories.push('returns')
    }
    if (/\b(ship|shipping|delivery)/.test(lower)) {
      categories.push('shipping')
    }
    if (/\b(payment|credit card|charge)/.test(lower)) {
      categories.push('payment')
    }
    if (/\b(coupon|discount|promo)/.test(lower)) {
      categories.push('promotion')
    }
  }

  if (categories.length === 0) return null

  // filters は将来 intent/slot なども入れられる柔軟な構造のままにしておく
  return {
    category: categories[0], // ひとまず最初の一個だけ採用
    categories,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function buildPlannerPrompt(input: string, options: PlanOptions): string {
  const baseTopK = options.topK ?? 8

  // system 的な指示も含めて 1 テキストにまとめる（simple completion 想定）
  return [
    'あなたは EC サイトの FAQ 検索用 Query Planner です。',
    'ユーザーの自然文の質問から、検索エンジン用の QueryPlan を JSON で生成してください。',
    '',
    '制約:',
    '- 出力フォーマットは JSON オブジェクト 1 つだけ',
    '- 追加の説明文、Markdown、コメントは禁止（「```」も禁止）',
    '- 不明な値は空文字や null ではなく、省略してください',
    '',
    '目的:',
    '- FAQ 検索に適した、シンプルで情報量のあるクエリを作る',
    '- ユーザーの意図に合うカテゴリやキーワードを filters に追加する',
    '',
    '# ユーザーの質問',
    input,
    '',
    '# タスク',
    '上記の質問から、FAQ 検索エンジン用の QueryPlan を作成してください。',
    '',
    '## 1. search_query',
    '- ユーザーの質問から余計な語尾や敬語を取り除き、検索しやすい形にしてください。',
    '- 日本語のままで構いません。',
    '- 意図が曖昧な場合も、最も妥当な 1 パターンを選んでください。',
    '',
    '## 2. top_k',
    `- 1〜20 の範囲で設定してください。デフォルトは ${baseTopK} です。`,
    '- 曖昧な質問や広いテーマのときは 10〜15 など少し増やして構いません。',
    '',
    '## 3. filters',
    'filters オブジェクトには、以下のような情報を必要に応じて含めてください:',
    '- category: 質問の主なカテゴリ（例: "returns", "shipping", "payment", "promotion", "product", "account"）',
    '- categories: 複数カテゴリ候補（最も重要なカテゴリを先頭に）',
    '- must_terms: 検索クエリに必ず含めたい重要キーワード',
    '- should_terms: 優先的にマッチさせたいが必須ではないキーワード',
    '- exclude_terms: 除外したいキーワードがあれば追加',
    '',
    '## 4. language',
    '質問文の主な言語を判定して "ja" | "en" | "other" のいずれかを設定してください。',
    '',
    '## 出力フォーマット',
    '次の JSON だけを返してください（例）：',
    '{',
    '  "search_query": "返品 送料",',
    '  "top_k": 8,',
    '  "language": "ja",',
    '  "filters": {',
    '    "category": "returns",',
    '    "categories": ["returns", "shipping"],',
    '    "must_terms": ["返品", "送料"],',
    '    "should_terms": ["返金", "自己負担", "当社負担"],',
    '    "exclude_terms": []',
    '  }',
    '}',
  ].join('\n')
}

function safeParseLlmPlan(raw: string): LlmQueryPlanRaw | null {
  try {
    // 余分なテキストが付く可能性に備えて、最初と最後の波括弧の範囲を抽出してから parse を試みる
    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')
    const jsonText =
      firstBrace >= 0 && lastBrace > firstBrace
        ? raw.slice(firstBrace, lastBrace + 1)
        : raw

    const parsed = JSON.parse(jsonText) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as LlmQueryPlanRaw
  } catch {
    return null
  }
}

function normalizeLlmPlan(
  llm: LlmQueryPlanRaw,
  originalInput: string,
  options: PlanOptions,
): QueryPlan {
  const fallbackTopK = options.topK ?? 8
  const searchQuery =
    (llm.search_query && llm.search_query.trim()) || originalInput.trim()

  const topK = clamp(llm.top_k ?? fallbackTopK, 1, 20)

  const filters = llm.filters ?? null

  return {
    searchQuery,
    topK,
    filters,
  }
}

/**
 * LLM クライアントのインターフェース。
 * 具体的な実装は「OpenAI クライアント」「社内 LLM クライアント」などで差し替える想定。
 */
export interface LlmClient {
  /**
   * 単純な completion 用の I/F。
   * - prompt: Planner 用の system + user プロンプトを連結したテキスト
   * - return: LLM 生テキスト
   */
  complete(prompt: string): Promise<string>
}

/**
 * LLM ベースの Query Planner 用設定。
 * 今は「定義だけ」で、実装フェーズで使う。
 */
export interface LlmQueryPlannerConfig {
  client: LlmClient
  /**
   * 利用するモデル名など。LLM 側の実装に渡すだけで、Planner では中身を解釈しない。
   */
  model?: string
  /**
   * 将来的に Multi-step Planning に対応する場合のステップ数上限。
   */
  maxSteps?: number
}

/**
 * LLM ベースの Query Planner のスケルトン。
 *
 * 現時点では、まだ LLM 呼び出しは実装せず、RuleBasedQueryPlanner に委譲する。
 * - 将来 Async な `planAsync` を追加して、LLM 呼び出し結果を QueryPlan にマッピングする。
 */
export class LlmQueryPlanner {
  private readonly fallback = new RuleBasedQueryPlanner()

  constructor(private readonly config: LlmQueryPlannerConfig) {}

  async planAsync(input: string, options: PlanOptions = {}): Promise<QueryPlan> {
    // LLM 呼び出しに失敗した場合は Rule-based にフォールバック
    try {
      const prompt = buildPlannerPrompt(input, options)
      const raw = await this.config.client.complete(prompt)

      const parsed = safeParseLlmPlan(raw)
      if (!parsed) {
        return this.fallback.plan(input, options)
      }

      return normalizeLlmPlan(parsed, input, options)
    } catch {
      return this.fallback.plan(input, options)
    }
  }
}

/**
 * 非同期版 Query Planner エントリポイント。
 *
 * 現時点では RuleBasedQueryPlanner に委譲しているが、
 * 将来的に LLM ベースの Planner を利用したい場合は、
 * この関数の実装だけを差し替えればよい。
 */
export async function planQueryAsync(
  input: string,
  options: PlanOptions = {},
): Promise<QueryPlan> {
  // TODO: LLM プランナー導入時に、LlmQueryPlanner.planAsync を呼び出すように拡張
  return defaultPlanner.plan(input, options)
}