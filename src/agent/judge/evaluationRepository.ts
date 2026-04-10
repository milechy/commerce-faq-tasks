// src/agent/judge/evaluationRepository.ts
// Phase45: Judge評価結果のDBリポジトリ

import { Pool } from 'pg';
import { getPool as _getDefaultPool } from '../../lib/db';

export interface EvaluationAxes {
  principle_appropriateness: number; // 0-100
  customer_reaction: number;         // 0-100
  stage_progression: number;         // 0-100
  contraindication_compliance: number; // 0-100
}

export interface ConversationEvaluation {
  id?: number;
  tenantId: string;
  sessionId: string;
  score: number;
  usedPrinciples: string[];
  effectivePrinciples: string[];
  failedPrinciples: string[];
  evaluationAxes: EvaluationAxes;
  notes?: string;
  modelUsed?: string;
  evaluatedAt?: Date;
  createdAt?: Date;
}

interface DbRow {
  id: number;
  tenant_id: string;
  session_id: string;
  score: number;
  used_principles: string[];
  effective_principles: string[];
  failed_principles: string[];
  evaluation_axes: EvaluationAxes;
  notes: string | null;
  model_used: string | null;
  evaluated_at: Date;
  created_at: Date;
}

function rowToEvaluation(row: DbRow): ConversationEvaluation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    score: row.score,
    usedPrinciples: row.used_principles ?? [],
    effectivePrinciples: row.effective_principles ?? [],
    failedPrinciples: row.failed_principles ?? [],
    evaluationAxes: row.evaluation_axes,
    notes: row.notes ?? undefined,
    modelUsed: row.model_used ?? undefined,
    evaluatedAt: row.evaluated_at,
    createdAt: row.created_at,
  };
}

export function createEvaluationRepository(pool?: InstanceType<typeof Pool>) {
  // pool resolution is deferred to actual DB calls to allow module-level initialization
  // without DATABASE_URL (e.g. test environments)
  function getPool(): InstanceType<typeof Pool> {
    return pool ?? _getDefaultPool();
  }

  return {
    async saveEvaluation(
      evaluation: ConversationEvaluation,
    ): Promise<ConversationEvaluation> {
      const result = await getPool().query<DbRow>(
        `INSERT INTO conversation_evaluations
           (tenant_id, session_id, score, used_principles, effective_principles,
            failed_principles, evaluation_axes, notes, model_used)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         RETURNING id, tenant_id, session_id, score, used_principles,
                   effective_principles, failed_principles, evaluation_axes,
                   notes, model_used, evaluated_at, created_at`,
        [
          evaluation.tenantId,
          evaluation.sessionId,
          evaluation.score,
          JSON.stringify(evaluation.usedPrinciples),
          JSON.stringify(evaluation.effectivePrinciples),
          JSON.stringify(evaluation.failedPrinciples),
          JSON.stringify(evaluation.evaluationAxes),
          evaluation.notes ?? null,
          evaluation.modelUsed ?? 'llama-3.3-70b-versatile',
        ],
      );
      return rowToEvaluation(result.rows[0]!);
    },

    async getEvaluationsByTenant(
      tenantId: string,
      limit: number,
      offset: number,
    ): Promise<ConversationEvaluation[]> {
      const result = await getPool().query<DbRow>(
        `SELECT id, tenant_id, session_id, score, used_principles,
                effective_principles, failed_principles, evaluation_axes,
                notes, model_used, evaluated_at, created_at
         FROM conversation_evaluations
         WHERE tenant_id = $1
         ORDER BY evaluated_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      );
      return result.rows.map(rowToEvaluation);
    },

    async getEvaluationBySession(
      sessionId: string,
    ): Promise<ConversationEvaluation | null> {
      const result = await getPool().query<DbRow>(
        `SELECT id, tenant_id, session_id, score, used_principles,
                effective_principles, failed_principles, evaluation_axes,
                notes, model_used, evaluated_at, created_at
         FROM conversation_evaluations
         WHERE session_id = $1
         ORDER BY evaluated_at DESC
         LIMIT 1`,
        [sessionId],
      );
      if (result.rows.length === 0) return null;
      return rowToEvaluation(result.rows[0]!);
    },

    async getAggregateStats(
      tenantId: string,
      days: number,
    ): Promise<{
      avgScore: number;
      totalCount: number;
      principleStats: Record<string, { effective: number; failed: number }>;
    }> {
      const statsResult = await getPool().query<{
        avg_score: string;
        total_count: string;
      }>(
        `SELECT AVG(score)::float AS avg_score, COUNT(*)::int AS total_count
         FROM conversation_evaluations
         WHERE tenant_id = $1
           AND evaluated_at >= NOW() - INTERVAL '1 day' * $2`,
        [tenantId, days],
      );

      const avgScore = parseFloat(statsResult.rows[0]?.avg_score ?? '0') || 0;
      const totalCount = parseInt(statsResult.rows[0]?.total_count ?? '0', 10) || 0;

      // effective_principles 集計
      const effectiveResult = await getPool().query<{
        principle: string;
        cnt: string;
      }>(
        `SELECT jsonb_array_elements_text(effective_principles) AS principle,
                COUNT(*) AS cnt
         FROM conversation_evaluations
         WHERE tenant_id = $1
           AND evaluated_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY principle`,
        [tenantId, days],
      );

      // failed_principles 集計
      const failedResult = await getPool().query<{
        principle: string;
        cnt: string;
      }>(
        `SELECT jsonb_array_elements_text(failed_principles) AS principle,
                COUNT(*) AS cnt
         FROM conversation_evaluations
         WHERE tenant_id = $1
           AND evaluated_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY principle`,
        [tenantId, days],
      );

      const principleStats: Record<string, { effective: number; failed: number }> = {};

      for (const row of effectiveResult.rows) {
        if (!principleStats[row.principle]) {
          principleStats[row.principle] = { effective: 0, failed: 0 };
        }
        principleStats[row.principle]!.effective += parseInt(row.cnt, 10);
      }

      for (const row of failedResult.rows) {
        if (!principleStats[row.principle]) {
          principleStats[row.principle] = { effective: 0, failed: 0 };
        }
        principleStats[row.principle]!.failed += parseInt(row.cnt, 10);
      }

      return { avgScore, totalCount, principleStats };
    },
  };
}
