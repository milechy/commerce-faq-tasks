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
        `confirmed フラグを持つツール（save_tuning_rule, delete_faq 等）は、必ず先に内容をユーザーに要約提示し、` +
        `明確な同意を得たターンでのみ confirmed=true を指定して呼び出してください。` +
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

      // 第1回 Groq 呼び出し（tool_calls あり）
      const firstResponse = await callGroqWithTools(messages, ADMIN_AGENT_TOOLS);
      let totalPromptTokens = firstResponse.usage.promptTokens;
      let totalCompletionTokens = firstResponse.usage.completionTokens;

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

      if (firstResponse.tool_calls.length > 0) {
        // アシスタントメッセージをコンテキストに追加
        messages.push({
          role: 'assistant',
          content: firstResponse.content,
          tool_calls: firstResponse.tool_calls,
        });

        // tool_calls を順次実行
        for (const toolCall of firstResponse.tool_calls) {
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = {};
          }

          const result = await executeToolCall(
            toolCall.function.name,
            toolArgs,
            effectiveTenantId,
            db
          );

          actions.push({ tool: toolCall.function.name, result });

          // tool 結果をコンテキストに追加
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: result,
          });
        }

        // 第2回 Groq 呼び出し（最終 reply）
        const finalResponse = await callGroqFinal(messages);
        totalPromptTokens += finalResponse.usage.promptTokens;
        totalCompletionTokens += finalResponse.usage.completionTokens;
        reportUsage();
        return res.json({ reply: finalResponse.reply, actions });
      }

      // tool_calls がなかった場合はそのまま返す
      reportUsage();
      return res.json({
        reply: firstResponse.content ?? '回答を生成できませんでした',
        actions: [],
      });
    } catch (err) {
      logger.warn('[POST /v1/admin/agent/chat]', err);
      return res.status(500).json({ error: 'AIエージェントの応答生成に失敗しました' });
    }
  });
}
