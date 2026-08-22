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
import {
  getCrossTenantContext,
  formatCrossTenantContext,
} from '../../lib/crossTenantContext';

const logger = pino();

/** evaluateSession に expectedTenantId を渡した際、セッションの実tenant_idと一致しない場合に投げる。 */
export class SessionTenantMismatchError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} does not belong to the expected tenant`);
    this.name = 'SessionTenantMismatchError';
  }
}

/**
 * セッション自体が存在しない場合に投げる。
 * 呼び出し元(routes.ts)は SessionTenantMismatchError と同一の404に変換し、
 * 「存在しない」と「他テナントのもの」を区別可能な応答にしない（存在確認オラクル防止）。
 */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * セッションが存在し所有権も一致するが、会話が0〜1通のみで評価対象にならない場合に投げる。
 * これは障害ではなく正常な「評価対象外」状態のため、呼び出し元(routes.ts)は
 * 500(evaluation_failed)ではなく422で理由を返す。Gemini呼び出し失敗など
 * 真の内部エラー（null を返す経路）とは区別する。
 */
export class SessionTooShortError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has too few messages to evaluate`);
    this.name = 'SessionTooShortError';
  }
}

/**
 * すでに評価済みのセッションを再評価しようとした場合に投げる。
 *
 * 自動評価の呼び出し元(langGraphOrchestrator / flowControl)は「終端到達」を検知するたびに
 * evaluateSession を fire-and-forget で叩くが、ターン予算超過セッションでは
 * `turnIndex > maxTurnsPerSession` が以降ずっと真になるため、ユーザーが発言するたびに
 * 何度でも再発火する(並行性を伴わない決定的な多重実行)。Gemini課金の二重発生と、
 * conversation_evaluations の重複行による KPI 平均の下振れを防ぐため、
 * Gemini を呼ぶ前にこのガードで打ち切る。
 *
 * 障害ではなく「もう終わっている」という正常状態なので、呼び出し元(routes.ts)は
 * 500 ではなく 409(already_evaluated)に変換する。
 */
export class SessionAlreadyEvaluatedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has already been evaluated`);
    this.name = 'SessionAlreadyEvaluatedError';
  }
}

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
  prompt_variant_id: string | null;
  /**
   * 同一 (tenant_id, session_id) の評価行が既にあるか。
   * セッション取得と同じクエリの EXISTS で解決し、多重評価ガードの往復を増やさない。
   */
  already_evaluated: boolean;
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

export async function evaluateSession(sessionId: string, expectedTenantId?: string): Promise<JudgeEvaluationResult | null> {
  try {
    const pool = getPool();

    // 1. Fetch internal id + tenant_id from chat_sessions (session_id is the public text key)
    //    併せて「このセッションが既に評価済みか」を EXISTS で同時に引く(1b のガード用)。
    const sessionResult = await pool.query<ChatSessionRow>(
      `SELECT s.id, s.tenant_id, s.prompt_variant_id,
              EXISTS (
                SELECT 1 FROM conversation_evaluations ce
                WHERE ce.tenant_id = s.tenant_id AND ce.session_id = s.session_id
              ) AS already_evaluated
         FROM chat_sessions s
        WHERE s.session_id = $1
        LIMIT 1`,
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      logger.warn({ sessionId }, 'judgeEvaluator: session not found');
      // 「不在」と「他テナントのもの」を呼び出し元が同一の404にできるよう、
      // null(=処理失敗として500)ではなく専用エラーを投げる（存在確認オラクル防止）。
      throw new SessionNotFoundError(sessionId);
    }
    const internalId: string = sessionResult.rows[0]!.id;
    const tenantId: string = sessionResult.rows[0]!.tenant_id;
    const variantId: string | null = sessionResult.rows[0]!.prompt_variant_id ?? null;

    // 越境防止: 非super_adminの呼び出し元は自テナントのセッションのみ評価可能。
    // 存在有無を漏らさないため「見つからない」場合と同じ扱いにはせず、呼び出し元(routes.ts)が
    // 明示的に404へ変換できるよう専用エラーを投げる。
    if (expectedTenantId !== undefined && tenantId !== expectedTenantId) {
      logger.warn({ sessionId }, 'judgeEvaluator: tenant mismatch, refusing evaluation');
      throw new SessionTenantMismatchError(sessionId);
    }

    // 1b. 多重評価ガード: Gemini を呼ぶ前に既評価を弾く。
    //     自動評価は「終端到達」ごとに fire-and-forget で叩かれるが、ターン予算超過後は
    //     毎ターン再発火するため、ここで止めないと Gemini 課金と重複行が積み上がる。
    //     呼び出し元が7箇所あるため、各呼び出し側ではなくこの関数内に寄せて漏れを防ぐ。
    //     判定は 1. のセッション取得と同じクエリ内の EXISTS で済ませており、
    //     往復を増やしていない。
    //     真の同時実行はこの事前チェックをすり抜けうるが、その最終防波堤は
    //     conversation_evaluations の UNIQUE(tenant_id, session_id) + ON CONFLICT が担う。
    if (sessionResult.rows[0]!.already_evaluated === true) {
      logger.info({ sessionId, tenantId }, 'judgeEvaluator: session already evaluated, skipping');
      throw new SessionAlreadyEvaluatedError(sessionId);
    }

    // 2. Fetch all messages using internal UUID (chat_messages.session_id → chat_sessions.id)
    const msgResult = await pool.query<ChatMessageRow>(
      'SELECT role, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC',
      [internalId],
    );
    const messages = msgResult.rows;

    // 2b. Skip evaluation for empty/single-message sessions
    if (messages.length <= 1) {
      logger.warn({ sessionId, messageCount: messages.length }, 'judgeEvaluator: skipping empty/single-message session');
      throw new SessionTooShortError(sessionId);
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
    const [knowledgeCtx, tuningRulesResult, crossTenantCtx] = await Promise.all([
      firstUserMsg
        ? searchKnowledgeForSuggestion(tenantId, firstUserMsg).catch(() => ({ results: [] }))
        : Promise.resolve({ results: [] }),
      pool
        .query(
          // runtime (tuningRulesRepository) は tenant + 'global' 共有ルールを適用するため、
          // judge も同じルール集合で psychology_fit を評価する (他RAG経路と一貫)。
          "SELECT trigger_pattern, expected_behavior FROM tuning_rules WHERE (tenant_id = $1 OR tenant_id = 'global') AND is_active = true LIMIT 10",
          [tenantId],
        )
        .then((res: { rows: Array<{ trigger_pattern: string; expected_behavior: string }> }) => res.rows)
        .catch(() => [] as Array<{ trigger_pattern: string; expected_behavior: string }>),
      getCrossTenantContext().catch(() => ({ avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [], effectiveRulePatterns: [], totalTenants: 0, dataAsOf: new Date().toISOString() })),
    ]);

    const knowledgeSection = formatKnowledgeContext(knowledgeCtx);
    const rulesText = (tuningRulesResult as Array<{ trigger_pattern: string; expected_behavior: string }>)
      .map((r: { trigger_pattern: string; expected_behavior: string }) => `- [${r.trigger_pattern}] ${r.expected_behavior}`)
      .join('\n');
    const crossTenantSection = formatCrossTenantContext(crossTenantCtx);

    const knowledgeAppendix = [
      knowledgeSection
        ? `\n\n## このテナントの心理学ナレッジ\n${knowledgeSection}`
        : '',
      rulesText
        ? `\n\n## このテナントのチューニングルール\n${rulesText}\n\n上記のナレッジとルールに照らして、特にpsychology_fit_scoreの評価では「AIが適切な心理学原則を使えていたか」を具体的に判定してください。`
        : '',
      crossTenantSection
        ? `\n\n${crossTenantSection}`
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

    // 6. Persist evaluation with new columns.
    //    ON CONFLICT のターゲットを明示する。以前は無指定で、SERIAL の id にしか反応できず
    //    実質 no-op だった(= 重複行がそのまま入っていた)。
    //    ★このターゲット指定は UNIQUE(tenant_id, session_id) の存在が前提。
    //     マイグレーション未適用の状態でこのコードをデプロイすると INSERT が全て失敗する。
    //     必ず migration → deploy の順で適用すること(docs/DEPLOY_CHECKLIST.md 参照)。
    const insertResult = await pool.query(
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
       ON CONFLICT (tenant_id, session_id) DO NOTHING`,
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

    // 6a. 同時実行の敗者はここで打ち切る。1b のガードは「確認してから実行」なので
    //     真に並行した2本は両方すり抜けうるが、行を入れられるのは片方だけ。
    //     敗者がこのまま進むと tuning_rules・通知・蒸留・reward が二重に走るため、
    //     評価結果は返しつつ副作用だけをスキップする。
    if ((insertResult.rowCount ?? 0) === 0) {
      logger.info(
        { sessionId, tenantId },
        'judgeEvaluator: evaluation row already persisted by a concurrent run, skipping side effects',
      );
      return result;
    }

    // 6b. Phase71-A: 高スコア会話を learned_memory に蒸留 (fire-and-forget)
    //     書込み Feature Flag + スコア閾値のガードは distillAndPromote 内で行う。
    setImmediate(() => {
      import('../memory/memoryDistiller').then(({ distillAndPromote }) =>
        distillAndPromote({
          tenantId,
          sessionId,
          judgeScore: result.overall_score,
          messages: messages.map((m: ChatMessageRow) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      ).catch((err: unknown) => {
        logger.warn({ err, sessionId }, 'learnedMemory.distill.failed (non-blocking)');
      });
    });

    // 6c. Phase47-B: Judge評価完了後に OpenClaw-RL へ reward signal 送信 (fire-and-forget)
    //     Feature Flag (isOpenClawEnabled) のガードは sendRewardSignal 内で行う。
    setImmediate(() => {
      Promise.all([
        import('../openclaw/rewardBridge'),
        import('../dialog/flowContextStore'),
      ]).then(([{ sendRewardSignal }, { peekFlowSessionMeta }]) => {
        const terminalReason = peekFlowSessionMeta({ tenantId, conversationId: sessionId })?.terminalReason;
        const outcome =
          terminalReason === 'completed' ? 'replied' :
          terminalReason === 'aborted_user' || terminalReason === 'aborted_budget' ||
          terminalReason === 'aborted_loop_detected' || terminalReason === 'failed_safe_mode' ? 'lost' :
          'unknown'; // escalated_handoff / メタ未存在（プロセス再起動後・手動評価）は中立
        return sendRewardSignal({
          tenantId,
          sessionId,
          variantId,
          score: result.overall_score,
          outcome,
        });
      }).catch((err: unknown) => {
        logger.warn({ err, sessionId }, 'openclaw.reward.failed (non-blocking)');
      });
    });

    // 7. If score below threshold, seed tuning_rules
    const threshold = parseInt(process.env['JUDGE_SCORE_THRESHOLD'] ?? '60', 10);
    if (result.overall_score < threshold && result.suggested_rules.length > 0) {
      for (const rule of result.suggested_rules) {
        try {
          // source='judge' を明示する。未設定だとスキーマ既定 'manual' になり、
          // 店主が作ったルールと出所を区別できなくなる(承認導線で必須の情報)。
          await pool.query(
            `INSERT INTO tuning_rules
               (tenant_id, trigger_pattern, expected_behavior, priority, is_active, source)
             VALUES ($1, $2, $3, $4, false, 'judge')
             ON CONFLICT (tenant_id, trigger_pattern) DO NOTHING`,
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
    if (
      err instanceof SessionTenantMismatchError ||
      err instanceof SessionNotFoundError ||
      err instanceof SessionTooShortError ||
      err instanceof SessionAlreadyEvaluatedError
    ) throw err;
    logger.error({ err, sessionId }, 'judgeEvaluator: unexpected error in evaluateSession');
    return null;
  }
}
