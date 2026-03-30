// src/api/admin/evaluations/evaluationsRepository.ts
// Phase45: 評価データ DB リポジトリ（Stream A）
// スキーマ: judge-engine (Stream C) が定義した conversation_evaluations に準拠

import { getPool } from "../../../lib/db";

// ---------------------------------------------------------------------------
// 型定義（judge-engine スキーマ確定版）
// ---------------------------------------------------------------------------

export interface EvaluationAxes {
  principle_appropriateness: number;
  customer_reaction: number;
  stage_progression: number;
  contraindication_compliance: number;
}

export interface ConversationEvaluation {
  id: number;
  tenant_id: string;
  session_id: string;
  overall_score: number;                // 0–100 (aliased from DB column `score`)
  used_principles: string[];
  effective_principles: string[];
  failed_principles: string[];
  evaluation_axes: EvaluationAxes | null;
  notes: string | null;
  model_used: string | null;
  judge_model: string | null;
  evaluated_at: string;
  outcome: string;                      // 'replied' | 'appointment' | 'lost' | 'unknown'
  outcome_updated_by: string | null;
  outcome_updated_at: string | null;
}

export interface EvaluationStats {
  avg_score: number;
  count: number;
}

export interface PrincipleStat {
  usage_count: number;
  effectiveness_rate: number;           // effective_count / usage_count
}

export interface ScoreTrendPoint {
  date: string;                         // yyyy-mm-dd
  avg_score: number;
}

export interface DetailedStats {
  avg_score: number;
  principle_stats: Record<string, PrincipleStat>;
  reaction_distribution: Record<string, number>;
  stage_progression_rate: number;
  score_trend: ScoreTrendPoint[];
}

export interface KpiStats {
  total_conversations: number;
  outcomes: Record<string, number>;
  reply_rate: number;
  appointment_rate: number;
  lost_rate: number;
  avg_score_by_outcome: Record<string, number>;
  reply_rate_delta: number;
  appointment_rate_delta: number;
  lost_rate_delta: number;
}

// ---------------------------------------------------------------------------
// リスト取得
// ---------------------------------------------------------------------------

export interface ListEvaluationsParams {
  tenantId?: string;
  days?: number;
  limit?: number;
  offset?: number;
  min_score?: number;
  max_score?: number;
}

export async function listEvaluations(
  params: ListEvaluationsParams,
): Promise<{ evaluations: ConversationEvaluation[]; stats: EvaluationStats; total: number }> {
  const pool = getPool();
  const days = params.days ?? 7;
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  const conditions: string[] = [`evaluated_at >= NOW() - INTERVAL '${days} days'`];
  const args: unknown[] = [];
  let idx = 1;

  if (params.tenantId) {
    conditions.push(`tenant_id = $${idx++}`);
    args.push(params.tenantId);
  }

  if (params.min_score !== undefined) {
    conditions.push(`score >= $${idx++}`);
    args.push(params.min_score);
  }

  if (params.max_score !== undefined) {
    conditions.push(`score <= $${idx++}`);
    args.push(params.max_score);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await pool.query<{ count: string; avg_score: string }>(
    `SELECT COUNT(*) AS count, COALESCE(AVG(score), 0) AS avg_score
     FROM conversation_evaluations ${where}`,
    args,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
  const avg_score = parseFloat(countResult.rows[0]?.avg_score ?? "0");

  const listArgs = [...args, limit, offset];
  const listResult = await pool.query<ConversationEvaluation>(
    `SELECT id, tenant_id, session_id, score AS overall_score,
            COALESCE(used_principles, '{}') AS used_principles,
            COALESCE(effective_principles, '{}') AS effective_principles,
            COALESCE(failed_principles, '{}') AS failed_principles,
            evaluation_axes, notes, model_used, judge_model, evaluated_at,
            COALESCE(outcome, 'unknown') AS outcome,
            outcome_updated_by, outcome_updated_at
     FROM conversation_evaluations
     ${where}
     ORDER BY evaluated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    listArgs,
  );

  return {
    evaluations: listResult.rows,
    stats: { avg_score, count: total },
    total,
  };
}

// ---------------------------------------------------------------------------
// 詳細統計
// ---------------------------------------------------------------------------

export async function getDetailedStats(
  tenantId: string | undefined,
  days: number,
): Promise<DetailedStats> {
  const pool = getPool();
  const conditions: string[] = [`evaluated_at >= NOW() - INTERVAL '${days} days'`];
  const args: unknown[] = [];
  let idx = 1;

  if (tenantId) {
    conditions.push(`tenant_id = $${idx++}`);
    args.push(tenantId);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // avg_score
  const avgResult = await pool.query<{ avg_score: string }>(
    `SELECT COALESCE(AVG(score), 0) AS avg_score FROM conversation_evaluations ${where}`,
    args,
  );
  const avg_score = parseFloat(avgResult.rows[0]?.avg_score ?? "0");

  // reaction_distribution: evaluation_axes->customer_reaction をバケット化
  // 0–40: negative, 41–70: neutral, 71–100: positive
  const reactionResult = await pool.query<{ reaction: string; cnt: string }>(
    `SELECT
       CASE
         WHEN (evaluation_axes->>'customer_reaction')::float >= 71 THEN 'positive'
         WHEN (evaluation_axes->>'customer_reaction')::float >= 41 THEN 'neutral'
         WHEN evaluation_axes IS NOT NULL THEN 'negative'
         ELSE 'unknown'
       END AS reaction,
       COUNT(*) AS cnt
     FROM conversation_evaluations ${where}
     GROUP BY 1`,
    args,
  );
  const reaction_distribution: Record<string, number> = {};
  for (const row of reactionResult.rows) {
    reaction_distribution[row.reaction] = parseInt(row.cnt, 10);
  }

  // stage_progression_rate: evaluation_axes->stage_progression の平均を 0–1 に正規化
  const stageResult = await pool.query<{ avg_stage: string }>(
    `SELECT AVG((evaluation_axes->>'stage_progression')::float) AS avg_stage
     FROM conversation_evaluations
     ${where} AND evaluation_axes IS NOT NULL`,
    args,
  );
  const rawStage = parseFloat(stageResult.rows[0]?.avg_stage ?? "0");
  // score は 0–100 スケールなので 0–1 に正規化
  const stage_progression_rate = rawStage / 100;

  // principle_stats: used_principles の usage_count + effective_principles との照合で effectiveness_rate
  const usageResult = await pool.query<{ principle: string; usage_count: string }>(
    `SELECT p AS principle, COUNT(*) AS usage_count
     FROM conversation_evaluations, unnest(used_principles) AS p
     ${where}
     GROUP BY p`,
    args,
  );
  const effectiveResult = await pool.query<{ principle: string; effective_count: string }>(
    `SELECT p AS principle, COUNT(*) AS effective_count
     FROM conversation_evaluations, unnest(effective_principles) AS p
     ${where}
     GROUP BY p`,
    args,
  );

  const effectiveMap: Record<string, number> = {};
  for (const row of effectiveResult.rows) {
    effectiveMap[row.principle] = parseInt(row.effective_count, 10);
  }

  const principle_stats: Record<string, PrincipleStat> = {};
  for (const row of usageResult.rows) {
    const usage = parseInt(row.usage_count, 10);
    const effective = effectiveMap[row.principle] ?? 0;
    principle_stats[row.principle] = {
      usage_count: usage,
      effectiveness_rate: usage > 0 ? effective / usage : 0,
    };
  }

  // score_trend: 日次 avg_score（yyyy-mm-dd）
  const trendResult = await pool.query<{ date: string; avg_score: string }>(
    `SELECT TO_CHAR(DATE(evaluated_at), 'YYYY-MM-DD') AS date,
            AVG(score) AS avg_score
     FROM conversation_evaluations
     ${where}
     GROUP BY DATE(evaluated_at)
     ORDER BY DATE(evaluated_at) ASC`,
    args,
  );
  const score_trend: ScoreTrendPoint[] = trendResult.rows.map(
    (r: { date: string; avg_score: string }) => ({
      date: r.date,
      avg_score: parseFloat(r.avg_score ?? "0"),
    }),
  );

  return { avg_score, principle_stats, reaction_distribution, stage_progression_rate, score_trend };
}

// ---------------------------------------------------------------------------
// セッション別評価詳細
// ---------------------------------------------------------------------------

export async function getEvaluationsBySession(
  sessionId: string,
  tenantId: string | undefined,
): Promise<ConversationEvaluation[]> {
  const pool = getPool();
  const args: unknown[] = [sessionId];
  let where = "WHERE session_id = $1";

  if (tenantId) {
    where += " AND tenant_id = $2";
    args.push(tenantId);
  }

  const result = await pool.query<ConversationEvaluation>(
    `SELECT id, tenant_id, session_id, score AS overall_score,
            COALESCE(used_principles, '{}') AS used_principles,
            COALESCE(effective_principles, '{}') AS effective_principles,
            COALESCE(failed_principles, '{}') AS failed_principles,
            evaluation_axes, notes, model_used, evaluated_at,
            COALESCE(outcome, 'unknown') AS outcome,
            outcome_updated_by, outcome_updated_at
     FROM conversation_evaluations
     ${where}
     ORDER BY evaluated_at DESC`,
    args,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// outcome 更新
// ---------------------------------------------------------------------------

export async function updateOutcome(
  id: number,
  outcome: string,
  updatedBy: string,
  tenantId: string | undefined,
): Promise<ConversationEvaluation | null> {
  const pool = getPool();
  const args: unknown[] = [outcome, updatedBy, id];
  let where = "WHERE id = $3";

  if (tenantId) {
    where += " AND tenant_id = $4";
    args.push(tenantId);
  }

  const result = await pool.query<ConversationEvaluation>(
    `UPDATE conversation_evaluations
     SET outcome = $1,
         outcome_updated_by = $2,
         outcome_updated_at = NOW()
     ${where}
     RETURNING id, tenant_id, session_id, score AS overall_score,
               COALESCE(used_principles, '{}') AS used_principles,
               COALESCE(effective_principles, '{}') AS effective_principles,
               COALESCE(failed_principles, '{}') AS failed_principles,
               evaluation_axes, notes, model_used, evaluated_at,
               outcome, outcome_updated_by, outcome_updated_at`,
    args,
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// KPI 統計
// ---------------------------------------------------------------------------

export async function getKpiStats(
  tenantId: string | undefined,
  days: number,
): Promise<KpiStats> {
  const pool = getPool();
  const conditions: string[] = [`evaluated_at >= NOW() - INTERVAL '${days} days'`];
  const args: unknown[] = [];
  let idx = 1;

  if (tenantId) {
    conditions.push(`tenant_id = $${idx++}`);
    args.push(tenantId);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // 全体集計
  const totalResult = await pool.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM conversation_evaluations ${where}`,
    args,
  );
  const total_conversations = parseInt(totalResult.rows[0]?.total ?? "0", 10);

  // outcome 別件数
  const outcomeResult = await pool.query<{ outcome: string; cnt: string }>(
    `SELECT COALESCE(outcome, 'unknown') AS outcome, COUNT(*) AS cnt
     FROM conversation_evaluations ${where}
     GROUP BY outcome`,
    args,
  );
  const outcomes: Record<string, number> = {};
  for (const row of outcomeResult.rows) {
    outcomes[row.outcome] = parseInt(row.cnt, 10);
  }

  const replied = outcomes["replied"] ?? 0;
  const appointment = outcomes["appointment"] ?? 0;
  const lost = outcomes["lost"] ?? 0;
  const reply_rate = total_conversations > 0 ? replied / total_conversations : 0;
  const appointment_rate = total_conversations > 0 ? appointment / total_conversations : 0;
  const lost_rate = total_conversations > 0 ? lost / total_conversations : 0;

  // outcome 別 avg_score
  const avgByOutcomeResult = await pool.query<{ outcome: string; avg_score: string }>(
    `SELECT COALESCE(outcome, 'unknown') AS outcome, AVG(score) AS avg_score
     FROM conversation_evaluations ${where}
     GROUP BY outcome`,
    args,
  );
  const avg_score_by_outcome: Record<string, number> = {};
  for (const row of avgByOutcomeResult.rows) {
    avg_score_by_outcome[row.outcome] = parseFloat(row.avg_score ?? "0");
  }

  // delta: 前期間（同じ日数）との比較
  const prevConditions: string[] = [
    `evaluated_at >= NOW() - INTERVAL '${days * 2} days'`,
    `evaluated_at < NOW() - INTERVAL '${days} days'`,
  ];
  const prevArgs: unknown[] = [];
  if (tenantId) {
    prevConditions.push(`tenant_id = $${prevArgs.length + 1}`);
    prevArgs.push(tenantId);
  }
  const prevWhere = `WHERE ${prevConditions.join(" AND ")}`;

  const prevTotalResult = await pool.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM conversation_evaluations ${prevWhere}`,
    prevArgs,
  );
  const prev_total = parseInt(prevTotalResult.rows[0]?.total ?? "0", 10);

  const prevOutcomeResult = await pool.query<{ outcome: string; cnt: string }>(
    `SELECT COALESCE(outcome, 'unknown') AS outcome, COUNT(*) AS cnt
     FROM conversation_evaluations ${prevWhere}
     GROUP BY outcome`,
    prevArgs,
  );
  const prevOutcomes: Record<string, number> = {};
  for (const row of prevOutcomeResult.rows) {
    prevOutcomes[row.outcome] = parseInt(row.cnt, 10);
  }

  const prev_replied = prevOutcomes["replied"] ?? 0;
  const prev_appointment = prevOutcomes["appointment"] ?? 0;
  const prev_lost = prevOutcomes["lost"] ?? 0;
  const prev_reply_rate = prev_total > 0 ? prev_replied / prev_total : 0;
  const prev_appointment_rate = prev_total > 0 ? prev_appointment / prev_total : 0;
  const prev_lost_rate = prev_total > 0 ? prev_lost / prev_total : 0;

  return {
    total_conversations,
    outcomes,
    reply_rate,
    appointment_rate,
    lost_rate,
    avg_score_by_outcome,
    reply_rate_delta: reply_rate - prev_reply_rate,
    appointment_rate_delta: appointment_rate - prev_appointment_rate,
    lost_rate_delta: lost_rate - prev_lost_rate,
  };
}

// ---------------------------------------------------------------------------
// tuning_rules ステータス管理（approve / reject）
// ---------------------------------------------------------------------------

export interface TuningRuleWithStatus {
  id: number;
  tenant_id: string;
  status: string;
  approved_at: string | null;
  rejected_at: string | null;
  updated_at: string;
}

export async function approveTuningRule(
  id: number,
  tenantId: string | undefined,
): Promise<TuningRuleWithStatus | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = "WHERE id = $1";

  if (tenantId) {
    where += " AND tenant_id = $2";
    args.push(tenantId);
  }

  const result = await pool.query<TuningRuleWithStatus>(
    `UPDATE tuning_rules
     SET status = 'active',
         approved_at = NOW(),
         rejected_at = NULL,
         updated_at = NOW()
     ${where}
     RETURNING id, tenant_id, status, approved_at, rejected_at, updated_at`,
    args,
  );
  return result.rows[0] ?? null;
}

export async function rejectTuningRule(
  id: number,
  tenantId: string | undefined,
): Promise<TuningRuleWithStatus | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = "WHERE id = $1";

  if (tenantId) {
    where += " AND tenant_id = $2";
    args.push(tenantId);
  }

  const result = await pool.query<TuningRuleWithStatus>(
    `UPDATE tuning_rules
     SET status = 'rejected',
         rejected_at = NOW(),
         approved_at = NULL,
         updated_at = NOW()
     ${where}
     RETURNING id, tenant_id, status, approved_at, rejected_at, updated_at`,
    args,
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// ID による評価詳細取得（メッセージ付き）- Stream B
// ---------------------------------------------------------------------------

export async function getEvaluationById(
  id: number,
  tenantId: string | undefined,
): Promise<{
  evaluation: ConversationEvaluation;
  messages: Array<{ role: string; content: string; created_at: string }>;
} | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = "WHERE id = $1";

  if (tenantId) {
    where += " AND tenant_id = $2";
    args.push(tenantId);
  }

  const evalResult = await pool.query<ConversationEvaluation>(
    `SELECT id, tenant_id, session_id, score AS overall_score,
            COALESCE(used_principles, '{}') AS used_principles,
            COALESCE(effective_principles, '{}') AS effective_principles,
            COALESCE(failed_principles, '{}') AS failed_principles,
            evaluation_axes, notes, model_used, evaluated_at,
            COALESCE(outcome, 'unknown') AS outcome,
            outcome_updated_by, outcome_updated_at
     FROM conversation_evaluations
     ${where}`,
    args,
  );

  const evaluation = evalResult.rows[0];
  if (!evaluation) return null;

  const msgResult = await pool.query<{ role: string; content: string; created_at: string }>(
    `SELECT role, content, created_at
     FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [evaluation.session_id],
  );

  const messages = msgResult.rows.map((m: { role: string; content: string; created_at: string }) => ({
    role: m.role,
    content: m.content.slice(0, 200),
    created_at: m.created_at,
  }));

  return { evaluation, messages };
}

// ---------------------------------------------------------------------------
// セッション評価済みチェック - Stream B
// ---------------------------------------------------------------------------

export async function checkAlreadyEvaluated(sessionId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM conversation_evaluations WHERE session_id = $1`,
    [sessionId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10) > 0;
}

// ---------------------------------------------------------------------------
// suggested_rules[ruleIndex].status 更新 - Stream B
// ---------------------------------------------------------------------------

export async function updateSuggestedRuleStatus(
  evaluationId: number,
  ruleIndex: number,
  status: "approved" | "rejected",
  tenantId: string | undefined,
): Promise<ConversationEvaluation | null> {
  const pool = getPool();

  // Validate ruleIndex is within bounds
  const boundsArgs: unknown[] = [evaluationId];
  let boundsWhere = "WHERE id = $1";
  if (tenantId) {
    boundsWhere += " AND tenant_id = $2";
    boundsArgs.push(tenantId);
  }

  const boundsResult = await pool.query<{ suggested_rules: unknown }>(
    `SELECT suggested_rules FROM conversation_evaluations ${boundsWhere}`,
    boundsArgs,
  );
  const row = boundsResult.rows[0];
  if (!row) return null;

  const rules = Array.isArray(row.suggested_rules) ? row.suggested_rules : [];
  if (ruleIndex < 0 || ruleIndex >= rules.length) {
    throw new RangeError(`ruleIndex ${ruleIndex} out of bounds (length=${rules.length})`);
  }

  const updateArgs: unknown[] = [
    `{${ruleIndex},status}`,
    JSON.stringify(status),
    evaluationId,
  ];
  let updateWhere = "WHERE id = $3";
  if (tenantId) {
    updateWhere += " AND tenant_id = $4";
    updateArgs.push(tenantId);
  }

  const result = await pool.query<ConversationEvaluation>(
    `UPDATE conversation_evaluations
     SET suggested_rules = jsonb_set(
       COALESCE(suggested_rules, '[]'::jsonb),
       $1::text[],
       $2::jsonb,
       true
     )
     ${updateWhere}
     RETURNING id, tenant_id, session_id, score AS overall_score,
               COALESCE(used_principles, '{}') AS used_principles,
               COALESCE(effective_principles, '{}') AS effective_principles,
               COALESCE(failed_principles, '{}') AS failed_principles,
               evaluation_axes, notes, model_used, evaluated_at,
               COALESCE(outcome, 'unknown') AS outcome,
               outcome_updated_by, outcome_updated_at`,
    updateArgs,
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// suggested_rules から tuning_rules へ挿入 - Stream B
// ---------------------------------------------------------------------------

export async function insertTuningRuleFromSuggestion(
  tenantId: string,
  ruleText: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO tuning_rules
       (tenant_id, trigger_pattern, expected_behavior, priority, is_active)
     VALUES ($1, $2, $2, 0, true)
     ON CONFLICT DO NOTHING`,
    [tenantId, ruleText],
  );
}
