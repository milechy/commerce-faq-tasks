// src/lib/book-pipeline/pipelineQueue.ts
// Phase70K: DB-backed pipeline queue — PM2再起動による stuck job 撲滅
// in-memory キュー (Phase47) を書き換え。外部依存: book_pipeline_jobs テーブル

import type { Pool } from "pg";
import { runBookPipeline } from "./pipeline";
import type { PipelineDeps } from "./pipeline";
import { logger } from '../logger';
import { sendSlackAlert } from '../alerts/slackNotifier';

const MAX_RETRIES = 3;

interface JobRow {
  id: number;
  book_id: number;
  attempts: number;
}

class PipelineQueue {
  private running = false;

  async enqueue(bookId: number, deps: PipelineDeps): Promise<void> {
    await deps.db.query(
      `INSERT INTO book_pipeline_jobs (book_id, status, enqueued_at)
       VALUES ($1, 'enqueued', NOW())`,
      [bookId]
    );
    if (!this.running) {
      this.running = true;
      void this.processNext(deps);
    }
  }

  /**
   * 起動時 self-heal:
   * 1. orphaned 'running' ジョブ（サーバークラッシュで放置）を 'enqueued' にリセット
   * 2. book_uploads.status='uploaded' かつ active なジョブがない書籍を再エンキュー
   */
  async selfHeal(db: Pool): Promise<void> {
    await db.query(
      `UPDATE book_pipeline_jobs SET status = 'enqueued', started_at = NULL
       WHERE status = 'running'`
    );

    const { rows } = await db.query<{ id: number }>(
      `SELECT bu.id
       FROM book_uploads bu
       WHERE bu.status = 'uploaded'
         AND bu.created_at < NOW() - INTERVAL '5 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM book_pipeline_jobs bpj
           WHERE bpj.book_id = bu.id
             AND bpj.status IN ('enqueued', 'running')
         )`
    );

    for (const { id } of rows) {
      await db.query(
        `INSERT INTO book_pipeline_jobs (book_id, status, enqueued_at)
         VALUES ($1, 'enqueued', NOW())`,
        [id]
      );
    }

    if (rows.length > 0) {
      logger.info('[pipelineQueue] selfHeal: re-enqueued %d stuck jobs', rows.length);
    }

    if (!this.running) {
      this.running = true;
      void this.processNext({ db });
    }
  }

  /** 10分毎ヘルスチェック: running 1時間超のジョブを Slack 通知 */
  async checkStuckJobs(db: Pool): Promise<void> {
    const { rows } = await db.query<{ book_id: number; started_at: string }>(
      `SELECT book_id, started_at FROM book_pipeline_jobs
       WHERE status = 'running'
         AND started_at < NOW() - INTERVAL '1 hour'`
    );
    for (const row of rows) {
      sendSlackAlert({
        ruleId: 'pipeline_job_stuck',
        name: 'PipelineJob stuck 1時間超',
        level: 'WARNING',
        status: 'FIRING',
        details: `book_id=${row.book_id} started_at=${row.started_at}`,
      }).catch(() => {});
    }
  }

  private async processNext(deps: PipelineDeps): Promise<void> {
    try {
      while (true) {
        // 次の enqueued ジョブをアトミックにクレーム (FOR UPDATE SKIP LOCKED で競合回避)
        const { rows } = await deps.db.query<JobRow>(
          `UPDATE book_pipeline_jobs
           SET status = 'running', started_at = NOW(), attempts = attempts + 1
           WHERE id = (
             SELECT id FROM book_pipeline_jobs
             WHERE status = 'enqueued' AND enqueued_at <= NOW()
             ORDER BY enqueued_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, book_id, attempts`
        );

        if (rows.length === 0) break;
        const job = rows[0];

        try {
          await runBookPipeline(job.book_id, deps);
          await deps.db.query(
            `UPDATE book_pipeline_jobs SET status = 'done' WHERE id = $1`,
            [job.id]
          );
        } catch (err) {
          await this.handleJobError(job, err, deps.db);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async handleJobError(job: JobRow, err: unknown, db: Pool): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const safeMessage = message.slice(0, 200);

    logger.error(
      '[pipelineQueue] error book_id=%d attempt=%d:',
      job.book_id,
      job.attempts,
      safeMessage
    );

    if (job.attempts >= MAX_RETRIES) {
      await db.query(
        `UPDATE book_pipeline_jobs SET status = 'failed', last_error = $2 WHERE id = $1`,
        [job.id, safeMessage]
      );
      sendSlackAlert({
        ruleId: 'pipeline_job_failed',
        name: 'PipelineJob 全リトライ失敗',
        level: 'CRITICAL',
        status: 'FIRING',
        details: `book_id=${job.book_id} attempts=${job.attempts}: ${safeMessage}`,
      }).catch(() => {});
    } else {
      // 指数バックオフ: 1分 → 2分 → 4分
      const backoffSeconds = Math.pow(2, job.attempts - 1) * 60;
      await db.query(
        `UPDATE book_pipeline_jobs
         SET status = 'enqueued', last_error = $2,
             enqueued_at = NOW() + ($3 * INTERVAL '1 second')
         WHERE id = $1`,
        [job.id, safeMessage, backoffSeconds]
      );
    }
  }
}

export const pipelineQueue = new PipelineQueue();
