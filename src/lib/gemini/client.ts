// src/lib/gemini/client.ts
// Gemini 2.5 Flash REST client (Phase46)

import pino from 'pino';
import { trackUsage } from '../billing/usageTracker';

const logger = pino();

const GEMINI_MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 呼び出し元がテナント/リクエストコンテキストを持つ場合に渡す（省略可）。
 * 現状の呼び出し元（judgeEvaluator / gapRecommender / contentAnalyzer / bookStructurizer）は
 * いずれもR2C運用側のLLM機能のため、省略時は billable=false・featureUsed="admin_tuning" で
 * 原価のみ記録する（Stripe請求数量には含めない）。
 */
export interface GeminiUsageContext {
  tenantId?: string;
  requestId?: string;
  billable?: boolean;
}

export async function callGeminiJudge(prompt: string, usageContext?: GeminiUsageContext): Promise<string> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body }, 'callGeminiJudge: API error');
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const candidates = data['candidates'] as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.['content'] as Record<string, unknown> | undefined;
  const parts = content?.['parts'] as Array<Record<string, unknown>> | undefined;
  const text = (parts?.[0]?.['text'] as string) ?? '';

  const usageMetadata = data['usageMetadata'] as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined;

  trackUsage({
    tenantId: usageContext?.tenantId ?? 'unknown',
    requestId: usageContext?.requestId ?? `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    model: GEMINI_MODEL,
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    featureUsed: 'admin_tuning',
    billable: usageContext?.billable ?? false,
  });

  return text;
}
