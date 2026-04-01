// src/agent/gap/gapDetector.ts
// Phase46: Knowledge Gap 検出モジュール

import pino from 'pino';
import { getPool } from '../../lib/db';
import { createNotification } from '../../lib/notifications';

const logger = pino();

export type GapDetectionSource =
  | 'no_rag'
  | 'low_confidence'
  | 'fallback'
  | 'judge_low';

export interface GapDetectionInput {
  tenantId: string;
  sessionId: string;
  userMessage: string;
  ragResultCount: number;
  topRerankScore?: number;
  templateSource?: string;  // 'notion' | 'fallback'
  judgeScore?: number;
}

export interface GapDetectionResult {
  detected: boolean;
  source: GapDetectionSource | null;
  gapId?: number;
}

const LOW_CONFIDENCE_THRESHOLD = () =>
  parseFloat(process.env['GAP_CONFIDENCE_THRESHOLD'] ?? '0.3');

const JUDGE_LOW_THRESHOLD = () =>
  parseInt(process.env['JUDGE_SCORE_THRESHOLD'] ?? '60', 10);

export async function detectGap(input: GapDetectionInput): Promise<GapDetectionResult> {
  if (process.env['GAP_DETECTION_ENABLED'] === 'false') {
    return { detected: false, source: null };
  }

  // Trigger priority order
  if (input.ragResultCount === 0) {
    return upsertGap(input, 'no_rag');
  }
  if (input.topRerankScore !== undefined && input.topRerankScore < LOW_CONFIDENCE_THRESHOLD()) {
    return upsertGap(input, 'low_confidence');
  }
  if (input.templateSource === 'fallback') {
    return upsertGap(input, 'fallback');
  }
  if (input.judgeScore !== undefined && input.judgeScore < JUDGE_LOW_THRESHOLD()) {
    return upsertGap(input, 'judge_low');
  }
  return { detected: false, source: null };
}

async function upsertGap(
  input: GapDetectionInput,
  source: GapDetectionSource,
): Promise<GapDetectionResult> {
  // Anti-Slop: truncate userMessage to 200 chars
  const question = input.userMessage.slice(0, 200);

  try {
    const pool = getPool();

    // Look for existing open gap with similar question (ILIKE partial match) in last 7 days
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM knowledge_gaps
       WHERE tenant_id = $1
         AND status = 'open'
         AND user_question ILIKE $2
         AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.tenantId, `%${question.slice(0, 50)}%`],
    );

    if (existing.rows.length > 0) {
      const gapId = existing.rows[0]!.id;
      // Increment frequency and update last_detected_at
      const updateResult = await pool.query<{ frequency: number; user_question: string }>(
        `UPDATE knowledge_gaps
         SET frequency = COALESCE(frequency, 1) + 1,
             last_detected_at = NOW(),
             detection_source = $2
         WHERE id = $1
         RETURNING frequency, user_question`,
        [gapId, source],
      );
      const updatedFreq: number = updateResult.rows[0]?.frequency ?? 0;
      const updatedQuestion: string = updateResult.rows[0]?.user_question ?? question;

      // Phase52h: Trigger 2 — 頻出未回答質問通知（5回以上）
      if (updatedFreq >= 5) {
        void createNotification({
          recipientRole: 'super_admin',
          type: 'knowledge_gap_frequent',
          title: 'よく聞かれる未回答質問があります',
          message: `「${updatedQuestion.slice(0, 50)}」が${updatedFreq}回聞かれています`,
          link: '/admin/knowledge-gaps',
          metadata: { gapId },
        });
      }

      return { detected: true, source, gapId };
    }

    // Insert new gap
    const result = await pool.query<{ id: number }>(
      `INSERT INTO knowledge_gaps
         (tenant_id, user_question, session_id, rag_hit_count, rag_top_score,
          detection_source, frequency, last_detected_at, recommendation_status)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, 1, NOW(), 'pending')
       RETURNING id`,
      [
        input.tenantId,
        question,
        input.sessionId || null,
        input.ragResultCount,
        input.topRerankScore ?? 0,
        source,
      ],
    );
    return { detected: true, source, gapId: result.rows[0]?.id };
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId, source }, 'gapDetector.upsert.failed');
    return { detected: false, source: null };
  }
}
