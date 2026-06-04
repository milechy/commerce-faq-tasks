# pipelineQueue 永続化設計: in-memory → DB-backed queue

> Asana GID: 1215190233020663
> 対象フェーズ: Phase47 Stream C 後続
> 優先度: P2（PM2 再起動時の stuck job 撲滅）

---

## 1. 根本原因

`src/lib/book-pipeline/pipelineQueue.ts` は Node.js プロセスメモリ上に配列を持つ純粋な in-memory キューである。

```
class PipelineQueue {
  private queue: Array<{ bookId: number; deps: PipelineDeps }> = [];
  private running = false;
  ...
}
```

PM2 による再起動（クラッシュ・デプロイ・OOM）が発生すると:

| タイミング | queue の状態 | 影響 |
|---|---|---|
| ジョブが `queue` に積まれているが `processNext` 未着手 | 配列が消滅 | ジョブは実行されず、`book_uploads.status` は `uploaded` のまま永遠に放置される |
| `processNext` が実行中（`status = 'processing'`）| プロセス強制終了 | `book_uploads.status` が `processing` のまま固まる（stuck job） |

具体的な stuck 条件（`pipeline.ts` の status 遷移より）:

```
uploaded → [enqueue] → processing → chunked → embedded
                                          ↑ ここで PM2 再起動 → processing のまま永続
```

stuck job は Admin UI に「処理中」と表示され続け、再実行不可。手動 SQL (`UPDATE book_uploads SET status='uploaded' WHERE id=?`) で修復するまで放置される。

---

## 2. 現状のステータス遷移

```
uploaded     — アップロード完了、キュー投入前 or キュー待ち
processing   — pipeline.ts 実行中 (stuck の温床)
chunked      — PDF 分割完了
embedded     — embedding 完了 (終端)
error        — エラー終端 (error_message に記録)
```

`uploaded` と `processing` が「復旧対象ステータス」である。

---

## 3. 解決方針

### Option A（推奨・最小変更）: 起動時リカバリ + status ベースの永続化

既存の `book_uploads.status` を single source of truth として扱い、新規テーブル不要で永続化を実現する。

#### 実装骨子

**① 起動時リカバリ（`src/lib/book-pipeline/pipelineQueue.ts`）**

```typescript
// アプリ起動時 (src/index.ts) に呼び出す
export async function recoverStalledJobs(db: Pool): Promise<void> {
  // 1. processing のまま止まっているジョブをリセット
  await db.query(
    `UPDATE book_uploads SET status = 'uploaded', error_message = 'recovered: PM2 restart'
     WHERE status = 'processing'`
  );

  // 2. uploaded 状態のジョブをキューに再投入
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM book_uploads WHERE status = 'uploaded' ORDER BY created_at ASC`
  );
  for (const row of rows) {
    await pipelineQueue.enqueue(row.id, { db });
  }
}
```

**② `enqueue` の冪等性確保**

同一 `bookId` が重複投入されないよう `Set<number>` で pending 管理する。

```typescript
class PipelineQueue {
  private queue: Array<{ bookId: number; deps: PipelineDeps }> = [];
  private pending: Set<number> = new Set();   // 追加
  private running = false;

  async enqueue(bookId: number, deps: PipelineDeps): Promise<void> {
    if (this.pending.has(bookId)) return;      // 重複スキップ
    this.pending.add(bookId);
    this.queue.push({ bookId, deps });
    if (!this.running) void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) { this.running = false; return; }
    this.running = true;
    const job = this.queue.shift()!;
    this.pending.delete(job.bookId);           // 開始時に pending から除去
    try {
      await runBookPipeline(job.bookId, job.deps);
    } catch (err) {
      logger.error("[pipelineQueue] error book_id=%d:", job.bookId,
        err instanceof Error ? err.message : String(err));
    }
    void this.processNext();
  }
}
```

**③ `src/index.ts` への組み込み**

```typescript
// Express app 起動後、PM2 ready シグナル前に実行
import { recoverStalledJobs } from './lib/book-pipeline/pipelineQueue';
await recoverStalledJobs(db);  // 数行で済む
```

#### メリット / デメリット

| | 内容 |
|---|---|
| ✅ メリット | マイグレーション不要（既存テーブル・カラムのみ使用）|
| ✅ メリット | コード変更量が最小（~50行）|
| ✅ メリット | stuck job が目視で確認できる（`SELECT status, COUNT(*) FROM book_uploads GROUP BY status`）|
| ⚠️ デメリット | 水平スケール（複数プロセス）では advisory lock なしに競合が起きる可能性 |
| ⚠️ デメリット | キューの retry 回数・遅延などの細かい制御が難しい |

現状はシングルプロセス（PM2 `instances: 1`）のため Option A で十分。

---

### Option B（将来拡張）: `pipeline_jobs` テーブルによる本格 DB キュー

複数インスタンスや retry/backoff が必要になった場合のための設計。

#### スキーマ案

```sql
CREATE TABLE pipeline_jobs (
  id           BIGSERIAL PRIMARY KEY,
  book_id      BIGINT      NOT NULL REFERENCES book_uploads(id),
  tenant_id    TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'queued',
  -- queued / running / done / failed
  attempts     INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 3,
  claimed_at   TIMESTAMPTZ,
  claimed_by   TEXT,           -- worker ID（将来の複数プロセス対応）
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON pipeline_jobs (status, created_at);
CREATE INDEX ON pipeline_jobs (book_id);
```

#### SELECT FOR UPDATE SKIP LOCKED による advisory locking

```sql
-- キューから次のジョブを取得（競合なし・アトミック）
UPDATE pipeline_jobs
SET status = 'running', claimed_at = NOW(), claimed_by = $worker_id, attempts = attempts + 1
WHERE id = (
  SELECT id FROM pipeline_jobs
  WHERE status = 'queued'
    AND attempts < max_attempts
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

このアプローチは PostgreSQL 9.5+ で動作し、複数 worker の競合を完全回避できる。

---

## 4. 実装優先順位

| Phase | 作業 | 担当 | 状態 |
|---|---|---|---|
| P2 | Option A 実装（起動時リカバリ + 冪等 enqueue）| Lane | 未着手 |
| P2 | `recoverStalledJobs` の統合テスト追加 | Lane | 未着手 |
| 将来 | Option B（`pipeline_jobs` テーブル + SKIP LOCKED）| Tier A Lane | 未着手 |

---

## 5. テスト設計（Option A）

```typescript
describe("recoverStalledJobs", () => {
  test("processing 状態のジョブを uploaded にリセットし enqueue する");
  test("uploaded 状態のジョブを enqueue する");
  test("embedded / error 状態のジョブには触れない");
  test("同一 bookId の重複 enqueue がスキップされる");
});
```

---

## 6. 監視クエリ（運用参照用）

```sql
-- stuck job 確認
SELECT id, title, status, updated_at
FROM book_uploads
WHERE status IN ('processing', 'uploaded')
ORDER BY updated_at;

-- ステータス分布
SELECT status, COUNT(*)
FROM book_uploads
GROUP BY status
ORDER BY status;
```

---

## 7. 変更ファイル一覧（Option A 実装時）

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/lib/book-pipeline/pipelineQueue.ts` | 改修 | `pending: Set<number>` 追加、`recoverStalledJobs()` 追加 |
| `src/lib/book-pipeline/pipelineQueue.test.ts` | 改修 | リカバリ・冪等テスト追加 |
| `src/index.ts` | 改修 | 起動時 `recoverStalledJobs(db)` 呼び出し |
| DBマイグレーション | **不要** | 既存カラムのみ使用 |
