// src/lib/book-pipeline/pipelineQueue.ts
// Phase47 Stream C: in-memory パイプラインキュー（外部依存なし）
// 同時実行を1に制限し、複数PDFアップロード時のレート制限・メモリ問題を防ぐ

import { runBookPipeline } from "./pipeline";
import type { PipelineDeps } from "./pipeline";

class PipelineQueue {
  private queue: Array<{ bookId: number; deps: PipelineDeps }> = [];
  private running = false;
  private readonly concurrency = 1; // 同時実行1

  async enqueue(bookId: number, deps: PipelineDeps): Promise<void> {
    this.queue.push({ bookId, deps });
    if (!this.running) {
      void this.processNext();
    }
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.running = false;
      return;
    }
    this.running = true;
    const job = this.queue.shift()!;
    try {
      await runBookPipeline(job.bookId, job.deps);
    } catch (err) {
      console.error(
        "[pipelineQueue] error book_id=%d:",
        job.bookId,
        err instanceof Error ? err.message : String(err)
      );
    }
    void this.processNext();
  }

  /** テスト用: キューの状態を確認 */
  get queueLength(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export const pipelineQueue = new PipelineQueue();
