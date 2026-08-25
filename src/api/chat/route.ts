import { GPT_OSS_120B } from '../../config/groqModels';
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { randomUUID } from "crypto";
import { runDialogTurn } from "../../agent/dialog/dialogAgent";
import { getSalesSessionMeta } from "../../agent/dialog/salesContextStore";
import { trackUsage } from "../../lib/billing/usageTracker";
import type { ApiResponse, ChatAction, ChatMessage } from "../../types/contracts";
import { t } from "../i18n/messages";
import type { Lang } from "../i18n/messages";
import { saveMessage } from "../admin/chat-history/chatHistoryRepository";
import { resolveTrafficSource, TRAFFIC_SOURCE_HEADER } from "../../lib/traffic/trafficSource";
import { detectGap } from "../../agent/gap/gapDetector";
import { analyzeSentiment } from "../../lib/sentiment/client";
import { sanitizeInput, sanitizeOutput, blockReasonToMessage } from "../../lib/security/inputSanitizer";
import { sanitizeInput as l5SanitizeInput, sessionHistoryStore } from "../../middleware/inputSanitizer";
import { applyPromptFirewall } from "../../middleware/promptFirewall";
import { checkTopic } from "../../middleware/topicGuard";
import { guardOutput } from "../../middleware/outputGuard";
import { detectPiiRoute } from "../../agent/avatar/piiRouteDetector";
import { getTenantPlan } from "../../lib/billing/planFeatures";
import { getCachedShareConsent } from "../../lib/hermesConsent";
import { getMonthRangeJst, isFreeAdMonthlyQuotaExceeded } from "../../lib/billing/planQuota";
import { getPool } from "../../lib/db";

// チャットリクエストで使用するデフォルトLLMモデル名（コスト計算用）
const CHAT_LLM_MODEL = process.env.LLM_CHAT_MODEL ?? GPT_OSS_120B;

// ---------------------------------------------------------------------------
// free_ad プランの月次上限判定（Asana 1217759064329998 item(7)）
// ---------------------------------------------------------------------------

/**
 * free_ad プランのテナントに限り、当月の usage_logs(feature_used='chat') 件数が
 * 上限に達しているかを判定する。free_ad 以外のプランは常に false（既存動作は
 * 一切変えない）。上限・月次境界の計算自体は src/lib/billing/planQuota.ts の
 * 純関数に委ね、ここでは DB 集計のみを行う。
 *
 * fail-open: plan取得・集計クエリのいずれかが失敗した場合は false（ブロックしない）
 * を返す。エンタイトルメント判定(機能を隠す側)は最も制限の強い方へ倒すのが
 * 正しい方向だが、ここは「既に受理されたチャットリクエストを処理してよいか」の
 * 可用性の話であり、billing系の一時的な障害(pool未初期化・DB瞬断)で
 * 全テナントのチャットが止まるほうが実害が大きい。DB接続自体の障害時は
 * queryTenantPlan 内部のcatchで既に free_ad にfail-safeされる(意図どおり)ため、
 * ここで追加で捕まえるのは getPool() 自体が投げるケース(未初期化)のみ。
 *
 * 数え方は「このリクエストの前に何件あったか」。trackUsage は setImmediate の
 * fire-and-forget（本関数の呼び出し時点ではまだ当該行がINSERTされていない）ため、
 * ごく短時間の連続リクエストでは上限を若干超えて許可されうるが、費用面のソフトな
 * ガードであり、原価上限は許容範囲内に収まる（planQuota.ts のコメント参照）。
 *
 * @param now 月次境界の計算基準時刻。省略時は呼び出し時点の現在時刻(既定動作)。
 *   テストから月境界ちょうどのリクエストを再現できるように注入可能にしている
 *   （route.freeAdQuota.test.ts の月境界統合テスト参照）。
 */
async function isFreeAdQuotaExceededForTenant(
  tenantId: string,
  logger: Logger,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const plan = await getTenantPlan(tenantId);
    if (plan !== "free_ad") return false;

    const { monthStart, monthEnd } = getMonthRangeJst(now);
    const pool = getPool();
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM usage_logs
        WHERE tenant_id = $1
          AND feature_used = 'chat'
          AND created_at >= $2
          AND created_at <  $3`,
      [tenantId, monthStart, monthEnd],
    );
    const currentMonthRequestCount = Number(result.rows[0]?.count ?? 0);
    return isFreeAdMonthlyQuotaExceeded(currentMonthRequestCount);
  } catch (err) {
    logger.warn({ tenantId, err }, "chat.request.free_ad_quota_check_failed");
    return false;
  }
}

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

const ChatRequestSchema = z.object({
  message: z
    .string()
    .min(1, "メッセージを入力してください")
    .max(2000, "メッセージは2000文字以内で入力してください"),
  conversationId: z.string().uuid().optional(),
  sessionId: z.string().max(128).optional(),
  history: z.array(DialogMessageSchema).max(50).optional(),
  options: ChatOptionsSchema.optional(),
  /** Phase57: Widget の EventTracker が生成した visitor_id */
  visitor_id: z.string().max(128).optional(),
});

type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ---------------------------------------------------------------------------
// ルートハンドラ
// ---------------------------------------------------------------------------

export function createChatHandler(logger: Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId;
    // Phase33: lang は langDetectMiddleware が設定する（フォールバック: "ja"）
    const lang: Lang = (req as any).lang ?? "ja";
    // tenantId は authMiddleware が JWT/APIキーから設定する（bodyから取得禁止）
    const tenantId = (req as Request & { tenantId?: string }).tenantId;
    if (!tenantId) {
      logger.warn({ requestId }, "chat.request.tenant_unresolved");
      res.status(401).json({
        error: "unauthorized",
        message: t("error.unauthorized", lang),
        requestId,
      });
      return;
    }
    // GID 1216970103691946: 実ユーザー/E2E/chat-test/デモの判定（セッション新規作成時のみ記録）
    const trafficSource = resolveTrafficSource({
      headerValue: req.header(TRAFFIC_SOURCE_HEADER),
      userAgent: req.header("user-agent"),
      referer: req.header("referer"),
      isChatTestToken: (req as any).isChatTestToken === true,
    });

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
    //
    // 空文字・空白のみは「未指定」として扱い、?? ではなく || で次候補へ落とす。
    // zod は max(128) のみで min(1) が無いため {"sessionId": ""} は検証を通過し、
    // ?? は null/undefined しか拾わないため '' がそのまま session_id になっていた。
    // '' が使われると実害が2つ出る:
    //   1. chat_sessions の upsert は ON CONFLICT (tenant_id, session_id) のため、
    //      '' を送った全クライアントが1つのセッション行を共有し、別々の訪問者の
    //      会話が1本にマージされる(message_count も無限に加算される)。
    //   2. selectVariant の stickyKey は '' が falsy のため Math.random() に落ち、
    //      A/B variant が1会話の中でメッセージ毎に振り直される(CLAUDE.md 禁止36)。
    const sessionId: string =
      body.sessionId?.trim() || body.conversationId || randomUUID();

    // free_ad プランの月次上限（Asana 1217759064329998）。free_ad 以外のテナントは
    // isFreeAdQuotaExceededForTenant が即 false を返すため既存動作は変わらない。
    // 403 plan_upgrade_required は正常系の分岐であり、エラーではない
    // （CLAUDE.md 絶対にやってはいけないこと21。赤帯にしない・「0件」と描画しない
    // のはフロント側の責務。ここでは構造化した理由コードのみ返す）。
    if (await isFreeAdQuotaExceededForTenant(tenantId, logger)) {
      logger.info({ requestId, tenantId }, "chat.request.free_ad_quota_exceeded");
      res.status(403).json({
        error: "plan_upgrade_required",
        message: t("error.free_ad_quota_exceeded", lang),
        requestId,
        tenantId,
        lang,
      });
      return;
    }

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

    // PII導線検知（既存 L5/L7/L6 防御層の隣で判定する）。detectPiiRoute は
    // 依存ゼロの純関数(src/agent/avatar/piiRouteDetector.ts)。クライアントが
    // 送る options.piiMode は信用せず、ここで判定した値のみを使う。
    const piiCheck = detectPiiRoute({
      userMessage: firewallResult.sanitizedMessage,
      history: body.history?.filter(
        (m): m is { role: "user" | "assistant"; content: string } => m.role !== "system"
      ),
    });

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
      metadata: piiCheck.isPiiRoute
        ? { piiRoute: true, piiReasons: piiCheck.reasons }
        : undefined,
      trafficSource,
      visitorId: body.visitor_id || undefined,
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
        options: {
          ...(body.options
            ? {
                language: body.options.language,
                topK: body.options.topK,
                useLlmPlanner: body.options.useLlmPlanner,
                useMultiStepPlanner: body.options.useMultiStepPlanner,
                mode: body.options.mode,
                personaTags: body.options.personaTags,
                debug: body.options.debug,
              }
            : {}),
          visitorId: body.visitor_id || undefined,
          // クライアント供給値ではなく、サーバ側で判定した値を渡す
          piiMode: piiCheck.isPiiRoute,
        },
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

      // LemonSlice I-4: フロー状態を応答に含める（アバター表情連動用、副作用なし getter）
      // /api/chat パス（runDialogTurn）が salesContextStore を更新する唯一の書き手。
      // "ended" は表情マッピング対象外のため undefined を返す。
      const salesStage = getSalesSessionMeta({ tenantId, sessionId })?.currentStage;
      const flowState = salesStage !== "ended" ? salesStage : undefined;

      // S6: 開示バナーのバックストップ。/api/widget/features が失敗しても、
      // 会話が成立する限りこちらで開示できるようにする。この判定自体が失敗しても
      // チャット応答は絶対に止めない(fail-safe: undefinedのままにする。
      // widget側は data_shared_externally が無ければ何もしない=バナーを出さない側に
      // 倒れるため、通信障害時に「共有していない」と誤表示することはない)。
      let dataSharedExternally: boolean | undefined;
      try {
        dataSharedExternally = await getCachedShareConsent(tenantId);
      } catch {
        dataSharedExternally = undefined;
      }

      const chatMessage: ChatMessage = {
        id: requestId,
        role: "assistant",
        content,
        actions: actions.length > 0 ? actions : undefined,
        timestamp: Date.now(),
        tenantId,
        flowState,
        // LemonSliceペルソナスワップ: queryPlanner が推定した質問カテゴリ（アバター見た目・人格切替用）
        ragCategory: result.meta?.ragCategory,
        // Phase73: recommend ステージで productCard が設定されていれば転送
        ...(result.productCard ? { productCard: result.productCard } : {}),
        data_shared_externally: dataSharedExternally,
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

      // Phase38+/2026-08-25(P10): ナレッジギャップ検出は detectGap(gapDetector.ts)
      // に一本化する(第2の起票経路を作らない)。no_rag/low_confidence は
      // synthesisTool.ts の detectGap 呼び出しが同じ gapSignal で既に判定済みのため、
      // ここで同条件を再検出すると同一メッセージの frequency を二重加算してしまう
      // (upsertGap は7日以内ILIKE一致の既存行を見つけて+1する)。
      // ここで拾うのは「ヒットはあり信頼度も十分だったのに、LLMの応答文面が
      // 未回答を示している」ケースのみ — synthesisTool.ts 側では検出できない
      // 固有の信号であり、fallback として記録する。
      const gapSignal = result.meta?.gapSignal;
      const hasConfidentHit = (gapSignal?.hitCount ?? 0) > 0 && (gapSignal?.topScore ?? 0) >= 0.3;
      if (isResponseGap(content) && hasConfidentHit) {
        detectGap({
          tenantId,
          sessionId,
          userMessage: body.message,
          ragResultCount: gapSignal?.hitCount ?? 0,
          topRerankScore: gapSignal?.topScore,
          templateSource: "fallback",
        }).catch((err) =>
          logger.warn({ err }, "[knowledge-gap] detect failed")
        );
      }

      // Phase38: アシスタント応答をDBに保存（fire-and-forget、レスポンス後）
      // Phase68: ragSources を専用カラムに記録してナレッジCV影響度集計に利用する
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
          // GID 1216978677398163 (PR-14): ルール効果測定(ruleEffect.ts)の母集団判定に使う
          applied_rule_ids: result.appliedRuleIds ?? [],
          ...(piiCheck.isPiiRoute
            ? { piiRoute: true, piiReasons: piiCheck.reasons }
            : {}),
        },
        ragSources: result.meta?.ragSources,
        trafficSource,
        promptVariantId: result.promptVariantId,
        promptVariantName: result.promptVariantName,
        visitorId: body.visitor_id || undefined,
      }).catch((err) =>
        logger.warn({ err }, "[chat-history] save assistant message failed")
      );

      // fire-and-forget: 使用量記録（APIレスポンスをブロックしない）
      // Subtask 3 構造修正: 回答経路（searchAgent/orchestrator）が chat モデルの実トークンを
      // 常に報告する（chat LLM 未実行なら {0,0}、embedding 消費分は内包済み）。
      // よって char/4 ヒューリスティック推定は廃止し、実 usage を唯一のソースにする。
      const llmUsage = result.meta?.llmUsage ?? { prompt_tokens: 0, completion_tokens: 0 };
      const inputTokens = llmUsage.prompt_tokens;
      const outputTokens = llmUsage.completion_tokens;

      // マルチステップ planner LLM（GPT-OSS 20B/120B）は chat 本体（70B）とはモデル単価が
      // 異なる。usage_logs は「1行=1リクエスト」（Stripe quantity=COUNT(*)）のため別行は作らず、
      // 本 chat 行の cost に planner 分をモデル別実レートで内包させる。
      // PR-2(2026-08-25収益監査): クエリ埋め込み(OpenAI)も同じ理由で内包する。
      // 以前は searchAgent.ts が chat モデルの prompt_tokens に直接合算しており、
      // embedding($0.02/1M)が chat モデル(はるかに高レート)で計上され、かつ
      // embedTextWithUsage 自身が別途 tenant_id='unknown' の行も作っていた(二重計上)。
      const embeddingUsage = result.meta?.embeddingUsage;
      const extraLlmUsages = [
        ...(result.meta?.plannerLlmUsages ?? [])
          .filter((pu) => pu.prompt_tokens > 0 || pu.completion_tokens > 0)
          .map((pu) => ({
            model: pu.model,
            inputTokens: pu.prompt_tokens,
            outputTokens: pu.completion_tokens,
          })),
        ...(embeddingUsage && embeddingUsage.totalTokens > 0
          ? [{ model: embeddingUsage.model, inputTokens: embeddingUsage.totalTokens, outputTokens: 0 }]
          : []),
      ];

      trackUsage({
        tenantId,
        requestId,
        model: CHAT_LLM_MODEL,
        inputTokens,
        outputTokens,
        featureUsed: "chat",
        ...(extraLlmUsages.length > 0 ? { extraLlmUsages } : {}),
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
