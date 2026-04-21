// src/agent/orchestrator/llmCalls.ts
// プランナー・回答 LLM 呼び出し + プロンプトビルダー

import pino from 'pino';
import { callGroqWith429Retry } from '../llm/groqClient';
import type { PlannerPlan } from '../dialog/types';
import type { PlannerRoute } from '../llm/modelRouter';
import { RAG_EXCERPT_MAX_CHARS, RAG_MAX_EXCERPTS } from '../config/ragLimits';
import { detectIntentHint, type DialogInput, type RagContext } from './flowControl';
import { trackLlmGeneration } from '../../lib/posthog/llmAnalyticsTracker';

const logger = pino();

export function buildPlannerPrompt(payload: {
  input: DialogInput;
  ragContext?: RagContext;
}): string {
  const { input } = payload;

  const recentLines =
    input.history && input.history.length
      ? input.history
          .slice(-6)
          .map((m, idx) => `${idx + 1}. ${m.role}: ${m.content}`)
          .join('\n')
      : '(no recent messages)';

  const intent = detectIntentHint(input);

  const summaryBlock = input.historySummary
    ? [
        'Summarized earlier conversation (compressed, semantic sections: Goals / Constraints / Decisions / OpenQuestions / FAQContext):',
        input.historySummary,
        '',
        'Recent conversation history (most recent last):',
      ].join('\n')
    : 'Recent conversation history (most recent last):';

  return [
    'You are the dialog planner for a commerce FAQ assistant.',
    'You receive a semantic summary of earlier conversation organized into sections: Goals, Constraints, Decisions, OpenQuestions, FAQContext.',
    'Use these sections to respect user constraints, remember agreed decisions, and prioritize unresolved questions when planning steps.',
    `User locale: ${input.locale}`,
    `Detected intent (rough guess): ${intent}`,
    '',
    summaryBlock,
    recentLines,
    '',
    `Current user message: "${input.userMessage}"`,
    '',
    'Output STRICTLY a single JSON object with the following shape:',
    '',
    '{',
    '  "steps": [',
    '    {',
    '      "id": "step_clarify_1",',
    '      "stage": "clarify",',
    '      "title": "用途と地域のヒアリング",',
    '      "description": "ユーザーがどの商品について、どの地域への配送について知りたいかを明確にするための質問を行うステップ。",',
    '      "question": "どの商品を、どの地域にお届け予定でしょうか？"',
    '    },',
    '    {',
    '      "id": "step_propose_1",',
    '      "stage": "propose",',
    '      "title": "基本的な送料ポリシーの提示",',
    '      "description": "店舗全体の一般的な送料ポリシーを説明するステップ。特定の商品／地域が分かっていない場合は、代表的な例で説明する。"',
    '    },',
    '    {',
    '      "id": "step_recommend_1",',
    '      "stage": "recommend",',
    '      "title": "おすすめプランの提示",',
    '      "description": "ユーザーの用途や制約に合わせて、具体的なプランや商品構成を1〜3個ほど提案するステップ。上位プランが適切ならその提案も含める。",',
    '      "productIds": []',
    '    },',
    '    {',
    '      "id": "step_close_1",',
    '      "stage": "close",',
    '      "title": "クロージングと行動提案",',
    '      "description": "不安を1つだけケアしたうえで、次に取るべき具体的な行動（購入／予約／問い合わせなど）を1つ提案するステップ。",',
    '      "cta": "purchase"',
    '    }',
    '  ],',
    '  "needsClarification": true,',
    '  "clarifyingQuestions": ["どの商品・どの地域への配送／送料について知りたいですか？"],',
    '  "followupQueries": [],',
    '  "confidence": "medium"',
    '}',
    '',
    'Rules:',
    '- Respond with JSON ONLY. No prose, no explanation.',
    '- For each step, `stage` MUST be one of: "clarify", "propose", "recommend", "close".',
    '- Use Japanese for all titles, descriptions, and questions when locale is "ja"; use English when locale is "en".',
    '- Clarify (stage="clarify"): ask short, concrete questions to fill missing information (用途 / 地域 / 予算 / 決済方法など)。',
    '- Propose (stage="propose"): summarize a single best-fit plan or policy based on known information and explicit constraints.',
    '- Recommend (stage="recommend"): compare 1〜3 concrete options (プラン／商品) and explain why they are suitable. If appropriate, include a slightly higher plan as an upsell option.',
    '- Close (stage="close"): resolve one key remaining concern and propose exactly ONE clear next action (CTA). Set cta to "purchase", "reserve", "contact", "download", or "other".',
    '- If the current user message clearly answers a previous clarification question, set "needsClarification" to false and do NOT add new clarify steps.',
    '- Use the "Constraints" section in the summary to avoid proposing options that violate explicit user limits (delivery region, budget, payment method, etc.).',
    '- Use the "OpenQuestions" section in the summary to prioritize resolving the most important unresolved question in this turn.',
  ].join('\n');
}

export function buildAnswerPrompt(payload: {
  input: DialogInput;
  ragContext?: RagContext;
  plannerSteps?: unknown;
  safeMode?: boolean;
}): string {
  const { input, ragContext, safeMode } = payload;

  const docs = ragContext?.documents ?? [];
  const contextSnippet =
    docs.length > 0
      ? docs
          .slice(0, RAG_MAX_EXCERPTS)
          .map((d, idx) => `${idx + 1}. ${d.text.slice(0, RAG_EXCERPT_MAX_CHARS)}`)
          .join('\n')
      : '(no retrieved documents)';

  const baseLines = [
    input.historySummary
      ? `Summarized prior conversation: ${input.historySummary}`
      : undefined,
    `User message: ${input.userMessage}`,
    '',
    'Context documents (top snippets):',
    contextSnippet,
    '',
  ].filter((v): v is string => Boolean(v));

  const normalInstructions = [
    'Use the above context and any previously executed tools or steps to answer the user.',
    'Keep the answer reasonably concise (around 3–8 short sentences or bullet points).',
    'Avoid large tables or very long paragraphs unless the user explicitly requested them.',
    'If you are not sure, clearly say that you are not sure.',
  ];

  const safeModeInstructions = [
    'The topic may involve sensitive, harmful, or abusive content.',
    'Respond in a cautious, supportive, and neutral tone.',
    'Keep the answer concise (around 3–6 short bullet points or paragraphs).',
    'Do NOT provide explicit instructions that could enable self-harm, violence, abuse, or illegal activities.',
    "Explicitly mention that this is general information and may not fully apply to the user's specific situation.",
    'If the user appears to be in danger or asking for how to commit harm, politely refuse and instead encourage seeking help from appropriate professionals or authorities.',
    'If you are not sure, clearly say that you are not sure, and avoid speculation.',
  ];

  const instructions = safeMode ? safeModeInstructions : normalInstructions;
  return [...baseLines, ...instructions].join('\n');
}

export async function callPlannerLLM(
  route: PlannerRoute,
  payload: { input: DialogInput; ragContext?: RagContext },
): Promise<PlannerPlan> {
  const model =
    route === '120b'
      ? process.env.GROQ_PLANNER_120B_MODEL ?? 'groq/compound'
      : process.env.GROQ_PLANNER_20B_MODEL ?? 'groq/compound-mini';

  const prompt = buildPlannerPrompt(payload);

  logger.info(
    {
      route,
      model,
      preview: prompt.slice(0, 400),
      conversationId: payload.input.conversationId,
      userMessagePreview: payload.input.userMessage.slice(0, 120),
    },
    'planner.prompt',
  );

  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are the dialog planner for a commerce FAQ assistant. Always respond with valid JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      maxTokens: 512,
      tag: 'planner',
    },
    { logger },
  );

  logger.info({ route, model, rawPreview: raw.slice(0, 400) }, 'planner.raw');

  try {
    const rawJson = JSON.parse(raw) as any;
    if (!rawJson || !Array.isArray(rawJson.steps))
      throw new Error('Planner JSON has no steps array');

    const normalizedSteps = rawJson.steps.map((step: any, idx: number) => {
      if (step && typeof step === 'object' && step.stage) return step;

      const id = step.id ?? `step_${idx + 1}`;
      const type = String(step.type ?? 'answer');
      const description = String(step.description ?? '');
      const title =
        step.title ??
        (type === 'clarify'
          ? 'Clarification'
          : type === 'search'
          ? 'Search context'
          : 'Recommendation');

      if (type === 'clarify') {
        return {
          id,
          stage: 'clarify',
          title,
          description: description || 'Clarify user requirements.',
          question:
            Array.isArray(step.questions) && step.questions.length
              ? String(step.questions[0])
              : undefined,
        };
      }

      if (type === 'search') {
        return {
          id,
          stage: 'propose',
          title,
          description:
            description ||
            'Search related FAQ entries to gather context for the answer.',
        };
      }

      return {
        id,
        stage: 'recommend',
        title,
        description:
          description ||
          'Provide a recommendation or answer based on the gathered context.',
      };
    });

    const normalizedPlan: PlannerPlan = { ...rawJson, steps: normalizedSteps };
    return normalizedPlan;
  } catch {
    return {
      steps: [
        {
          id: 'fallback_propose_1',
          stage: 'propose',
          title: 'fallback answer',
          description: 'fallback answer step due to planner JSON parse error',
        },
      ],
      needsClarification: false,
      confidence: 'low',
      raw,
    } as PlannerPlan;
  }
}

export async function callAnswerLLM(
  route: PlannerRoute,
  payload: {
    input: DialogInput;
    ragContext?: RagContext;
    plannerSteps?: unknown;
    safeMode?: boolean;
  },
): Promise<string> {
  const model =
    route === '120b'
      ? process.env.GROQ_ANSWER_120B_MODEL ?? 'groq/compound'
      : process.env.GROQ_ANSWER_20B_MODEL ?? 'groq/compound-mini';

  const prompt = buildAnswerPrompt(payload);
  const maxTokens = payload.safeMode ? 320 : 256;

  const start = Date.now();
  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a commerce FAQ assistant. Answer clearly, in the user locale, and strictly follow any tool / RAG evidence.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens,
      tag: payload.safeMode ? 'answer-safe' : 'answer',
    },
    { logger },
  );
  const latencyMs = Date.now() - start;

  logger.info(
    { route, model, safeMode: !!payload.safeMode, latencyMs },
    'dialog.answer.finished',
  );

  // Fire-and-forget LLM Analytics (non-blocking, failure ignored)
  setImmediate(() => {
    try {
      trackLlmGeneration({
        tenantId: payload.input.tenantId,
        sessionId: payload.input.conversationId ?? 'unknown',
        model,
        provider: 'groq',
        latencyMs,
      });
    } catch { /* ignore */ }
  });

  return raw;
}
