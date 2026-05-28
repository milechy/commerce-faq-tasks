-- Phase70K: book_pipeline_jobs テーブル作成
-- pipelineQueue 永続化 — PM2再起動による stuck job 撲滅
-- 根拠: in-memory キューはPM2 restart / crash でジョブが消失し
--       book_uploads.status='uploaded' が永久停滞する（Phase53調査）

-- ============================================================
-- 1. book_pipeline_jobs テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS book_pipeline_jobs (
  id           SERIAL         PRIMARY KEY,

  -- 対応する書籍（外部キー）
  book_id      INTEGER        NOT NULL REFERENCES book_uploads(id),

  -- キュー状態
  -- enqueued: 処理待ち / running: 実行中 / done: 完了 / failed: リトライ上限到達
  status       VARCHAR(20)    NOT NULL DEFAULT 'enqueued'
                 CONSTRAINT book_pipeline_jobs_status_check
                 CHECK (status IN ('enqueued', 'running', 'done', 'failed')),

  -- リトライ管理
  attempts     INTEGER        NOT NULL DEFAULT 0,
  last_error   TEXT,

  -- タイムスタンプ
  enqueued_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ
);

COMMENT ON TABLE book_pipeline_jobs IS 'Phase70K: DB-backed pipeline queue。PM2再起動でジョブを消失させない。';
COMMENT ON COLUMN book_pipeline_jobs.status IS 'enqueued→running→done / failed。attempts>=3 で failed。';
COMMENT ON COLUMN book_pipeline_jobs.attempts IS 'SELECT FOR UPDATE SKIP LOCKED でクレーム時にインクリメント。';
COMMENT ON COLUMN book_pipeline_jobs.enqueued_at IS '指数バックオフ再試行時は NOW()+backoff に更新される。';

-- ============================================================
-- 2. インデックス
-- ============================================================

-- processNext() の SELECT FOR UPDATE SKIP LOCKED で使用
CREATE INDEX IF NOT EXISTS idx_book_pipeline_jobs_enqueued
  ON book_pipeline_jobs (enqueued_at)
  WHERE status = 'enqueued';

-- checkStuckJobs() の running 1h超 監視で使用
CREATE INDEX IF NOT EXISTS idx_book_pipeline_jobs_running
  ON book_pipeline_jobs (started_at)
  WHERE status = 'running';
