// src/agent/psychology/principleDetector.ts
// Phase44: 心理学原則検出器
// キーワードマッチング + Groq 8b LLMフォールバック

import { groqClient } from '../llm/groqClient';

const KEYWORD_MAP: Record<string, string[]> = {
  "アンカリング効果":      ["高い", "値段", "価格", "費用", "コスト", "予算"],
  "損失回避":             ["損", "リスク", "失う", "もったいない", "後悔"],
  "社会的証明":           ["他社", "他の", "みんな", "人気", "評判", "口コミ"],
  "希少性":               ["限定", "残り", "在庫", "期間限定", "今だけ"],
  "コミットメントと一貫性": ["迷", "考え", "検討", "悩", "どうしよう"],
  "フレーミング効果":      ["比べ", "比較", "違い", "どちら", "選ぶ"],
  "返報性":               ["サービス", "おまけ", "特典", "無料"],
};

const SALES_STAGES = new Set(["propose", "recommend", "close"]);

export interface PrincipleDetectionResult {
  principles: string[];   // 最大3つ
  method: "keyword" | "llm";
}

/**
 * 直近3件のユーザーメッセージからキーワードマッチで心理学原則を検出する。
 * マッチなし → Groq 8b (llama3-8b-8192) でLLM判定（フォールバック）。
 * salesStage が propose/recommend/close の場合、最低1原則を返す。
 *
 * セキュリティ: LLMに渡すメッセージ内容は slice(0,500) でトリミング
 */
export async function detectPrinciples(
  recentMessages: Array<{ role: string; content: string }>,
  salesStage?: string,
): Promise<PrincipleDetectionResult> {
  // 直近3件のユーザーメッセージを結合
  const userMessages = recentMessages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content)
    .join(" ");

  // キーワードマッチング
  const matched: string[] = [];
  for (const [principle, keywords] of Object.entries(KEYWORD_MAP)) {
    if (keywords.some((kw) => userMessages.includes(kw))) {
      matched.push(principle);
      if (matched.length >= 3) break;
    }
  }

  if (matched.length > 0) {
    return { principles: matched.slice(0, 3), method: "keyword" };
  }

  // LLMフォールバック（Groq 8b）
  const llmPrinciples = await detectWithLlm(userMessages, salesStage);

  // salesStage が propose/recommend/close の場合、最低1原則を保証
  if (llmPrinciples.length === 0 && salesStage && SALES_STAGES.has(salesStage)) {
    // デフォルトとして「コミットメントと一貫性」を返す（検討中のユーザーに有効）
    return { principles: ["コミットメントと一貫性"], method: "llm" };
  }

  return { principles: llmPrinciples.slice(0, 3), method: "llm" };
}

async function detectWithLlm(
  userMessages: string,
  salesStage?: string,
): Promise<string[]> {
  const apiKey = process.env.QWEN_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) {
    return [];
  }

  // セキュリティ: 書籍内容漏洩防止のため500文字でトリミング
  const trimmedContent = userMessages.slice(0, 500);

  const principleNames = Object.keys(KEYWORD_MAP).join("、");
  const stageContext = salesStage ? `\n現在の営業ステージ: ${salesStage}` : "";

  try {
    const response = await groqClient.call({
      model: "llama3-8b-8192",
      messages: [
        {
          role: "system",
          content: `あなたは営業心理学の専門家です。以下の心理学原則の中から適切なものを選んでください: ${principleNames}`,
        },
        {
          role: "user",
          content: `以下の会話から、営業で有効な心理学原則を最大3つ選んでください。出力はJSON配列のみ: ["原則名", ...]${stageContext}\n\n会話内容:\n${trimmedContent}`,
        },
      ],
      temperature: 0,
      maxTokens: 100,
      tag: "principle-detection",
    });

    // JSON配列のみを抽出してパース
    const jsonMatch = response.match(/\[.*?\]/s);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    // 既知の原則名のみを返す（インジェクション防止）
    const validPrinciples = Object.keys(KEYWORD_MAP);
    return parsed
      .filter((p): p is string => typeof p === "string" && validPrinciples.includes(p))
      .slice(0, 3);
  } catch {
    return [];
  }
}
