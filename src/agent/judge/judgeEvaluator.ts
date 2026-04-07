// src/agent/judge/judgeEvaluator.ts
// Phase45 Stream A: higher-level Judge orchestrator that fetches session messages,
// calls Groq 70b, persists new-column scores, and optionally seeds tuning_rules.

import { readFile } from 'fs/promises';
import path from 'path';

import pino from 'pino';

import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';
import { createNotification } from '../../lib/notifications';
import {
  searchKnowledgeForSuggestion,
  formatKnowledgeContext,
} from '../../lib/knowledgeSearchUtil';

const logger = pino();

const JUDGE_MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';

const FALLBACK_PROMPT_TEMPLATE = `あなたは営業チャットAIの品質評価Judgeです。
以下の会話ログを4軸（psychology_fit, customer_reaction, stage_progress, taboo_violation）で0-100採点し、
JSONのみで回答してください。

{{CONVERSATION_LOG}}

{"overall_score":0,"psychology_fit_score":0,"customer_reaction_score":0,"stage_progress_score":0,"taboo_violation_score":100,"feedback":{"psychology_fit":"","customer_reaction":"","stage_progress":"","taboo_violation":"違反なし","summary":""},"suggested_rules":[]}`;

export interface JudgeEvaluationResult {
  overall_score: number;
  psychology_fit_score: number;
  customer_reaction_score: number;
  stage_progress_score: number;
  taboo_violation_score: number;
  feedback: {
    psychology_fit: string;
    customer_reaction: string;
    stage_progress: string;
    taboo_violation: string;
    summary: string;
  };
  suggested_rules: Array<{
    rule_text: string;
    reason: string;
    priority: 'high' | 'medium' | 'low';
  }>;
}

interface ChatMessageRow {
  role: string;
  content: string;
  created_at: Date;
}

interface ChatSessionRow {
  id: string;
  tenant_id: string;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function parseJudgeResponse(raw: string): JudgeEvaluationResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Gemini response');
  }
  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

  const psychology_fit_score = clamp(Number(parsed['psychology_fit_score'] ?? 0));
  const customer_reaction_score = clamp(Number(parsed['customer_reaction_score'] ?? 0));
  const stage_progress_score = clamp(Number(parsed['stage_progress_score'] ?? 0));
  const taboo_violation_score = clamp(Number(parsed['taboo_violation_score'] ?? 100));

  // If model returned overall_score use it; otherwise compute weighted average
  const overall_score = clamp(
    typeof parsed['overall_score'] === 'number'
      ? (parsed['overall_score'] as number)
      : psychology_fit_score * 0.3 +
          customer_reaction_score * 0.25 +
          stage_progress_score * 0.25 +
          taboo_violation_score * 0.2,
  );

  const rawFeedback = (parsed['feedback'] ?? {}) as Record<string, unknown>;
  const feedback = {
    psychology_fit: typeof rawFeedback['psychology_fit'] === 'string' ? rawFeedback['psychology_fit'] : '',
    customer_reaction: typeof rawFeedback['customer_reaction'] === 'string' ? rawFeedback['customer_reaction'] : '',
    stage_progress: typeof rawFeedback['stage_progress'] === 'string' ? rawFeedback['stage_progress'] : '',
    taboo_violation: typeof rawFeedback['taboo_violation'] === 'string' ? rawFeedback['taboo_violation'] : '違反なし',
    summary: typeof rawFeedback['summary'] === 'string' ? rawFeedback['summary'] : '',
  };

  const rawRules = Array.isArray(parsed['suggested_rules']) ? parsed['suggested_rules'] : [];
  const suggested_rules = rawRules
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      rule_text: typeof r['rule_text'] === 'string' ? r['rule_text'] : '',
      reason: typeof r['reason'] === 'string' ? r['reason'] : '',
      priority: (['high', 'medium', 'low'] as const).includes(r['priority'] as 'high' | 'medium' | 'low')
        ? (r['priority'] as 'high' | 'medium' | 'low')
        : ('medium' as const),
    }));

  return {
    overall_score,
    psychology_fit_score,
    customer_reaction_score,
    stage_progress_score,
    taboo_violation_score,
    feedback,
    suggested_rules,
  };
}

async function loadPromptTemplate(): Promise<string> {
  try {
    const filePath = path.join(process.cwd(), 'config', 'judgePrompt.md');
    return await readFile(filePath, 'utf-8');
  } catch {
    logger.warn('judgeEvaluator: config/judgePrompt.md not found, using fallback prompt');
    return FALLBACK_PROMPT_TEMPLATE;
  }
}

export async function evaluateSession(sessionId: string): Promise<JudgeEvaluationResult | null> {
  try {
    const pool = getPool();

    // 1. Fetch internal id + tenant_id from chat_sessions (session_id is the public text key)
    const sessionResult = await pool.query<ChatSessionRow>(
      'SELECT id, tenant_id FROM chat_sessions WHERE session_id = $1 LIMIT 1',
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      logger.warn({ sessionId }, 'judgeEvaluator: session not found');
      return null;
    }
    const internalId: string = sessionResult.rows[0]!.id;
    const tenantId: string = sessionResult.rows[0]!.tenant_id;

    // 2. Fetch all messages using internal UUID (chat_messages.session_id → chat_sessions.id)
    const msgResult = await pool.query<ChatMessageRow>(
      'SELECT role, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC',
      [internalId],
    );
    const messages = msgResult.rows;

    // 2b. Skip evaluation for empty/single-message sessions
    if (messages.length <= 1) {
      logger.warn({ sessionId, messageCount: messages.length }, 'judgeEvaluator: skipping empty/single-message session');
      return null;
    }

    // 3. Build conversation log — content sliced to 200 chars (Anti-Slop rule)
    const conversationLog = (messages as ChatMessageRow[])
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join('\n');

    // 4. Load prompt template and inject conversation log
    const template = await loadPromptTemplate();
    const prompt = template.replace('{{CONVERSATION_LOG}}', conversationLog);

    // 4b. テナントのナレッジ・チューニングルールを取得してpsychology_fit評価の精度を上げる
    const firstUserMsg = (messages as ChatMessageRow[]).find((m) => m.role === 'user')?.content ?? '';
    const [knowledgeCtx, tuningRulesResult] = await Promise.all([
      firstUserMsg
        ? searchKnowledgeForSuggestion(tenantId, firstUserMsg).catch(() => ({ results: [] }))
        : Promise.resolve({ results: [] }),
      pool
        .query(
          'SELECT trigger_pattern, expected_behavior FROM tuning_rules WHERE tenant_id = $1 AND is_active = true LIMIT 10',
          [tenantId],
        )
        .then((res: { rows: Array<{ trigger_pattern: string; expected_behavior: string }> }) => res.rows)
        .catch(() => [] as Array<{ trigger_pattern: string; expected_behavior: string }>),
    ]);

    const knowledgeSection = formatKnowledgeContext(knowledgeCtx);
    const rulesText = (tuningRulesResult as Array<{ trigger_pattern: string; expected_behavior: string }>)
      .map((r: { trigger_pattern: string; expected_behavior: string }) => `- [${r.trigger_pattern}] ${r.expected_behavior}`)
      .join('\n');

    const knowledgeAppendix = [
      knowledgeSection
        ? `\n\n## このテナントの心理学ナレッジ\n${knowledgeSection}`
        : '',
      rulesText
        ? `\n\n## このテナントのチューニングルール\n${rulesText}\n\n上記のナレッジとルールに照らして、特にpsychology_fit_scoreの評価では「AIが適切な心理学原則を使えていたか」を具体的に判定してください。`
        : '',
    ].join('');

    // 5. Call Gemini — retry once on parse failure
    let result: JudgeEvaluationResult | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fullPrompt = `厳格な営業チャット品質評価Judgeです。指定されたJSON形式のみで回答します。\n\n${prompt}${knowledgeAppendix}`;
        const raw = await callGeminiJudge(fullPrompt);
        result = parseJudgeResponse(raw);
        break;
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          logger.warn({ err, sessionId, attempt }, 'judgeEvaluator: gemini call or parse failed, retrying');
        }
      }
    }

    if (!result) {
      logger.error({ err: lastError, sessionId }, 'judgeEvaluator: gemini evaluation failed after retries');
      return null;
    }

    // 6. Persist evaluation with new columns (INSERT ... ON CONFLICT DO NOTHING)
    await pool.query(
      `INSERT INTO conversation_evaluations
         (tenant_id, session_id, score,
          used_principles, effective_principles, failed_principles, evaluation_axes,
          psychology_fit_score, customer_reaction_score, stage_progress_score, taboo_violation_score,
          feedback, suggested_rules, message_count, judge_model)
       VALUES
         ($1, $2, $3,
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          $4, $5, $6, $7,
          $8::jsonb, $9::jsonb, $10, $11)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        sessionId,
        result.overall_score,
        result.psychology_fit_score,
        result.customer_reaction_score,
        result.stage_progress_score,
        result.taboo_violation_score,
        JSON.stringify(result.feedback),
        JSON.stringify(result.suggested_rules),
        messages.length,
        JUDGE_MODEL,
      ],
    );

    // 7. If score below threshold, seed tuning_rules
    const threshold = parseInt(process.env['JUDGE_SCORE_THRESHOLD'] ?? '60', 10);
    if (result.overall_score < threshold && result.suggested_rules.length > 0) {
      for (const rule of result.suggested_rules) {
        try {
          await pool.query(
            `INSERT INTO tuning_rules
               (tenant_id, trigger_pattern, expected_behavior, priority, is_active)
             VALUES ($1, $2, $3, $4, false)
             ON CONFLICT DO NOTHING`,
            [
              tenantId,
              rule.rule_text,
              rule.reason,
              rule.priority === 'high' ? 10 : rule.priority === 'medium' ? 5 : 1,
            ],
          );
        } catch (ruleErr) {
          logger.warn({ err: ruleErr, sessionId, rule: rule.rule_text }, 'judgeEvaluator: failed to insert tuning rule');
        }
      }
    }

    // Phase52h: Trigger 1 — AI提案ルール通知
    if (result.suggested_rules.length > 0) {
      void createNotification({
        recipientRole: 'super_admin',
        type: 'ai_rule_suggested',
        title: '新しいAI提案ルールがあります',
        message: `${result.suggested_rules.length}件のチューニングルールが提案されました（スコア: ${result.overall_score}）`,
        link: '/admin/evaluations',
        metadata: { sessionId, score: result.overall_score, ruleCount: result.suggested_rules.length },
      });
    }

    // Phase52h: Trigger 3 — 低スコアアラート（30未満）
    if (result.overall_score < 30) {
      void createNotification({
        recipientRole: 'super_admin',
        type: 'low_score_alert',
        title: '品質問題: 低スコアの会話があります',
        message: `スコア ${result.overall_score} の会話が検出されました`,
        link: '/admin/evaluations',
        metadata: { sessionId, score: result.overall_score },
      });
    }

    // Phase46: judge_low Gap Detection — if score is low, detect gap from first user message
    if (result.overall_score < threshold) {
      setImmediate(() => {
        import('../gap/gapDetector').then(({ detectGap }) => {
          // Get the first user message as the question that triggered low score
          const firstUserMsg = messages.find((m: ChatMessageRow) => m.role === 'user')?.content ?? '';
          if (!firstUserMsg || !tenantId) return;
          void detectGap({
            tenantId,
            sessionId,
            userMessage: firstUserMsg,
            ragResultCount: messages.length,  // use message count as proxy
            judgeScore: result.overall_score,
          }).catch(() => { /* silent */ });
        }).catch(() => { /* silent */ });
      });
    }

    return result;
  } catch (err) {
    logger.error({ err, sessionId }, 'judgeEvaluator: unexpected error in evaluateSession');
    return null;
  }
}
