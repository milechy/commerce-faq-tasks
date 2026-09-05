// src/lib/gemini/client.ts
// Gemini 2.5 Flash REST client (Phase46)

import pino from 'pino';
import { trackUsage, type FeatureUsed } from '../billing/usageTracker';

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
  featureUsed?: FeatureUsed;
}

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

async function callGeminiGenerateContent(parts: GeminiPart[], usageContext?: GeminiUsageContext): Promise<string> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body }, 'callGeminiGenerateContent: API error');
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const candidates = data['candidates'] as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.['content'] as Record<string, unknown> | undefined;
  const contentParts = content?.['parts'] as Array<Record<string, unknown>> | undefined;
  const text = (contentParts?.[0]?.['text'] as string) ?? '';

  const usageMetadata = data['usageMetadata'] as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined;

  // trackUsageは現状setImmediateでスケジュールするだけの同期voidだが、将来の実装変更で
  // 同期例外を投げるようになっても、正常取得できたJudge結果を道連れにしないよう
  // 明示的に隔離する（CLAUDE.md: 副作用の記録の失敗が応答を変えてはならない）。
  try {
    trackUsage({
      tenantId: usageContext?.tenantId ?? 'unknown',
      requestId: usageContext?.requestId ?? `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      model: GEMINI_MODEL,
      inputTokens: usageMetadata?.promptTokenCount ?? 0,
      outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
      featureUsed: usageContext?.featureUsed ?? 'admin_tuning',
      billable: usageContext?.billable ?? false,
    });
  } catch (err) {
    logger.warn({ err }, 'callGeminiGenerateContent: trackUsage failed (non-blocking)');
  }

  return text;
}

export async function callGeminiJudge(prompt: string, usageContext?: GeminiUsageContext): Promise<string> {
  return callGeminiGenerateContent([{ text: prompt }], usageContext);
}

/** COPY-1: 画像を添付してGeminiに判定させる（アバター参照画像の著作権/NSFWモデレーション等）。 */
export async function callGeminiVisionJudge(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  usageContext?: GeminiUsageContext
): Promise<string> {
  return callGeminiGenerateContent(
    [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }],
    usageContext
  );
}
