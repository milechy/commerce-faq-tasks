// src/agent/memory/memoryDistiller.ts
// Phase71-A: 高スコア会話 → 正規 Q&A 蒸留 → 埋め込み → learned_memory 保存
//
// Judge 評価 (evaluateSession) の fire-and-forget フックから呼ばれる。
// 失敗しても本番フローに伝播させない (呼び出し側で setImmediate + catch)。

import pino from "pino";

import { groqClient } from "../llm/groqClient";
import { GROQ_VERSATILE_70B } from "../../config/groqModels";
import { embedText } from "../llm/openaiEmbeddingClient";
import {
  isLearnedMemoryWriteEnabled,
  getLearnedMemoryThreshold,
} from "./featureFlag";
import {
  createLearnedMemoryRepository,
  type LearnedMemoryEntry,
} from "./learnedMemoryRepository";

const logger = pino();

export interface DistillSourceMessage {
  role: string;
  content: string;
}

export interface DistillParams {
  tenantId: string;
  sessionId: string;
  judgeScore: number;
  messages: DistillSourceMessage[];
}

interface DistilledQa {
  question: string;
  answer: string;
}

const DISTILL_SYSTEM_PROMPT = `あなたは営業チャットの会話ログから「再利用可能な正規Q&A」を1つだけ抽出する専門家です。
顧客の中心的な質問・関心を1つの簡潔な質問にまとめ、AIの応答のうち最も効果的だった部分を簡潔な模範回答にまとめてください。
個人情報・固有名詞・一回限りの文脈は除き、他の顧客にも再利用できる汎用的な形にしてください。
JSONのみで回答してください: {"question":"...","answer":"..."}
有用なQ&Aが抽出できない場合は {"question":"","answer":""} を返してください。`;

/**
 * Groq で会話ログを正規 Q&A に蒸留する。抽出不能なら null。
 */
async function distillConversation(
  messages: DistillSourceMessage[],
): Promise<DistilledQa | null> {
  // Anti-Slop: 各発話 200 文字に制限 (judgeEvaluator と同方針)
  const conversationLog = messages
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const raw = await groqClient.call({
    model: GROQ_VERSATILE_70B,
    messages: [
      { role: "system", content: DISTILL_SYSTEM_PROMPT },
      { role: "user", content: conversationLog },
    ],
    temperature: 0.2,
    maxTokens: 500,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const question =
    typeof parsed["question"] === "string" ? parsed["question"].trim() : "";
  const answer =
    typeof parsed["answer"] === "string" ? parsed["answer"].trim() : "";

  if (!question || !answer) return null;
  return { question, answer };
}

/**
 * 高スコア会話を蒸留して learned_memory に保存する。
 *
 * ガード:
 *   - Feature Flag (write) オフ → 何もしない
 *   - judgeScore < 閾値 → 何もしない
 *   - メッセージ 2 未満 → 何もしない
 *   - 蒸留失敗 → 何もしない
 *
 * @returns 保存されたら true
 */
export async function distillAndPromote(
  params: DistillParams,
): Promise<boolean> {
  const { tenantId, sessionId, judgeScore, messages } = params;

  if (!isLearnedMemoryWriteEnabled(tenantId)) return false;

  const threshold = getLearnedMemoryThreshold();
  if (judgeScore < threshold) {
    logger.debug(
      { tenantId, sessionId, judgeScore, threshold },
      "[learnedMemory] score below threshold, skip",
    );
    return false;
  }

  if (messages.length < 2) return false;

  try {
    const qa = await distillConversation(messages);
    if (!qa) {
      logger.debug({ tenantId, sessionId }, "[learnedMemory] distill yielded no Q&A");
      return false;
    }

    const embedding = await embedText(qa.question);

    const entry: LearnedMemoryEntry = {
      tenantId,
      question: qa.question,
      answer: qa.answer,
      embedding,
      sourceSessionId: sessionId,
      judgeScore,
      metadata: { distilled_by: GROQ_VERSATILE_70B },
    };

    const repo = createLearnedMemoryRepository();
    const inserted = await repo.saveLearnedMemory(entry);

    logger.info(
      { tenantId, sessionId, judgeScore, inserted },
      inserted
        ? "[learnedMemory] promoted high-score conversation"
        : "[learnedMemory] already promoted (dedup)",
    );
    return inserted;
  } catch (err) {
    logger.warn(
      { err, tenantId, sessionId },
      "[learnedMemory] distillAndPromote failed (non-blocking)",
    );
    return false;
  }
}
