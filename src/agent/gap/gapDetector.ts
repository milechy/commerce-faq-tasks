// src/agent/gap/gapDetector.ts
// Phase46: Knowledge Gap 検出モジュール

import pino from 'pino';
import { getPool } from '../../lib/db';
import { createNotification, notificationExists } from '../../lib/notifications';

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
      // GID:1217040958080651 — FAQを足して穴を埋められる client_admin 宛と、
      // テナント横断で状況を把握する super_admin 宛の2件を発行する（片方に寄せない）
      if (updatedFreq >= 5) {
        void notifyFrequentGap({
          recipientRole: 'client_admin',
          recipientTenantId: input.tenantId,
          gapId,
          question: updatedQuestion,
          frequency: updatedFreq,
        });
        void notifyFrequentGap({
          recipientRole: 'super_admin',
          gapId,
          question: updatedQuestion,
          frequency: updatedFreq,
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

/**
 * GID:1217040958080651 — 頻出gap通知を宛先ごとに重複抑止しつつ発行する。
 * client_admin / super_admin はそれぞれ独立した重複抑止キー(gapId + role)を持つため、
 * 一方が既に通知済みでも他方の発行はブロックされない。
 * fire-and-forget 前提: 呼び出し側は void で呼ぶこと。内部で例外を握りつぶし、
 * gap 検出・チャット応答をブロックしない。
 */
async function notifyFrequentGap(params: {
  recipientRole: 'client_admin' | 'super_admin';
  recipientTenantId?: string;
  gapId: number;
  question: string;
  frequency: number;
}): Promise<void> {
  const dedupeKey = `${params.gapId}_${params.recipientRole}`;
  try {
    const alreadyExists = await notificationExists(
      'knowledge_gap_frequent',
      'gap_role',
      dedupeKey,
    );
    if (alreadyExists) return;

    await createNotification({
      recipientRole: params.recipientRole,
      recipientTenantId: params.recipientTenantId,
      type: 'knowledge_gap_frequent',
      title: 'よく聞かれる未回答質問があります',
      message: `「${params.question.slice(0, 50)}」が${params.frequency}回聞かれています`,
      link: '/admin/knowledge-gaps',
      metadata: { gapId: params.gapId, gap_role: dedupeKey },
    });
  } catch (err) {
    logger.warn(
      { err, gapId: params.gapId, recipientRole: params.recipientRole },
      'gapDetector.notifyFrequentGap.failed',
    );
  }
}
