// src/agent/memory/memoryDistiller.ts
// Phase71-A: 高スコア会話 → 正規 Q&A 蒸留 → 埋め込み → learned_memory 保存
//
// Judge 評価 (evaluateSession) の fire-and-forget フックから呼ばれる。
// 失敗しても本番フローに伝播させない (呼び出し側で setImmediate + catch)。

import pino from "pino";

import { groqClient } from "../llm/groqClient";
import { GPT_OSS_120B } from "../../config/groqModels";
import { embedText } from "../llm/openaiEmbeddingClient";
import { getPool } from "../../lib/db";
import { getNonConvertingOutcomes } from "../../api/admin/chat-history/chatHistoryRepository";
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

/**
 * 蒸留対象とする最低メッセージ数。1往復未満(挨拶のみ等)を除外する。
 * ナレッジ配線是正P15: analytics/ignitionStatus.ts の点火ゲート可視化からも
 * この定数をそのまま import して使う(マジックナンバーの第2の置き場を作らない)。
 */
export const MIN_MESSAGES_FOR_DISTILL = 2;

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
    model: GPT_OSS_120B,
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
 * GID 1216978660043409 (PR-17, R9 / D2): セッションが「CV/outcomeを伴う会話」かを判定する。
 * Judge スコアが高い = 売れた ではない。スコア単独で learned_memory に昇格させると、
 * Judge が動き出した瞬間に「売れていない高スコア会話」由来の知見が大量に混入する。
 *
 * 判定は以下いずれかを満たすこと:
 *   - conversion_attributions に当該セッションの行がある(構造化されたCVイベント)
 *   - chat_sessions.outcome が設定済みで、かつテナントの conversion_types の
 *     非成約終端2件(既定 '離脱'/'不明'、abResultsOutcomeSync.ts と同じ判定)でない
 *
 * getNonConvertingOutcomes (chatHistoryRepository.ts) を abResultsOutcomeSync.ts と
 * 共有する唯一の情報源として使う(第2の判定ロジックを作らない)。
 *
 * conversion_types が3件未満で「末尾2件が非成約」の慣習が成立しないテナントでは、
 * outcome 単独では昇格させない(conversion_attributions があればそちらは曖昧さが
 * 無いため引き続き昇格する)。学習データに失注会話の知見を紛れ込ませる方が、
 * 昇格を1件見送るより実害が大きいため安全側に倒す。
 *
 * ナレッジ配線是正P15: analytics/ignitionStatus.ts の点火ゲート可視化からも
 * この関数をそのまま import して使う(第2の判定ロジックを作らない)。
 */
export async function hasConvertingOutcome(tenantId: string, sessionId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ has_attribution: boolean; outcome: string | null }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM conversion_attributions ca
         WHERE ca.session_id = cs.id
       ) AS has_attribution,
       cs.outcome
     FROM chat_sessions cs
     WHERE cs.tenant_id = $1 AND cs.session_id = $2
     LIMIT 1`,
    [tenantId, sessionId],
  );
  const row = result.rows[0];
  if (!row) return false;
  if (row.has_attribution) return true;
  if (!row.outcome) return false;

  const { nonConvertingOutcomes, reliable } = await getNonConvertingOutcomes(tenantId);
  if (!reliable) {
    logger.warn(
      { tenantId },
      "[learnedMemory] conversion_types has fewer than 3 entries; outcome-based promotion is unreliable, skipping",
    );
    return false;
  }
  return !nonConvertingOutcomes.includes(row.outcome);
}

/**
 * 高スコア会話を蒸留して learned_memory に保存する。
 *
 * ガード:
 *   - Feature Flag (write) オフ → 何もしない
 *     (LEARNED_MEMORY_TENANTS による段階開放は本PRで変更しない。CV/outcome判定とは
 *      独立なゲートで、両方を満たしたテナント・セッションのみが昇格する)
 *   - judgeScore < 閾値 → 何もしない
 *   - メッセージ 2 未満 → 何もしない
 *   - D2: CV/outcomeを伴わない会話 → 何もしない(高スコアなだけでは昇格しない)
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

  if (messages.length < MIN_MESSAGES_FOR_DISTILL) return false;

  try {
    // D2: Groq課金(蒸留)の前に、CVを伴わない高スコア会話を弾く。
    if (!(await hasConvertingOutcome(tenantId, sessionId))) {
      logger.debug(
        { tenantId, sessionId, judgeScore },
        "[learnedMemory] high score but no conversion/outcome, skip",
      );
      return false;
    }

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
      metadata: { distilled_by: GPT_OSS_120B },
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
