// src/lib/gemini/client.ts
// Gemini 2.5 Flash REST client (Phase46)

import pino from 'pino';

const logger = pino();

const GEMINI_MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function callGeminiJudge(prompt: string): Promise<string> {
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
  return text;
}
