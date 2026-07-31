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

## 全メトリクス共通のラベル: `surface`

チャットターン由来の**5つのメトリクス**
（`agent_tool_invoked` / `agent_write_blocked` / `agent_turn_hops` /
`agent_legacy_handoff` / `agent_turn_completed`）は、下表の固有ラベルに加えて
**必ず `surface` を持つ**。

| `surface` | 意味 |
| --- | --- |
| `panel` | 旧UIに埋め込まれたチャットパネル（`admin-ui/src/components/AdminAgent/`） |
| `fullscreen` | 全画面のチャットUI（`admin-ui/src/pages/copilot-preview/`） |
| `unknown` | `POST /v1/admin/agent/chat` のリクエストが `surface` を送ってこなかった |

`surface` はリクエストボディの**任意項目**（`chatSchema` の
`z.enum(['panel','fullscreen']).optional()`）。両面のフロントは共有 transport 層
（`admin-ui/src/lib/useAgentChatTransport.ts`）が自面の値を必ず載せるため、
実運用で `unknown` に落ちるのは API を直接叩く経路だけである。
なお `panel` / `fullscreen` 以外のリテラルを送った場合は `unknown` に丸めず、
他のフィールドと同様に **400 `invalid_request`** で弾く（ラベルの語彙をサーバ側で閉じる）。

`chat_first_toggle` は例外で `surface` を持たない。これはチャットターンではなく
`POST /v1/admin/agent/ui-event` 経由のUI操作で、トグルの実体が全画面UIの左レールにしか
存在しないため、面を記録しても常に同じ値になり情報量がない。

### 過去データ: `surface` が「無い」行と `"unknown"` の行は別物

**この変更より前に記録された行には `surface` キー自体が存在しない**（`"unknown"` ですらない）。
`metrics_snapshots` を横断して集計するクエリはこれを区別しなければならない。

```sql
-- labels->>'surface' は3値ではなく4状態を取る
--   'panel' / 'fullscreen' / 'unknown' / NULL(キーが無い = この変更以前の行)
SELECT COALESCE(labels->>'surface', 'pre_surface_label') AS surface, COUNT(*)
FROM metrics_snapshots
WHERE metric_name = 'agent_turn_completed'
GROUP BY 1;
```

- `labels->>'surface' = 'unknown'` は「この変更以後に、面を名乗らないクライアントから来た」行。
- `labels->>'surface' IS NULL` は「この変更以前の行」。面ごとの比率を出す分母に混ぜると
  全画面UI側を過小に見せるため、面別の集計では期間を切るか NULL を明示的に除外する。
- 既存行の遡及埋め（バックフィル）は行わない。当時の面は記録されておらず復元できないため、
  `"unknown"` を後付けすると「送ってこなかった」という別の意味と衝突する。

## メトリクス一覧（この7つのみ）

| metric_name | labels | value | 発火タイミング |
| --- | --- | --- | --- |
| `agent_tool_invoked` | `{ tool: string, outcome: "ok" \| "blocked" \| "error" }` | 常に `1`（イベント件数） | ツール呼び出しの結果が `actions` に積まれるたび（1ツール呼び出し=1行） |
| `agent_write_blocked` | `{ tool: string, reason: "unconfirmed" \| "chain" }` | 常に `1` | 書き込み系ツールが確認ゲートでブロックされたとき（`agent_tool_invoked` の `outcome="blocked"` と同時に発火する） |
| `agent_turn_hops` | `{ hit_limit: boolean }` | そのターンで実際に消費したツール呼び出しホップ数（`0` 以上） | ターン完了時（1ターン1行） |
| `agent_legacy_handoff` | `{ feature: string }` | 常に `1` | `get_legacy_ui_link` が呼ばれたとき。「チャットがまだ旧UIへ何回受け渡しているか」の**分子** |
| `agent_turn_completed` | `{ answered_from: string }` | 常に `1` | 結果に関わらずターンが完了したとき。handoff率の**分母** |
| `chat_first_toggle` | `{ enabled: boolean }` | 常に `1` | 「これを既定の画面にする」トグルが切り替わったとき（`POST /v1/admin/agent/ui-event`） |
| `onboarding_stage_reached` | `{ stage: "industry_answered" \| "knowledge_published" \| "widget_installed" \| "first_conversation", actor: "self" \| "delegated" }` | 常に `1` | 該当段階に対応するツール呼び出しが成功するたび（下記「発火回数について」参照） |

上表の `labels` は各メトリクス**固有**のキーのみを示す。`chat_first_toggle` と
`onboarding_stage_reached` を除く5つは、これに加えて共通ラベル `surface` を持つ（前節）。

### `onboarding_stage_reached`

- `stage`:
  - `industry_answered` — 業種ヒアリングに回答した（`import_industry_faq_templates` 確定実行）
  - `knowledge_published` — テナントの `faq_docs` に `is_published = true` が1件以上できた
  - `widget_installed` — ウィジェットの読み込みを検知した（`docs/ONBOARDING_FIRST_LOGIN.md` 決定2）
  - `first_conversation` — `chat_sessions` に実会話（`metadata->>'source' = 'user'`）が1件以上できた
- `actor`: `self`（テナント本人）/ `delegated`（super_admin のクライアントビュー経由）。
  `widget_installed` / `first_conversation` はテナントの操作の外側で起きるため常に `self`。
- `industry_answered` / `knowledge_published` は `POST /v1/admin/agent/chat` のターン内で起きるため
  共通ラベル `surface` も持つ。`widget_installed`（`/api/widget/features`）と
  `first_conversation`（`/api/chat` 経由のエンドユーザー会話）はチャットターンの外側のイベントのため
  `surface` を持たない。

**発火回数について:** 他の5メトリクス（`agent_legacy_handoff` 等）と同じく、対応するツール呼び出しが
成功するたびに発火する（重複排除の仕組みは持たない）。「テナントがその段階に**初めて**到達した日時」
が必要な集計は、クエリ側で `tenant_id` ごとに `MIN(created_at)` を取ることで得られる
（`metrics_snapshots` は追記専用のイベントログであり、状態の source of truth ではないため）。
`actionExecutor.ts` の各 `case` には手を入れない制約（本ドキュメント冒頭）があるため、
「初回のみDBに書き込む」形の重複排除（`onboarding_widget_seen_at` で採用した
`UPDATE ... WHERE ... IS NULL` パターン）はここでは使えない。

**実装状況（2026-07-31時点）:**
- `industry_answered` / `knowledge_published`: `agentRoutes.ts` で実装済み（Asana 1217040702485762）。
- `widget_installed` / `first_conversation`: **未実装**。`widget_installed` の検知自体は
  `recordWidgetSeenOnce`（`src/lib/onboardingWidgetSeen.ts`、Asana 1217040715801275）で行っているが、
  メトリクス発火はまだ追加していない。`first_conversation` はエンドユーザー向けチャット
  （`src/api/chat/route.ts` 等、管理エージェントとは別系統かつ高頻度経路）に触れる必要があり、
  本タスク群のスコープ外として意図的に残している。

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
- ラベルは `hit_limit` のみ。`tool` もターン/セッションIDも**意図的に持たせていない**ため、
  ホップ数をページや個別ツールに帰属させることはできない。この指標は全体のveto
  （エージェント全体が1ターンで解決できているか）専用で、機能単位の労力は別指標で見る。
  行数とプライバシーのコストに見合わないので、消費側の要望があっても安易に追加しない。

### `agent_legacy_handoff`

- `feature`: `get_legacy_ui_link` に渡された `feature` 引数。想定値は
  `billing` / `avatar_studio` / `escalation_reply` / `session_deletion` /
  `analytics` / `conversion` / `chat_test` / `avatar_wizard` / `knowledge_pdf`。
  モデルが未定義の値を渡した場合はラベルの語彙を有界に保つため `unknown` に丸める。
  この語彙は `toolDefinitions.ts` の `LEGACY_UI_FEATURES`（`get_legacy_ui_link` の
  feature enum の実体）を import して導出しており、計測側に写しを持たない。
  したがって enum から値を削除すれば、その feature は自動的に `unknown` へ丸まる。
- `agent_tool_invoked{tool="get_legacy_ui_link"}` とは**重複して**発火する
  （前者はツール実行の記録、こちらは製品指標としての handoff 記録）。

#### `feature="unknown"` は捨てバケツではなく調査シグナル

`unknown` に落ちる行は「異常値をまとめて捨てる先」ではない。**恒常的に集計し、
ゼロでなければ理由を突き止めるべき signal** として扱う。`unknown` が出る経路は2つあり、
どちらも情報を持っている。

1. **enum に無い feature をモデルが渡した** — チャットから案内したい機能があるのに
   案内先のキーが存在しない、という兆候。実例として、テナントに見えているのに
   対応ツールも handoff キューも無い機能が `unknown` の調査から見つかっている
   （`agent_tool_invoked` と `agent_legacy_handoff` の両方から不可視だった）。
   次の取りこぼしを検出する手段がこのカウントである。
2. **旧UIページの閉鎖に伴い `toolDefinitions.ts` の feature enum から値が削除された** —
   閉鎖済みページ宛の残存 handoff は消えるのではなく `unknown` に着地する。
   `docs/LEGACY_UI_SUNSET.md` はこれを閉鎖後のトリップワイヤーとして使う。

つまり `unknown` は時間が経つほど「純粋なエラーバケツ」ではなくなる。
**この行を「ノイズだから」と落とす形での“修正”をしてはならない**（閉鎖済みページへの
残存アクセスを観測する唯一の経路が消える）。増加時は上記1と2のどちらなのかを切り分ける。

### `agent_turn_completed`

- `answered_from`: レスポンスで返している `answered_from` と同じ値
  （`faq_list` / `tool_action` / `general`）。
- ツールを使ったか・ブロックされたかに関わらず、ターンが完了すれば必ず1行。
  handoff 率は `count(agent_legacy_handoff) / count(agent_turn_completed)` で出す。
- 500エラーや SSE の `event: error` で終わったターンは「完了」ではないので発火しない
  （分母は「完了したターン」だけ）。
- 行にターン/セッションIDが無いため、1ターン中に `get_legacy_ui_link` が2回呼ばれれば
  handoff 行も2行になり重複排除できない。したがって上記の比は
  **「完了ターンあたりの handoff 回数」であって「handoff を含んだターンの割合」ではない**
  （原理的に 1.0 を超えうる）。指標名や文書でこの2つを混同しないこと。

### `chat_first_toggle`

唯一の**UI操作**メトリクス（他の5つはエージェント自身の挙動）。
`/copilot-preview` 左レールの「これを既定の画面にする」トグルが切り替わるたびに、
フロント（`admin-ui/src/pages/copilot-preview/index.tsx` の `Phase4DefaultToggle`）が
`POST /v1/admin/agent/ui-event` を投げて記録する。

- `enabled`: 切り替え**後**の状態。`true` = オプトイン、`false` = オプトアウト。
- `tenant_id`: JWT 由来のテナントのみ。**body の値は一切見ない**（このイベントに
  `targetTenantId` 相当の概念はない。テナント未特定の super_admin は `NULL`）。
- 計測目的は「チャットUIを既定のランディングにした人が、1ヶ月後もそのままか」を
  数字で見ること。トグルの実体は依然として localStorage だけであり（`chatFirstDefault.ts`）、
  **このメトリクスは現在の状態の source of truth ではない**。読めるのは
  「いつ ON になり、いつ OFF に戻されたか」のイベント列だけで、
  ラベルにユーザー識別子を持たない（PII 禁止）ため個人単位の継続率は出せない。
  出せるのは期間ごとの `enabled=true` / `enabled=false` の件数と、その比の推移。
- ブラウザ側からの送信なので**必ず取りこぼす**（オフライン、拡張機能によるブロック、
  タブを閉じた直後など）。ON/OFF の絶対数ではなく傾向として読む。

#### `event` は閉じた enum である

`POST /v1/admin/agent/ui-event` が受け付ける `event` は `chat_first_toggle` のみで、
それ以外は 400 を返す。任意の文字列を受けると、この endpoint が命名契約の外にある
無管理の分析投入口になってしまうため。**UIイベントを増やす場合は、このドキュメントと
`agentRoutes.ts` の `uiEventSchema` を同時に更新する**（コード側だけ広げてはならない）。

## 実装上の制約

- 記録は **fire-and-forget**。`recordAgentMetric` は内部で try/catch し、失敗は
  `logger.warn` に落とすだけで例外を投げない。呼び出し側も戻り値を待たない。
  **計測の失敗がチャット応答のステータスコードや本文を変えてはならない。**
- 計測は `agentRoutes.ts` にのみ実装する。`actionExecutor.ts` の 45 個の `case`
  分岐には手を入れない（1箇所で横断的に取れる形を保つ）。
- `POST /v1/admin/agent/ui-event` は計測専用のため、想定外の例外でも 500 ではなく
  `{ ok: true }` を返す（権限 403 とバリデーション 400 のみ明示的に返す）。
  この endpoint の失敗がフロントのトグルの見た目・localStorage の値・
  ユーザーへのエラー表示に影響してはならない。フロント側も応答を待たずに投げる。
