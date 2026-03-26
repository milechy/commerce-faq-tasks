// src/api/avatar/anamChatStreamRoutes.ts
// Phase42: Anam Client-Side Custom LLM — Groqストリーミング応答
// POST /api/avatar/chat-stream
//   認証: apiStack (authMiddleware → tenantId)
//   widget.jsからの会話履歴を受け取り、Groq LLMでストリーミング応答を返す。
//   Anam JS SDKのcreateTalkMessageStream()でTTS化される。

import type { Express, Request, Response, RequestHandler } from 'express';
import type { AuthedRequest } from '../../agent/http/authMiddleware';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';

export function registerAnamChatStreamRoutes(app: Express, apiStack: RequestHandler[]): void {
  console.log('[anamChatStream] POST /api/avatar/chat-stream registered');

  app.post('/api/avatar/chat-stream', ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as AuthedRequest).tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { messages } = req.body as { messages?: Array<{ role: string; content: string }> };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const groqApiKey = process.env.GROQ_API_KEY?.trim();
    if (!groqApiKey) {
      console.error('[anamChatStream] GROQ_API_KEY not set');
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
        console.warn('[anamChatStream] Failed to load personality_prompt:', err);
      }
    }

    // systemPrompt構築（音声会話向けに短め応答を指示）
    const systemPrompt = `${personalityPrompt}

重要な指示:
- 回答は1〜2文、50文字以内を目安にしてください（音声で読み上げるため短く）
- 自然な話し言葉で、丁寧語を使ってください
- マークダウンや箇条書きは使わないでください（音声化されるため）
- 専門用語は避け、わかりやすい言葉で説明してください`;

    const groqMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // SSEヘッダー
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const groqRes = await fetch(GROQ_API_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: groqMessages,
          stream: true,
          max_tokens: 150,
          temperature: 0.7,
        }),
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        console.error(`[anamChatStream] Groq API error ${groqRes.status}: ${errText.slice(0, 200)}`);
        res.write(JSON.stringify({ error: 'LLM error' }) + '\n');
        return res.end();
      }

      const reader = groqRes.body?.getReader();
      if (!reader) {
        res.write(JSON.stringify({ error: 'No stream' }) + '\n');
        return res.end();
      }

      const decoder = new TextDecoder();
      let buffer = '';

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
            };
            const content = parsed.choices?.[0]?.delta?.content ?? '';
            if (content) {
              res.write(JSON.stringify({ content }) + '\n');
            }
          } catch {
            // JSON parse error — skip malformed chunk
          }
        }
      }

      res.end();

    } catch (err) {
      console.error('[anamChatStream] Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed' });
      } else {
        res.end();
      }
    }
  });
}
