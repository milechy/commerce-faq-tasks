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

      const actions: Array<{ tool: string; result: string }> = [];
      // このリクエスト(ターン)内で suggest_* が呼ばれたツール名を記録し、
      // 対応する save_* が同一ターン内で連鎖実行されるのを防ぐ（G1のリスク軽減策）
      const suggestedThisTurn = new Set<string>();
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

        for (const toolCall of hopResponse.tool_calls) {
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = {};
          }

          const toolName = toolCall.function.name;
          const suggestCounterpart = Object.entries(SUGGEST_TO_SAVE_TOOL).find(([, save]) => save === toolName)?.[0];

          let result: string;
          if (suggestCounterpart && suggestedThisTurn.has(suggestCounterpart)) {
            // 同一ターン内で suggest → save が連鎖しようとしている: 人間の確認を経ていないためブロック
            result = 'この保存は同一ターン内での連続実行のため確認をスキップできません。提案内容を確認のうえ、あらためて「保存して」等のメッセージを送ってください。';
          } else {
            result = await executeToolCall(toolName, toolArgs, effectiveTenantId, db);
            if (toolName in SUGGEST_TO_SAVE_TOOL) suggestedThisTurn.add(toolName);
          }

          actions.push({ tool: toolName, result });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: result,
          });
        }
      }

      if (finalReply === null) {
        // MAX_TOOL_HOPS に達しても収束しなかった場合、tools無しで強制的にまとめさせる
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
