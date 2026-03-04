// src/agent/flow/ruleBasedPlanner.ts
//
// Rule-based dialog planner (skeleton).
// Phase11 ではまだ実際のロジックは実装せず、PlannerPlan を返すための
// インターフェースのみ定義しておく。
//
// 今後、shipping / returns / payment / product-info などの典型 FAQ については、
// ここでルールベースに PlannerPlan を構築し、LLM Planner の呼び出し頻度を
// 減らして p95 レイテンシを削減する想定。

import type { PlannerPlan } from "../dialog/types";
import type { DialogInput } from "../orchestrator/langGraphOrchestrator";

/**
 * ルールベースの PlannerPlan を構築するエントリポイント。
 *
 * Phase12 では shipping / returns などの典型 FAQ については、ここで
 * Clarify に必要な質問を Rule-based に組み立て、LLM Planner の呼び出しを
 * スキップする。
 *
 * @param input DialogInput (/agent.dialog の入力サマリ)
 * @param intent detectIntentHint で推定した intent ヒント
 * @returns PlannerPlan が構築できた場合はその値。未対応 intent などの場合は null。
 */
export function buildRuleBasedPlan(
  input: DialogInput,
  intent: string,
): PlannerPlan | null {
  if (!intent) return null

  switch (intent) {
    case "shipping":
      return buildShippingPlan(input)
    case "returns":
      return buildReturnsPlan(input)
    case "product-info":
      return buildProductInfoPlan(input)
    default:
      return null
  }
/**
 * product-info / 商品情報系の質問に対する Clarify 用 Plan を構築する。
 * ここでは「対象商品」「知りたい側面（サイズ・色・在庫など）」が不足している場合に Clarify を促す。
 */
function buildProductInfoPlan(input: DialogInput): PlannerPlan | null {
  const text = buildCombinedText(input);

  // 商品指定キーワード or 型番風の英数字コード（例: ABC123）のいずれかがあれば「商品あり」とみなす。
  const hasProductKeyword =
    /商品|この商品|その商品|型番|sku|モデル|品番|product|item/i.test(text);
  const hasProductCode =
    /[a-z0-9]{3,}\s*(の|モデル|型|sku|シリーズ)?/i.test(text);
  const hasProduct = hasProductKeyword || hasProductCode;

  const hasAspect =
    /サイズ|size|色|カラー|color|在庫|stock|素材|material|仕様|スペック|寸法|dimension|重さ|重量/i.test(
      text,
    );

  const clarifyingQuestions: string[] = [];

  if (!hasProduct) {
    clarifyingQuestions.push(
      "どの商品についてのご質問でしょうか？（商品名や型番などを教えてください）",
    );
  }
  if (!hasAspect) {
    clarifyingQuestions.push(
      "どのような点について知りたいですか？（サイズ感・色・在庫状況・素材など）",
    );
  }

  if (clarifyingQuestions.length === 0) {
    return null;
  }

  const plan: PlannerPlan = {
    steps: [],
    needsClarification: true,
    clarifyingQuestions,
    followupQueries: [],
    confidence: "low",
    language: input.locale === "en" ? "en" : "ja",
    raw: {
      ruleBased: true,
      intentHint: "product-info",
      missing: {
        product: !hasProduct,
        aspect: !hasAspect,
      },
    },
  };

  return plan;
}
}

/**
 * shipping / delivery 系の質問に対する Clarify 用 Plan を構築する。
 * ここでは「どの商品か」「どこに届けるか」が不足している場合に Clarify を促す。
 */
function buildShippingPlan(input: DialogInput): PlannerPlan | null {
  const text = buildCombinedText(input)

  const hasRegion = /北海道|東北|東京|大阪|名古屋|福岡|沖縄|japan|tokyo|osaka|国内|海外/i.test(
    text,
  )
  const hasProduct =
    /商品|この商品|その商品|注文|型番|sku|モデル|series|model/i.test(text)

  const clarifyingQuestions: string[] = []

  if (!hasProduct) {
    clarifyingQuestions.push(
      "どの商品（またはカテゴリ）についての配送・送料を知りたいですか？",
    )
  }

  if (!hasRegion) {
    clarifyingQuestions.push(
      "お届け先の都道府県（または国）を教えてください。",
    )
  }

  // 情報が十分に揃っていると判断できる場合は LLM Planner にフォールバックする
  if (clarifyingQuestions.length === 0) {
    return null
  }

  const plan: PlannerPlan = {
    steps: [],
    needsClarification: true,
    clarifyingQuestions,
    followupQueries: [],
    confidence: "low",
    language: input.locale === "en" ? "en" : "ja",
    raw: {
      ruleBased: true,
      intentHint: "shipping",
      missing: {
        region: !hasRegion,
        product: !hasProduct,
      },
    },
  } as PlannerPlan

  return plan
}

/**
 * returns / 返品・キャンセル系の質問に対する Clarify 用 Plan を構築する。
 * ここでは「注文番号」「対象商品」「理由」が不足している場合に Clarify を促す。
 */
function buildReturnsPlan(input: DialogInput): PlannerPlan | null {
  const text = buildCombinedText(input)

  const hasOrderId =
    /注文番号|order id|orderid/i.test(text) || /[A-Z0-9]{8,}/.test(text)
  // より緩やかな商品指定判定: キーワード or 注文番号のあとに「の + 名詞」
  const hasItemKeyword = /商品|型番|sku|モデル|product|item/i.test(text)
  // 例: 「注文番号 ABCD1234 のイヤホンをサイズが合わなかったので返品したいです」
  // のように、注文番号のあとに「の + 名詞」が続くパターンも商品指定とみなす
  const hasItemNearOrder =
    /注文番号.*の[^\sを]+/i.test(text) || /order\s*id.*of\s+\S+/i.test(text)
  const hasItem = hasItemKeyword || hasItemNearOrder
  const hasReason =
    /サイズ|イメージ|不良|故障|誤配送|重複|間違えて注文|キャンセル/i.test(text)

  const clarifyingQuestions: string[] = []

  if (!hasOrderId) {
    clarifyingQuestions.push("ご注文番号を教えていただけますか？")
  }
  if (!hasItem) {
    clarifyingQuestions.push(
      "返品したい商品の名前または型番（SKU）を教えてください。",
    )
  }
  if (!hasReason) {
    clarifyingQuestions.push(
      "返品を希望される理由（サイズ違い・イメージ違い・不良品など）を教えてください。",
    )
  }

  // 情報が十分に揃っていると判断できる場合は LLM Planner にフォールバックする
  if (clarifyingQuestions.length === 0) {
    return null
  }

  const plan: PlannerPlan = {
    steps: [],
    needsClarification: true,
    clarifyingQuestions,
    followupQueries: [],
    confidence: "low",
    language: input.locale === "en" ? "en" : "ja",
    raw: {
      ruleBased: true,
      intentHint: "returns",
      missing: {
        orderId: !hasOrderId,
        item: !hasItem,
        reason: !hasReason,
      },
    },
  } as PlannerPlan

  return plan
}

/**
 * ユーザー発話と直近の履歴メッセージを連結して、簡易なテキスト解析に使う。
 */
function buildCombinedText(input: DialogInput): string {
  const historyText =
    input.history?.map((m) => `${m.role}:${m.content}`).join(" ") ?? ""
  return `${input.userMessage ?? ""} ${historyText}`.toLowerCase()
}