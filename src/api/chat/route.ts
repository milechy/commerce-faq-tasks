import type { Request, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { runDialogTurn } from "../../agent/dialog/dialogAgent";
import type { ApiResponse, ChatAction, ChatMessage } from "../../types/contracts";

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
        message: "入力内容に誤りがあります。確認してから再試行してください。",
        issues,
        requestId,
        tenantId,
      });
      return;
    }

    const body = parsed.data;

    logger.info(
      {
        requestId,
        tenantId,
        sessionId: body.sessionId ?? body.conversationId,
        messageLength: body.message.length,
        hasHistory: (body.history?.length ?? 0) > 0,
        language: body.options?.language ?? "ja",
      },
      "chat.request.received"
    );

    try {
      const result = await runDialogTurn({
        sessionId: body.sessionId ?? body.conversationId,
        message: body.message,
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

      let content: string;
      if (result.answer) {
        content = result.answer;
      } else if (
        result.needsClarification &&
        result.clarifyingQuestions &&
        result.clarifyingQuestions.length > 0
      ) {
        content = result.clarifyingQuestions[0];
      } else {
        content =
          "申し訳ありません。現在回答を生成できませんでした。再度お試しください。";
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
      };

      res.status(200).json(response);
    } catch (err) {
      logger.error(
        { requestId, tenantId, err },
        "chat.request.error"
      );

      const response: ApiResponse<never> = {
        error: "内部エラーが発生しました。しばらくしてから再試行してください。",
        requestId,
        tenantId,
      };

      res.status(500).json(response);
    }
  };
}
