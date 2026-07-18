// src/api/admin/agent/agentRoutes.ts
// Phase B-Admin: POST /v1/admin/agent/chat

import type { Express, Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { logger } from '../../../lib/logger';
import { ADMIN_AGENT_TOOLS } from './toolDefinitions';
import { executeToolCall } from './actionExecutor';
import { trackUsage } from '../../../lib/billing/usageTracker';
import { GROQ_VERSATILE_70B } from '../../../config/groqModels';

// ---------------------------------------------------------------------------
// Auth helper（options/routes.ts と同パターンのローカル定義）
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role = su?.app_metadata?.role;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const isSuperAdmin: boolean = role === 'super_admin';
  return { su, role, tenantId, isSuperAdmin };
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

// G2: 会話履歴はサーバに永続化せず、フロントが保持する直近の会話を毎リクエスト送る
// （ステートレスサーバのまま最小コストでマルチターン文脈を実現する）
const historyItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
});

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string().min(1).max(100),
  targetTenantId: z.string().optional(),
  history: z.array(historyItemSchema).max(20).optional(),
  // 明示的にオプトインした場合のみ true。省略時(既存クライアント)は従来通りJSON一括応答のまま。
  stream: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Groq function calling 呼び出し（tools 付き）
// ---------------------------------------------------------------------------

interface GroqMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface GroqToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface GroqUsage {
  promptTokens: number;
  completionTokens: number;
}

async function callGroqWithTools(
  messages: GroqMessage[],
  tools: typeof ADMIN_AGENT_TOOLS
): Promise<{ content: string | null; tool_calls: GroqToolCall[]; usage: GroqUsage }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_VERSATILE_70B,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    tool_calls: choice?.message?.tool_calls ?? [],
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function callGroqFinal(messages: GroqMessage[]): Promise<{ reply: string; usage: GroqUsage }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_VERSATILE_70B,
      messages,
      max_tokens: 512,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  return {
    reply: data.choices?.[0]?.message?.content?.trim() ?? '',
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 共有: tool_calls の実行（confirmed同一ターン連鎖ガード込み）。
// 非ストリーミング・ストリーミング両方の多段ループから使う単一の実装。
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * ツール呼び出しの arguments(JSON文字列)を安全にパースする。
 * 実際のGroq API観測で、無引数ツールに対し文字列 "null" が送られてくるケースを確認済み。
 * JSON.parse自体は例外を投げず null を返すため、catch だけでは防げない
 * （object以外に解決した場合は空オブジェクトへフォールバックする）。
 */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

async function executeHopToolCalls(
  toolCalls: ParsedToolCall[],
  effectiveTenantId: string,
  db: Pool,
  suggestedThisTurn: Set<string>,
  actions: Array<{ tool: string; result: string }>,
  messages: GroqMessage[],
  isSuperAdmin: boolean,
): Promise<void> {
  for (const toolCall of toolCalls) {
    const { id, name, args } = toolCall;
    const suggestCounterpart = Object.entries(SUGGEST_TO_SAVE_TOOL).find(([, save]) => save === name)?.[0];

    let result: string;
    if (suggestCounterpart && suggestedThisTurn.has(suggestCounterpart)) {
      // 同一ターン内で suggest → save が連鎖しようとしている: 人間の確認を経ていないためブロック
      result = 'この保存は同一ターン内での連続実行のため確認をスキップできません。提案内容を確認のうえ、あらためて「保存して」等のメッセージを送ってください。';
    } else {
      result = await executeToolCall(name, args, effectiveTenantId, db, isSuperAdmin);
      if (name in SUGGEST_TO_SAVE_TOOL) suggestedThisTurn.add(name);
    }

    actions.push({ tool: name, result });
    messages.push({ role: 'tool', tool_call_id: id, name, content: result });
  }
}

// ---------------------------------------------------------------------------
// SSE: 本物のトークンストリーミング（stream:true オプトイン時のみ）。
// 各ホップをGroqの stream:true で受け、content デルタは受信次第そのまま
// クライアントへ転送し、tool_calls デルタはindexごとに蓄積して完成後に実行する。
// ---------------------------------------------------------------------------

interface StreamHopResult {
  content: string | null;
  tool_calls: GroqToolCall[];
  usage: GroqUsage;
}

async function runStreamingHop(
  messages: GroqMessage[],
  tools: typeof ADMIN_AGENT_TOOLS | undefined,
  res: Response,
): Promise<StreamHopResult> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const body: Record<string, unknown> = {
    model: GROQ_VERSATILE_70B,
    messages,
    max_tokens: 1024,
    temperature: 0.2,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!groqRes.ok || !groqRes.body) {
    const text = await groqRes.text().catch(() => '');
    throw new Error(`Groq API error ${groqRes.status}: ${text.slice(0, 200)}`);
  }

  const reader = groqRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAcc = '';
  let hasContent = false;
  const toolCallAcc: Array<{ id?: string; name?: string; args: string }> = [];
  let usage: GroqUsage = { promptTokens: 0, completionTokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // 最後の不完全な行は次のchunkに持ち越す

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: parsed.usage.completion_tokens ?? usage.completionTokens,
        };
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        hasContent = true;
        contentAcc += delta.content;
        res.write(`event: delta\ndata: ${JSON.stringify({ text: delta.content })}\n\n`);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          if (!toolCallAcc[idx]) toolCallAcc[idx] = { args: '' };
          if (tc.id) toolCallAcc[idx]!.id = tc.id;
          if (tc.function?.name) toolCallAcc[idx]!.name = tc.function.name;
          if (tc.function?.arguments) toolCallAcc[idx]!.args += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls: GroqToolCall[] = toolCallAcc
    .filter((tc): tc is { id: string; name: string; args: string } => Boolean(tc?.id && tc?.name))
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));

  // ストリームの usage イベントが得られなかった場合の概算(日本語はおおよそ4文字≒1トークン)
  if (usage.completionTokens === 0 && contentAcc) {
    usage = { ...usage, completionTokens: Math.ceil(contentAcc.length / 4) };
  }

  return { content: hasContent ? contentAcc : null, tool_calls: toolCalls, usage };
}

// ---------------------------------------------------------------------------
// G1: 多段エージェントループの設定
// ---------------------------------------------------------------------------

// 1リクエストあたり許容する「tools付きGroq呼び出し」の最大回数。
// 暴走・無限ループ防止のガード。上限に達しても収束しない場合は tools 無しの
// 強制まとめ呼び出し(callGroqFinal)で必ず自然文の reply を返して終了する。
const MAX_TOOL_HOPS = 4;

// suggest_* → save_*(confirmed=true) の対応表。
// G1導入により「suggest→save を同一ターン内で連鎖実行」が技術的に可能になったが、
// これは人間の確認を経ないまま書き込みが確定してしまう抜け道になるため、
// プロンプト任せにせずコードで明示的にブロックする（下記ループ内で使用）。
const SUGGEST_TO_SAVE_TOOL: Record<string, string> = {
  suggest_tuning_rule: 'save_tuning_rule',
  suggest_faq: 'save_faq',
  suggest_engagement_rule: 'save_engagement_rule',
};

// MAX_TOOL_HOPS到達後の強制まとめ呼び出し用。tools無しにしただけでは、モデルがまだ
// ツールを呼びたい場合に "<function=...>" のような擬似構文をテキストとして出力することが
// 実測で確認されたため、明示的に禁止する一文を最後に差し込む。
const WRAP_UP_NOTICE: GroqMessage = {
  role: 'user',
  content:
    'これ以上ツールは呼び出せません。ここまでの情報をもとに、自然な日本語の文章だけで回答してください（関数呼び出しの構文などは一切書かないでください）。',
};

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerAdminAgentRoutes(app: Express, db: Pool): void {
  app.use('/v1/admin/agent', supabaseAuthMiddleware);

  app.post('/v1/admin/agent/chat', async (req: Request, res: Response) => {
    const { role, tenantId, isSuperAdmin } = extractAuth(req);

    // ロールチェック
    if (role !== 'super_admin' && role !== 'client_admin') {
      return res.status(403).json({ error: 'この操作を実行する権限がありません' });
    }

    // バリデーション
    const parsed = chatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    const { message, sessionId, targetTenantId, history } = parsed.data;

    // effectiveTenantId: super_admin は targetTenantId を使用可、client_admin は JWT 由来のみ
    const effectiveTenantId = isSuperAdmin ? (targetTenantId ?? tenantId) : tenantId;

    if (!isSuperAdmin && !effectiveTenantId) {
      return res.status(403).json({ error: 'テナント情報が取得できません' });
    }

    // GROQ_API_KEY 未設定の場合はグレースフルダウングレード
    if (!process.env.GROQ_API_KEY?.trim()) {
      return res.status(200).json({
        reply: 'AIアシスタントは現在利用できません',
        actions: [],
      });
    }

    try {
      const systemPrompt =
        `あなたはテナント管理AIエージェントです。テナントID "${effectiveTenantId}" の管理者をサポートします。` +
        `必要に応じてツールを呼び出して設定を確認・変更してください。回答は日本語で簡潔に行ってください。` +
        `ツールの実行結果を見てから続けて別のツールを呼び出すこともできます（最大${MAX_TOOL_HOPS}回まで）。` +
        `confirmed フラグを持つツール（save_tuning_rule, delete_faq 等）は、必ず先に内容をユーザーに要約提示し、` +
        `明確な同意を得たターンでのみ confirmed=true を指定して呼び出してください。` +
        `suggest_* で下書きを提案した直後に、同じターン内で対応する save_* を呼び出すことはできません` +
        `（ユーザーが確認して次のメッセージを送るまで待つ必要があります）。` +
        `ユーザーが管理画面の具体的な操作（設定変更・ページ編集など）に苦戦している様子が見られる場合、` +
        `または今後の説明だけでは苦戦しそうだと判断した場合は、他の提案より先に` +
        `「代わりに画面操作を行いましょうか？」とだけ尋ねてください。` +
        `ユーザーがこの提案に明確に同意したターンでのみ request_sai_task を confirmed=true で呼び出してください。` +
        `ユーザーが苦戦していない、または明確に依頼していない状態で、こちらから代行作業を持ちかけたり実行したりしないでください。` +
        `セッションID: ${sessionId}`;

      // G2: 直近の会話履歴をそのままシステムプロンプトの後に差し込み、マルチターンの文脈を持たせる
      const historyMessages: GroqMessage[] = (history ?? []).map((h) => ({
        role: h.role,
        content: h.content,
      }));

      const messages: GroqMessage[] = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: message },
      ];

      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      const actions: Array<{ tool: string; result: string }> = [];
      // このリクエスト(ターン)内で suggest_* が呼ばれたツール名を記録し、
      // 対応する save_* が同一ターン内で連鎖実行されるのを防ぐ（G1のリスク軽減策）
      const suggestedThisTurn = new Set<string>();

      // -----------------------------------------------------------------
      // SSE: stream:true をオプトインした場合のみ本物のトークンストリーミング経路へ。
      // 省略時(既存クライアント・本番AdminAgentPanel)は下の非ストリーミング経路のまま、挙動は完全に不変。
      // -----------------------------------------------------------------
      if (parsed.data.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          let finalReply: string | null = null;

          for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
            const hopResult = await runStreamingHop(messages, ADMIN_AGENT_TOOLS, res);
            totalPromptTokens += hopResult.usage.promptTokens;
            totalCompletionTokens += hopResult.usage.completionTokens;

            if (hopResult.tool_calls.length === 0) {
              finalReply = hopResult.content ?? '回答を生成できませんでした';
              break;
            }

            messages.push({ role: 'assistant', content: hopResult.content, tool_calls: hopResult.tool_calls });

            const parsedToolCalls: ParsedToolCall[] = hopResult.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              args: parseToolArgs(tc.function.arguments),
            }));

            const beforeCount = actions.length;
            await executeHopToolCalls(parsedToolCalls, effectiveTenantId, db, suggestedThisTurn, actions, messages, isSuperAdmin);
            for (const action of actions.slice(beforeCount)) {
              res.write(`event: action\ndata: ${JSON.stringify(action)}\n\n`);
            }
          }

          if (finalReply === null) {
            // MAX_TOOL_HOPS に達しても収束しなかった場合、tools無しで強制的にまとめさせる(これもストリーミング)。
            // 実測: toolsを外しただけだと、まだ呼びたいツールがある場合にモデルが
            // "<function=...>" のような擬似構文をテキストとして出力することがあるため、明示的に釘を刺す。
            messages.push(WRAP_UP_NOTICE);
            const wrapUp = await runStreamingHop(messages, undefined, res);
            totalPromptTokens += wrapUp.usage.promptTokens;
            totalCompletionTokens += wrapUp.usage.completionTokens;
            finalReply = wrapUp.content ?? '回答を生成できませんでした';
          }

          if (effectiveTenantId) {
            trackUsage({
              tenantId: effectiveTenantId,
              requestId: `admin-agent-${sessionId}-${Date.now()}`,
              model: GROQ_VERSATILE_70B,
              inputTokens: totalPromptTokens,
              outputTokens: totalCompletionTokens,
              featureUsed: 'admin_agent',
            });
          }

          res.write(`event: done\ndata: ${JSON.stringify({ reply: finalReply, actions })}\n\n`);
          res.end();
        } catch (err) {
          logger.warn('[POST /v1/admin/agent/chat stream]', err);
          res.write(`event: error\ndata: ${JSON.stringify({ error: 'AIエージェントの応答生成に失敗しました' })}\n\n`);
          res.end();
        }
        return;
      }

      // -----------------------------------------------------------------
      // 非ストリーミング経路(既定・既存挙動): JSON一括応答
      // -----------------------------------------------------------------
      const reportUsage = () => {
        // super_adminがテナント未特定（targetTenantId未指定）の場合は課金対象がないためスキップ
        if (!effectiveTenantId) return;
        trackUsage({
          tenantId: effectiveTenantId,
          requestId: `admin-agent-${sessionId}-${Date.now()}`,
          model: GROQ_VERSATILE_70B,
          inputTokens: totalPromptTokens,
          outputTokens: totalCompletionTokens,
          featureUsed: 'admin_agent',
        });
      };

      let finalReply: string | null = null;

      // G1: tools付きGroq呼び出しを最大 MAX_TOOL_HOPS 回まで繰り返す。
      // モデルがツール結果を見て追加のツールを呼ぶ「多段推論」を許容しつつ、
      // 上限に達しても収束しない場合は必ず自然文の reply で終了させる。
      for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
        const hopResponse = await callGroqWithTools(messages, ADMIN_AGENT_TOOLS);
        totalPromptTokens += hopResponse.usage.promptTokens;
        totalCompletionTokens += hopResponse.usage.completionTokens;

        if (hopResponse.tool_calls.length === 0) {
          finalReply = hopResponse.content ?? '回答を生成できませんでした';
          break;
        }

        messages.push({
          role: 'assistant',
          content: hopResponse.content,
          tool_calls: hopResponse.tool_calls,
        });

        const parsedToolCalls: ParsedToolCall[] = hopResponse.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          args: parseToolArgs(toolCall.function.arguments),
        }));

        await executeHopToolCalls(parsedToolCalls, effectiveTenantId, db, suggestedThisTurn, actions, messages, isSuperAdmin);
      }

      if (finalReply === null) {
        // MAX_TOOL_HOPS に達しても収束しなかった場合、tools無しで強制的にまとめさせる。
        // 実測: toolsを外しただけだと、まだ呼びたいツールがある場合にモデルが
        // "<function=...>" のような擬似構文をテキストとして出力することがあるため、明示的に釘を刺す。
        messages.push(WRAP_UP_NOTICE);
        const wrapUp = await callGroqFinal(messages);
        totalPromptTokens += wrapUp.usage.promptTokens;
        totalCompletionTokens += wrapUp.usage.completionTokens;
        finalReply = wrapUp.reply;
      }

      reportUsage();
      return res.json({ reply: finalReply, actions });
    } catch (err) {
      logger.warn('[POST /v1/admin/agent/chat]', err);
      return res.status(500).json({ error: 'AIエージェントの応答生成に失敗しました' });
    }
  });
}
