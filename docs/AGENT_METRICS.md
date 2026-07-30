# AGENT_METRICS — 管理AIエージェントの挙動メトリクス命名契約

`/copilot-preview`（チャットファーストの管理UI）とそのバックエンド
`src/api/admin/agent/` の**エージェント自身の挙動**を計測するためのメトリクス定義。

計測の目的は「将来のチャットUIに関する製品判断を数値で行えるようにする」こと。
たとえば「旧UIへの案内（handoff）がどれくらい起きているか」が分かれば、
旧ダッシュボードのページを畳めるかどうかを勘ではなく数字で判断できる。

**このドキュメントは命名契約である。** 実装（`src/lib/metrics/agentMetrics.ts` /
`src/api/admin/agent/agentRoutes.ts`）とダッシュボード/分析クエリの双方が
ここに書かれた `metric_name` / `labels` / `value` の意味に依存する。
値を増やす・意味を変える場合は必ずこのファイルを先に更新する。

## 保存先

既存の汎用シンクテーブル `metrics_snapshots`（`src/migrations/phase72d_metrics_snapshots.sql`、
本番適用済み）をそのまま再利用する。**このメトリクスのために新しいテーブルやマイグレーションは作らない。**

```sql
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id          BIGSERIAL    PRIMARY KEY,
  metric_name TEXT         NOT NULL,
  tenant_id   TEXT,
  labels      JSONB        NOT NULL DEFAULT '{}',
  value       NUMERIC      NOT NULL,
  snapshot_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

- `tenant_id`: リクエストの `effectiveTenantId`。テナント未特定の super_admin
  （`targetTenantId` 未指定でプレビュー対象がない状態）では `NULL`。
- `labels`: 下表のキーのみ。**PII を入れない**（ユーザーの自由入力文、FAQ本文、
  顧客名、セッション本文などは一切ラベルに含めない）。入るのは下表で定義した
  enum 値と、ツール名のような固定語彙だけ。
- `snapshot_at`: DB 既定値（`NOW()`）に任せる。

## メトリクス一覧（この5つのみ）

| metric_name | labels | value | 発火タイミング |
| --- | --- | --- | --- |
| `agent_tool_invoked` | `{ tool: string, outcome: "ok" \| "blocked" \| "error" }` | 常に `1`（イベント件数） | ツール呼び出しの結果が `actions` に積まれるたび（1ツール呼び出し=1行） |
| `agent_write_blocked` | `{ tool: string, reason: "unconfirmed" \| "chain" }` | 常に `1` | 書き込み系ツールが確認ゲートでブロックされたとき（`agent_tool_invoked` の `outcome="blocked"` と同時に発火する） |
| `agent_turn_hops` | `{ hit_limit: boolean }` | そのターンで実際に消費したツール呼び出しホップ数（`0` 以上） | ターン完了時（1ターン1行） |
| `agent_legacy_handoff` | `{ feature: string }` | 常に `1` | `get_legacy_ui_link` が呼ばれたとき。「チャットがまだ旧UIへ何回受け渡しているか」の**分子** |
| `agent_turn_completed` | `{ answered_from: string }` | 常に `1` | 結果に関わらずターンが完了したとき。handoff率の**分母** |

### `agent_tool_invoked`

- `tool`: ツール名（`ADMIN_AGENT_TOOLS` の `name`。例 `get_faq_list`, `save_faq`）。
- `outcome`:
  - `ok` — ツールが結果文字列を返した（＝ブロックされなかった）
  - `blocked` — 確認ゲートでブロックされた（下記「ブロック判定」参照）
  - `error` — ツール実行が例外を投げた（`actionExecutor` の各 case は基本的に
    内部で catch して文字列を返すため通常は発生しない。ここに数字が出るのは
    実行系そのものの異常を意味する）
- 1ツール呼び出しにつき必ず1行。同一ターンで複数ツールが呼ばれれば複数行になる。

**ブロック判定**は結果文字列の部分一致で行う（フロントエンドの
`admin-ui/src/pages/copilot-preview/index.tsx` が確認待ちUIの出し分けに使っているのと
同じ規約）。

| 部分文字列 | outcome | reason |
| --- | --- | --- |
| `確認が必要です` | `blocked` | `unconfirmed` |
| `確認をスキップできません` | `blocked` | `chain` |
| 上記以外 | `ok` | — |

`unconfirmed` の判定にフロントと同じ `確認が必要` ではなく **`確認が必要です`** を使う点に注意。
`get_embed_code` の**成功**メッセージが「再確認が必要な場合は新しいキーを発行してください」を
含むため、`確認が必要` だと正常応答をブロックとして数えてしまう。実際のブロック文言
（`actionExecutor.ts` の各確認ゲート、および `agentRoutes.ts` の同一ターン連鎖ブロック）は
すべて「〜には確認が必要です」の形なので、`です` まで含めれば誤検出しない。

### `agent_write_blocked`

`outcome="blocked"` の内訳を単独で引けるようにするための派生メトリクス。
`reason` の意味:

- `unconfirmed` — `confirmed=true` が付いていない書き込み（`actionExecutor` の確認ゲート）
- `chain` — 同一ターン内で `suggest_* → save_*` を連鎖実行しようとした
  （`agentRoutes.ts` の `SUGGEST_TO_SAVE_TOOL` ガード。人間の確認を経ない書き込みを防ぐ）

### `agent_turn_hops`

- `value` = そのターンで「ツール呼び出しを含む Groq 呼び出し」が実際に走った回数。
  ツールを一度も使わなかったターンは `0`。
- `hit_limit` = `MAX_TOOL_HOPS` に達しても収束せず、tools 無しの強制まとめ呼び出しに
  落ちたかどうか。`true` が増えているならモデルが1ターンで解決しきれていない兆候。
- ストリーミング（SSE）経路・非ストリーミング（JSON）経路の両方で発火する。

### `agent_legacy_handoff`

- `feature`: `get_legacy_ui_link` に渡された `feature` 引数。想定値は
  `billing` / `avatar_studio` / `escalation_reply` / `session_deletion` /
  `analytics` / `conversion` / `chat_test` / `avatar_wizard` / `knowledge_pdf`。
  モデルが未定義の値を渡した場合はラベルの語彙を有界に保つため `unknown` に丸める。
- `agent_tool_invoked{tool="get_legacy_ui_link"}` とは**重複して**発火する
  （前者はツール実行の記録、こちらは製品指標としての handoff 記録）。

### `agent_turn_completed`

- `answered_from`: レスポンスで返している `answered_from` と同じ値
  （`faq_list` / `tool_action` / `general`）。
- ツールを使ったか・ブロックされたかに関わらず、ターンが完了すれば必ず1行。
  handoff 率は `count(agent_legacy_handoff) / count(agent_turn_completed)` で出す。
- 500エラーや SSE の `event: error` で終わったターンは「完了」ではないので発火しない。

## 実装上の制約

- 記録は **fire-and-forget**。`recordAgentMetric` は内部で try/catch し、失敗は
  `logger.warn` に落とすだけで例外を投げない。呼び出し側も戻り値を待たない。
  **計測の失敗がチャット応答のステータスコードや本文を変えてはならない。**
- 計測は `agentRoutes.ts` にのみ実装する。`actionExecutor.ts` の 45 個の `case`
  分岐には手を入れない（1箇所で横断的に取れる形を保つ）。
