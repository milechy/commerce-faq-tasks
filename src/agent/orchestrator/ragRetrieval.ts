// src/agent/orchestrator/ragRetrieval.ts
// RAG 検索 + 履歴要約

import pino from 'pino';
import { callGroqWith429Retry } from '../llm/groqClient';
import { runSearchAgent } from '../flow/searchAgent';
import type { DialogInput, RagContext } from './flowControl';

const logger = pino();

type ConversationTurn = { role: 'user' | 'assistant'; content: string };

export async function runInitialRagRetrieval(
  initialInput: DialogInput,
): Promise<RagContext> {
  logger.info(
    {
      tenantId: initialInput.tenantId,
      locale: initialInput.locale,
      preview: initialInput.userMessage.slice(0, 120),
    },
    'dialog.rag.start',
  );

  const searchResponse = await runSearchAgent({
    q: initialInput.userMessage,
    topK: 8,
    useLlmPlanner: false,
    debug: true,
  });

  const rerankDebug = searchResponse.debug?.rerank as
    | {
        items: Array<{ id: string; text: string; score: number }>;
        ce_ms?: number;
        engine?: 'heuristic' | 'ce' | 'ce+fallback';
        rerankEngine?: 'heuristic' | 'ce' | 'ce+fallback';
      }
    | undefined;

  const searchDebug = searchResponse.debug?.search as
    | {
        items: Array<{ id: string; text: string; score: number }>;
        ms?: number;
        note?: string;
      }
    | undefined;

  const items =
    rerankDebug?.items && rerankDebug.items.length
      ? rerankDebug.items
      : searchDebug?.items ?? [];

  const documents = (items ?? []).map((item: any) => ({
    id: String(item.id),
    score: typeof item.score === 'number' ? item.score : 0,
    text: String(item.text ?? ''),
  }));

  const totalChars = documents.reduce((sum, doc) => sum + doc.text.length, 0);
  const contextTokens = Math.min(
    4096,
    Math.max(128, Math.floor(totalChars / 4) || 256),
  );

  const searchMs =
    typeof searchDebug?.ms === 'number' ? searchDebug.ms : undefined;
  const rerankMs =
    typeof rerankDebug?.ce_ms === 'number' ? rerankDebug.ce_ms : undefined;
  const rerankEngine =
    rerankDebug?.rerankEngine ?? rerankDebug?.engine ?? undefined;

  const totalMs =
    typeof searchMs === 'number' || typeof rerankMs === 'number'
      ? (searchMs ?? 0) + (rerankMs ?? 0)
      : undefined;

  logger.info(
    {
      tenantId: initialInput.tenantId,
      locale: initialInput.locale,
      documents: documents.length,
      searchMs,
      rerankMs,
      rerankEngine,
      totalMs,
    },
    'dialog.rag.finished',
  );

  return {
    documents,
    recall: null,
    contextTokens,
    stats: { searchMs, rerankMs, rerankEngine, totalMs },
  };
}

export async function summarizeHistoryIfNeeded(
  initialInput: DialogInput,
): Promise<DialogInput> {
  const MAX_HISTORY_MESSAGES = 12;
  const KEEP_RECENT = 6;

  const history = initialInput.history ?? [];
  if (history.length <= MAX_HISTORY_MESSAGES) {
    return initialInput;
  }

  const older = history.slice(0, history.length - KEEP_RECENT);
  const recent = history.slice(-KEEP_RECENT);

  const summary = await summarizeHistoryWithLLM({
    locale: initialInput.locale,
    older,
    existingSummary: initialInput.historySummary,
  });

  return {
    ...initialInput,
    history: recent,
    historySummary: summary,
  };
}

async function summarizeHistoryWithLLM(payload: {
  locale: 'ja' | 'en';
  older: ConversationTurn[];
  existingSummary?: string;
}): Promise<string> {
  const { locale, older, existingSummary } = payload;

  if (!older.length) return existingSummary ?? '';

  const model = process.env.GROQ_PLANNER_20B_MODEL ?? 'groq/compound-mini';

  const turnsText = older
    .map((m, idx) => `${idx + 1}. ${m.role}: ${m.content}`)
    .join('\n');

  const systemContent =
    locale === 'ja'
      ? [
          'あなたはコマース FAQ アシスタント向けに会話履歴を要約するアシスタントです。',
          '常に次の 5 つのセクションを、この順番・見出し名で出力してください（足りない情報がある場合でも空で残してください）。',
          '',
          'Goals:',
          '- ユーザーの目的・ゴールを箇条書きでまとめる',
          '',
          'Constraints:',
          '- 配送エリア・予算・支払方法・利用不可なオプションなど、明示された制約を箇条書きでまとめる',
          '',
          'Decisions:',
          '- すでに合意・決定された事項を箇条書きでまとめる',
          '',
          'OpenQuestions:',
          '- まだ解決していない質問や TODO を箇条書きでまとめる',
          '',
          'FAQContext:',
          '- 店舗種別・ユーザー区分・既に説明済みのポリシーなど、補助的な文脈を箇条書きでまとめる',
          '',
          '出力は必ずこの 5 見出しと箇条書きのみを含めてください。余計な説明文や前後の文章は追加しないでください。',
        ].join('\n')
      : [
          'You summarize conversation history for a commerce FAQ assistant.',
          'Always respond using the following 5 sections, in this exact order and with these exact headings (even if some are empty):',
          '',
          'Goals:',
          "- Bullet points summarizing the user's goals.",
          '',
          'Constraints:',
          '- Bullet points summarizing explicit constraints (delivery region, budget, payment methods, unavailable options, etc.).',
          '',
          'Decisions:',
          '- Bullet points summarizing already agreed or decided items.',
          '',
          'OpenQuestions:',
          '- Bullet points summarizing unresolved questions or TODOs.',
          '',
          'FAQContext:',
          '- Bullet points summarizing any helpful context (store type, user segment, policies already explained, etc.).',
          '',
          'Only output these 5 headings and bullet points. Do not add any additional prose before or after.',
        ].join('\n');

  const userParts: string[] = [];
  if (existingSummary && existingSummary.trim().length > 0) {
    userParts.push(
      locale === 'ja'
        ? `これまでのサマリ:\n${existingSummary}`
        : `Existing summary:\n${existingSummary}`,
    );
  }
  userParts.push(
    locale === 'ja'
      ? `以下の会話ターンを、先ほどのフォーマット (Goals / Constraints / Decisions / OpenQuestions / FAQContext) に従ってセマンティックサマリとしてまとめ直してください:\n${turnsText}`
      : `Rewrite the following conversation turns as a structured semantic summary using the sections (Goals / Constraints / Decisions / OpenQuestions / FAQContext):\n${turnsText}`,
  );

  const prompt = userParts.join('\n\n');

  const raw = await callGroqWith429Retry(
    {
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 384,
      tag: 'summary',
    },
    { logger },
  );

  return raw.trim();
}
