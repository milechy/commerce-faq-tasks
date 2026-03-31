import type { Request, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { randomUUID } from "crypto";
import { runDialogTurn } from "../../agent/dialog/dialogAgent";
import { trackUsage } from "../../lib/billing/usageTracker";
import type { ApiResponse, ChatAction, ChatMessage } from "../../types/contracts";
import { t } from "../i18n/messages";
import type { Lang } from "../i18n/messages";
import { saveMessage } from "../admin/chat-history/chatHistoryRepository";
import { saveKnowledgeGap } from "../admin/knowledge/knowledgeGapRepository";
import { analyzeSentiment } from "../../lib/sentiment/client";
import { sanitizeInput, sanitizeOutput, blockReasonToMessage } from "../../lib/security/inputSanitizer";
import { sanitizeInput as l5SanitizeInput, sessionHistoryStore } from "../../middleware/inputSanitizer";
import { applyPromptFirewall } from "../../middleware/promptFirewall";
import { checkTopic } from "../../middleware/topicGuard";
import { guardOutput } from "../../middleware/outputGuard";

// チャットリクエストで使用するデフォルトLLMモデル名（コスト計算用）
const CHAT_LLM_MODEL = process.env.LLM_CHAT_MODEL ?? "llama-3.3-70b-versatile";

// ---------------------------------------------------------------------------
// ナレッジギャップ検出
// ---------------------------------------------------------------------------

/** RAGシグナルに基づくギャップ判定 */
function isKnowledgeGap(gapSignal?: { hitCount: number; topScore: number }): boolean {
  if (!gapSignal) return false;
  if (gapSignal.hitCount === 0) return true;
  if (gapSignal.topScore < 0.3) return true;
  return false;
}

/** LLM回答文言に基づくギャップ判定（フォールバック） */
const GAP_PHRASES = [
  "記載がありません", "お答えできません", "情報がありません",
  "見つかりませんでした", "FAQに含まれていません",
  "not found", "no information", "cannot answer",
];

function isResponseGap(content: string): boolean {
  return GAP_PHRASES.some((phrase) => content.includes(phrase));
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

const ChatOptionsSchema = z.object({
  language: z.enum(["ja", "en", "auto"]).default("ja"),
  piiMode: z.boolean().default(false),
  topK: z.number().int().min(1).max(50).optional(),
  useLlmPlanner: z.boolean().optional(),
  useMultiStepPlanner: z.boolean().optional(),
  mode: z.enum(["local", "crew"]).optional(),
  personaTags: z.array(z.string().max(64)).max(10).optional(),
  debug: z.boolean().optional(),
});

const DialogMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(4000),
});

export const ChatRequestSchema = z.object({
  message: z
    .string()
    .min(1, "メッセージを入力してください")
    .max(2000, "メッセージは2000文字以内で入力してください"),
  conversationId: z.string().uuid().optional(),
  sessionId: z.string().max(128).optional(),
  history: z.array(DialogMessageSchema).max(50).optional(),
  options: ChatOptionsSchema.optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ---------------------------------------------------------------------------
// ルートハンドラ
// ---------------------------------------------------------------------------

export function createChatHandler(logger: Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId;
    // tenantId は authMiddleware が JWT/APIキーから設定する（bodyから取得禁止）
    const tenantId = (req as Request & { tenantId?: string }).tenantId ?? "demo-tenant";
    // Phase33: lang は langDetectMiddleware が設定する（フォールバック: "ja"）
    const lang: Lang = (req as any).lang ?? "ja";

    // Zod バリデーション
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));

      logger.warn({ requestId, tenantId, issues }, "chat.request.validation_failed");

      res.status(400).json({
        error: "validation_error",
        message: t("error.validation", lang),
        issues,
        requestId,
        tenantId,
        lang,
      });
      return;
    }

    const body = parsed.data;

    // セキュリティ: 入力サニタイズ（URL拒否 + XSS防止）
    const inputCheck = sanitizeInput(body.message);
    if (!inputCheck.safe) {
      res.status(400).json({
        data: {
          role: "assistant",
          content: blockReasonToMessage(inputCheck.reason ?? "blocked_content", lang),
        },
      });
      return;
    }

    // Phase38: セッションIDを確定（クライアント指定 → conversationId → 新規生成）
    const sessionId: string =
      body.sessionId ?? body.conversationId ?? randomUUID();

    // L5: Input Sanitizer (Phase48)
    const sanitizeResult = l5SanitizeInput(body.message, body.conversationId ?? 'anon', sessionHistoryStore);
    if (!sanitizeResult.allowed) {
      if (sanitizeResult.shouldTerminateSession) {
        res.status(403).json({ error: sanitizeResult.userFacingMessage ?? 'セッションが終了しました。' });
      } else {
        res.status(400).json({ error: sanitizeResult.userFacingMessage ?? 'メッセージを確認してください。' });
      }
      return;
    }
    const sanitizedMessage = sanitizeResult.sanitizedMessage ?? body.message;

    // L7: Prompt Firewall (Phase48)
    const firewallResult = applyPromptFirewall(sanitizedMessage);
    if (!firewallResult.allowed) {
      res.status(400).json({ error: firewallResult.userFacingMessage ?? 'その質問にはお答えできません。' });
      return;
    }

    // L6: Topic Guard (Phase48)
    const topicResult = await checkTopic(firewallResult.sanitizedMessage, tenantId, body.conversationId ?? 'anon');
    if (!topicResult.allowed) {
      const status = topicResult.shouldTerminateSession ? 403 : 400;
      res.status(status).json({ error: topicResult.userFacingMessage ?? 'ご質問の内容が対応範囲外です。' });
      return;
    }

    logger.info(
      {
        requestId,
        tenantId,
        sessionId,
        messageLength: body.message.length,
        hasHistory: (body.history?.length ?? 0) > 0,
        language: body.options?.language ?? "ja",
      },
      "chat.request.received"
    );

    // Phase38: ユーザーメッセージをDBに保存（fire-and-forget）
    saveMessage({
      tenantId,
      sessionId,
      role: "user",
      content: body.message,
    }).catch((err) =>
      logger.warn({ err }, "[chat-history] save user message failed")
    );

    // Phase51: sentiment分析（fire-and-forget、レスポンスをブロックしない）
    analyzeSentiment(body.message).then(async (result) => {
      if (!result) return;
      try {
        const { getPool } = await import("../../lib/db");
        const db = getPool();
        await db.query(
          `UPDATE chat_messages SET sentiment = $1
           WHERE id = (
             SELECT m.id FROM chat_messages m
             JOIN chat_sessions s ON s.id = m.session_id
             WHERE s.session_id = $2 AND m.role = 'user'
             ORDER BY m.created_at DESC LIMIT 1
           )`,
          [JSON.stringify(result), sessionId]
        );
      } catch {
        // silent — non-blocking
      }
    }).catch(() => {});

    try {
      const result = await runDialogTurn({
        sessionId,
        tenantId,
        message: firewallResult.sanitizedMessage,
        history: body.history,
        options: body.options
          ? {
              language: body.options.language,
              topK: body.options.topK,
              useLlmPlanner: body.options.useLlmPlanner,
              useMultiStepPlanner: body.options.useMultiStepPlanner,
              mode: body.options.mode,
              personaTags: body.options.personaTags,
              debug: body.options.debug,
            }
          : undefined,
      });

      // L8: Output Guard (Phase48)
      const outputResult = guardOutput(result.answer ?? '');
      const guardedAnswer = result.answer ? outputResult.sanitizedResponse : result.answer;

      let content: string;
      if (guardedAnswer) {
        content = sanitizeOutput(guardedAnswer);
      } else if (
        result.needsClarification &&
        result.clarifyingQuestions &&
        result.clarifyingQuestions.length > 0
      ) {
        content = result.clarifyingQuestions[0];
      } else {
        content =
          lang === "en"
            ? "Sorry, we could not generate a response at this time. Please try again."
            : "申し訳ありません。現在回答を生成できませんでした。再度お試しください。";
      }

      const actions: ChatAction[] = [];
      if (result.detectedIntents?.proposeIntent === "visit_booking") {
        actions.push({
          type: "booking",
          label: "来店予約はこちら",
          url: "https://www.s-time.co.jp/reservation/",
        });
      }

      const chatMessage: ChatMessage = {
        id: requestId,
        role: "assistant",
        content,
        actions: actions.length > 0 ? actions : undefined,
        timestamp: Date.now(),
        tenantId,
      };

      logger.info(
        {
          requestId,
          tenantId,
          answerLength: result.answer?.length ?? 0,
          // RAG excerpts の内容そのものはログ出力しない（書籍内容漏洩防止）
          hasAnswer: result.answer !== null,
          needsClarification: result.needsClarification,
        },
        "chat.request.completed"
      );

      const response: ApiResponse<ChatMessage> = {
        data: chatMessage,
        requestId,
        tenantId,
        lang,
      };

      res.status(200).json(response);

      // Phase38+: ナレッジギャップ検出 + 保存（fire-and-forget）
      const gapSignal = result.meta?.gapSignal;
      if (isKnowledgeGap(gapSignal) || isResponseGap(content)) {
        saveKnowledgeGap({
          tenantId,
          userQuestion: body.message,
          sessionId,
          ragHitCount: gapSignal?.hitCount ?? 0,
          ragTopScore: gapSignal?.topScore ?? 0,
        }).catch((err) =>
          logger.warn({ err }, "[knowledge-gap] save failed")
        );
      }

      // Phase38: アシスタント応答をDBに保存（fire-and-forget、レスポンス後）
      saveMessage({
        tenantId,
        sessionId,
        role: "assistant",
        content,
        metadata: {
          model: (result as any).meta?.route,
          ragStats: (result as any).meta?.ragStats,
          rag_hit_count: gapSignal?.hitCount ?? 0,
          rag_top_score: gapSignal?.topScore ?? 0,
          knowledge_gap: isKnowledgeGap(gapSignal) || isResponseGap(content),
        },
      }).catch((err) =>
        logger.warn({ err }, "[chat-history] save assistant message failed")
      );

      // fire-and-forget: 使用量記録（APIレスポンスをブロックしない）
      const historyText = (body.history ?? []).map((m) => m.content).join("\n");
      const inputTokens = Math.max(1, Math.round((body.message.length + historyText.length) / 4));
      const outputTokens = Math.max(1, Math.round(content.length / 4));
      trackUsage({
        tenantId,
        requestId,
        model: CHAT_LLM_MODEL,
        inputTokens,
        outputTokens,
        featureUsed: "chat",
      });
    } catch (err) {
      logger.error(
        { requestId, tenantId, err },
        "chat.request.error"
      );

      const response: ApiResponse<never> = {
        error: t("error.server", lang),
        requestId,
        tenantId,
        lang,
      };

      res.status(500).json(response);
    }
  };
}
