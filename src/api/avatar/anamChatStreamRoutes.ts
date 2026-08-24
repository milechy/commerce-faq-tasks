// src/api/avatar/anamChatStreamRoutes.ts

// Phase42: Anam Client-Side Custom LLM — Groqストリーミング応答
// POST /api/avatar/chat-stream
//   認証: apiStack (authMiddleware → tenantId)
//   widget.jsからの会話履歴を受け取り、Groq LLMでストリーミング応答を返す。
//   Anam JS SDKのcreateTalkMessageStream()でTTS化される。

import { randomUUID } from 'node:crypto';
import { GPT_OSS_120B, getFallbackGroqModel, groqReasoningParams } from '../../config/groqModels';
import type { Express, Request, Response, RequestHandler } from 'express';
import type { AuthedRequest } from '../../agent/http/authMiddleware';
import { logger } from '../../lib/logger';
import { saveMessage } from '../admin/chat-history/chatHistoryRepository';
import { resolveTrafficSource, TRAFFIC_SOURCE_HEADER } from '../../lib/traffic/trafficSource';
import { trackUsage } from '../../lib/billing/usageTracker';
import { sanitizeInput as l5SanitizeInput, sessionHistoryStore } from '../../middleware/inputSanitizer';
import { applyPromptFirewall } from '../../middleware/promptFirewall';
import { checkTopic } from '../../middleware/topicGuard';

const MAX_ANAM_MESSAGES = 20;
const MAX_ANAM_MESSAGE_LENGTH = 2000;

/**
 * E5: RAG を介さない回答経路のため既定で封鎖する。
 * 有効化する前に、本体API /api/chat と同じ知識経路(FAQ/pgvector/learned_memory/
 * tuning_rules)をこのルートにも通すこと。フラグだけ立てると顧客に知識ゼロの
 * 回答が出る。
 * モジュール読み込み時ではなくリクエスト時に読むことで、封鎖状態を切り替えても
 * 再デプロイ前提にならないようにする。
 */
function isAnamChatStreamEnabled(): boolean {
  return process.env.ANAM_CHAT_STREAM_ENABLED === 'true';
}

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Phase(Anam usage tracking): Groqストリーミング応答のusageをusage_logsへ記録する。
 * fire-and-forget(trackUsage内部でsetImmediate)、レスポンスをブロックしない。
 * requestId は req.requestId(requestIdMiddlewareが全リクエストに付与する安定キー)を使う。
 * usage_logs は request_id UNIQUE + ON CONFLICT DO NOTHING のため、同一requestIdで
 * 複数回呼ばれても(再接続・エラー後の二重呼び出し等)二重計上されない。
 */
function trackAnamChatUsage(params: {
  tenantId: string;
  requestId: string;
  /** 実際に応答を返したモデル。フォールバックが起きた場合は退避先が入る。 */
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): void {
  const { tenantId, requestId, model, inputTokens, outputTokens } = params;
  if (inputTokens === undefined || outputTokens === undefined) {
    // Groqがusageチャンクを返さないまま完了/中断した場合。
    // silentに0計上せず、原価・請求が過少になり得ることを可視化する。
    logger.warn(
      { requestId, tenantId },
      '[anamChatStream] Groq usage not returned — recording as 0 (cost/billing may be understated)',
    );
  }
  trackUsage({
    tenantId,
    requestId,
    model,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    featureUsed: 'chat',
  });
}

export function registerAnamChatStreamRoutes(app: Express, apiStack: RequestHandler[]): void {
  logger.info('[anamChatStream] POST /api/avatar/chat-stream registered');

  app.post('/api/avatar/chat-stream', ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as AuthedRequest).tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // E5: この経路は RAG を介さない Groq 直呼び出しで、有効化すると顧客に
    // 知識(FAQ/pgvector/learned_memory/tuning_rules)を通さない回答が出る。
    // 現在 avatar_configs は全件 lemonslice で anam は0件のため到達しないが、
    // テナントを anam に切り替えるだけで無言で知識ゼロ回答が始まる状態だった。
    // 有効化するなら先に本体API /api/chat と同じ知識経路を通すこと。それまでは
    // 無言で劣化した回答を返すのではなく、ここで大きく失敗させる。
    if (!isAnamChatStreamEnabled()) {
      logger.warn(
        { tenantId, requestId: (req as any).requestId },
        '[anamChatStream] blocked: RAGを介さない回答経路のため無効化されている(E5)',
      );
      return res.status(503).json({
        error: 'anam_chat_stream_disabled',
        message:
          'この経路は知識(RAG)を通さないため無効化されています。アバターの回答は /api/chat を経由してください。',
      });
    }

    const { messages, sessionId: bodySessionId } = req.body as {
      messages?: Array<{ role: string; content: string }>;
      sessionId?: string;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }
    if (messages.length > MAX_ANAM_MESSAGES) {
      return res.status(400).json({ error: `messages array must not exceed ${MAX_ANAM_MESSAGES} items` });
    }
    if (messages.some((m) => typeof m.content !== 'string' || m.content.length > MAX_ANAM_MESSAGE_LENGTH)) {
      return res.status(400).json({ error: `each message must be a string of at most ${MAX_ANAM_MESSAGE_LENGTH} characters` });
    }

    // Phase75: 会話ログ永続化。Widgetがsession_idを送ってこない場合、この呼び出し単位を
    // 1セッションとして扱う(継続性は失うが、Hermes MCP等の学習用途には十分な単発Q&Aとして
    // 記録できる)。将来widget.js側でsessionIdを継続送信するよう改修すれば自動的に連続化する。
    const sessionId =
      typeof bodySessionId === 'string' && bodySessionId.trim().length > 0
        ? bodySessionId
        : randomUUID();
    // GID 1216970103691946: 実ユーザー/E2E/chat-test/デモの判定（セッション新規作成時のみ記録）
    const trafficSource = resolveTrafficSource({
      headerValue: req.header(TRAFFIC_SOURCE_HEADER),
      userAgent: req.header('user-agent'),
      referer: req.header('referer'),
      isChatTestToken: (req as any).isChatTestToken === true,
    });

    // 「最後のuserメッセージ」の判定はここ1箇所のみで行う。以前はガード適用箇所(index 96)と
    // groqMessages組み立て箇所(旧index 171)で別々に(reverse().find() とreduceで)計算しており、
    // 片方だけ変更するとガードをすり抜けた原文がLLMに渡るリスクがあった(GID 1217741396163930)。
    const latestUserMessageIndex = messages.reduce<number>(
      (lastIdx, m, i) => (m.role === 'user' ? i : lastIdx),
      -1
    );
    const latestUserMessage = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex] : undefined;

    // L5/L7/L6: RAGを介さないGroq直呼び出し経路にも、通常チャット(/api/chat)と同じ
    // 入力ガードを適用する。abuseカウンタはconversationId等の共有バケットではなく
    // tenantId+sessionIdでスコープする。
    let guardedUserContent = latestUserMessage?.content ?? '';
    if (latestUserMessage?.content) {
      const guardKey = `${tenantId}:${sessionId}`;

      const sanitizeResult = l5SanitizeInput(latestUserMessage.content, guardKey, sessionHistoryStore);
      if (!sanitizeResult.allowed) {
        const status = sanitizeResult.shouldTerminateSession ? 403 : 400;
        return res.status(status).json({ error: sanitizeResult.userFacingMessage ?? 'メッセージを確認してください。' });
      }
      guardedUserContent = sanitizeResult.sanitizedMessage ?? latestUserMessage.content;

      const firewallResult = applyPromptFirewall(guardedUserContent);
      if (!firewallResult.allowed) {
        return res.status(400).json({ error: firewallResult.userFacingMessage ?? 'その質問にはお答えできません。' });
      }
      guardedUserContent = firewallResult.sanitizedMessage;

      const topicResult = await checkTopic(guardedUserContent, tenantId, guardKey);
      if (!topicResult.allowed) {
        const status = topicResult.shouldTerminateSession ? 403 : 400;
        return res.status(status).json({ error: topicResult.userFacingMessage ?? 'ご質問の内容が対応範囲外です。' });
      }
    }

    if (latestUserMessage?.content) {
      saveMessage({
        tenantId,
        sessionId,
        role: 'user',
        content: latestUserMessage.content,
        metadata: { source: 'avatar', channel: 'anam' },
        trafficSource,
      }).catch((err) => logger.warn('[anamChatStream] saveMessage(user) failed:', err));
    }

    const groqApiKey = process.env.GROQ_API_KEY?.trim();
    if (!groqApiKey) {
      logger.error('[anamChatStream] GROQ_API_KEY not set');
      return res.status(500).json({ error: 'LLM not configured' });
    }

    // テナントのpersonality_promptを取得
    let personalityPrompt =
      'あなたはAI営業アシスタントです。お客様の質問に日本語で丁寧に応答してください。';
    const pool = (req as any).app.locals.db;
    if (pool) {
      try {
        const configResult = await pool.query(
          `SELECT personality_prompt FROM avatar_configs
           WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId]
        );
        if (configResult.rows.length > 0 && configResult.rows[0].personality_prompt) {
          personalityPrompt = configResult.rows[0].personality_prompt;
        }
      } catch (err) {
        logger.warn('[anamChatStream] Failed to load personality_prompt:', err);
      }
    }

    // systemPrompt構築（音声会話向けに短め応答を指示）
    const systemPrompt = `${personalityPrompt}

重要な指示:
- 回答は1〜2文、50文字以内を目安にしてください（音声で読み上げるため短く）
- 自然な話し言葉で、丁寧語を使ってください
- マークダウンや箇条書きは使わないでください（音声化されるため）
- 専門用語は避け、わかりやすい言葉で説明してください`;

    // 直近ユーザー発言のみ、L5/L7/L6ガード済みの内容に差し替える（履歴は元のまま）。
    // latestUserMessageIndex は冒頭で1回だけ計算したものを再利用する。
    const groqMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m, i) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: i === latestUserMessageIndex ? guardedUserContent : m.content,
      })),
    ];

    // SSEヘッダー
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // モデル配信停止(404 model_not_found)時は groqModels.ts のフォールバックチェーンを辿る。
      // 共通の callGroqWithModelFallback は非ストリーミング(Promise<string>)のためここでは使えない。
      // ただし 404 判定は本文を1バイトも書き出す前に確定するので、この位置での退避は安全
      // (ストリーム開始後は応答を撤回できないため、退避もしない)。
      let candidateModel: string | null = GPT_OSS_120B;
      let groqRes: Awaited<ReturnType<typeof fetch>> | undefined;
      const attemptedModels: string[] = [];

      while (candidateModel !== null) {
        attemptedModels.push(candidateModel);
        const attempt = await fetch(GROQ_API_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqApiKey}`,
          },
          body: JSON.stringify({
            model: candidateModel,
            messages: groqMessages,
            stream: true,
            // usage計測: 最終チャンクにusage(prompt_tokens/completion_tokens)を含めてもらう。
            stream_options: { include_usage: true },
            max_tokens: 150,
            temperature: 0.7,
            // gpt-oss は推論トークンが max_tokens を食い、これが無いと本文が出ない。
            // 退避先(20b)も gpt-oss 系なので、ループ内で候補ごとに評価する。
            ...groqReasoningParams(candidateModel),
          }),
        });

        if (attempt.ok) {
          groqRes = attempt;
          break;
        }

        const errText = await attempt.text();
        const isModelNotFound =
          attempt.status === 404 && errText.includes('model_not_found');

        if (!isModelNotFound) {
          // モデル不在以外の失敗は退避しても直らないため、そのまま返す。
          logger.error(
            `[anamChatStream] Groq API error ${attempt.status}: ${errText.slice(0, 200)}`,
          );
          res.write(JSON.stringify({ error: 'LLM error' }) + '\n');
          return res.end();
        }

        const nextModel = getFallbackGroqModel(candidateModel);
        // 無言フォールバック禁止: 退避も打ち切りも必ずログに残す。
        logger.warn(
          { requestId: req.requestId, tenantId, failedModel: candidateModel, nextModel },
          '[anamChatStream] model_not_found — falling back to next catalog model',
        );
        candidateModel = nextModel;
      }

      if (!groqRes || candidateModel === null) {
        logger.error(
          { requestId: req.requestId, tenantId, attemptedModels },
          '[anamChatStream] all fallback models returned model_not_found — giving up',
        );
        res.write(JSON.stringify({ error: 'LLM error' }) + '\n');
        return res.end();
      }

      const resolvedModel: string = candidateModel;

      const reader = groqRes.body?.getReader();
      if (!reader) {
        res.write(JSON.stringify({ error: 'No stream' }) + '\n');
        return res.end();
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const content = parsed.choices?.[0]?.delta?.content ?? '';
              if (content) {
                assistantContent += content;
                res.write(JSON.stringify({ content }) + '\n');
              }
              // stream_options.include_usage時、最終チャンクはchoicesが空でusageのみを含む。
              if (typeof parsed.usage?.prompt_tokens === 'number' && typeof parsed.usage?.completion_tokens === 'number') {
                inputTokens = parsed.usage.prompt_tokens;
                outputTokens = parsed.usage.completion_tokens;
              }
            } catch {
              // JSON parse error — skip malformed chunk
            }
          }
        }
      } finally {
        // ストリームが正常完了/中断のどちらでも、ここまでに得たusage(未取得ならundefined)で計上する。
        // requestId(req.requestId)は1リクエストにつき固定なので、再接続で二重にPOSTされない限り
        // 二重計上は発生しない。二重POST自体はusage_logsのrequest_id UNIQUE制約で防がれる。
        trackAnamChatUsage({ tenantId, requestId: req.requestId, model: resolvedModel, inputTokens, outputTokens });
      }

      res.end();

      // Phase75: 会話ログ永続化(assistant側)。fire-and-forget、レスポンス送信後に実行。
      if (assistantContent) {
        saveMessage({
          tenantId,
          sessionId,
          role: 'assistant',
          content: assistantContent,
          metadata: { source: 'avatar', channel: 'anam' },
          trafficSource,
        }).catch((err) => logger.warn('[anamChatStream] saveMessage(assistant) failed:', err));
      }

    } catch (err) {
      logger.error('[anamChatStream] Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed' });
      } else {
        res.end();
      }
    }
  });
}
