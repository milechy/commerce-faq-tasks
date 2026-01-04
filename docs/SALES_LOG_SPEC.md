# SalesFlow Runtime (Phase15-16)

Phase15-16 の Runtime では、従来の「その場しのぎの if 文ベース制御」から一歩進めて、(1) YAML ベースの `salesIntentDetector` による intent 検出、(2) `salesStageMachine` による明示的なステージ遷移、(3) Notion テンプレ / fallback のどちらが使われたかを表す `templateSource` ログ、(4) これらを一括で扱う `runSalesFlowWithLogging` ラッパー、(5) SalesLogWriter によるステージ遷移メタ付き SalesLog の出力、(6) `salesContextStore` による Sales セッションメタ（SalesSessionMeta）の保存、という 6 つの要素を追加・統合した。これにより、Runtime は「テンプレ生成」と「ログ / KPI 計測」、および「セッション状態の更新」がセットになった一貫したパイプラインとして動作する。

---

## 1. High-level Architecture

- **multi-step planner** (salesIntentDetector + salesStageMachine)
- **template providers** (Notion TuningTemplates / fallback)
- **salesContextStore** (current SalesStage / SalesSessionMeta)
- **SalesLogWriter** (Notion / Postgres)

---

## 2. Execution Sequence

### Step 1 — User message received

User メッセージを受け取り、必要に応じて sessionId, tenantId を特定する。

### Step 2 — SalesOrchestrator runs

SalesOrchestrator は以下を実行し、次の情報を生成する。

Output (conceptual):

- `{ prevStage, nextStage, stageTransitionReason, intent, template, templateSource, templateId, logPayload }`

- `prevStage`, `nextStage`, `stageTransitionReason` は `salesStageMachine.computeNextSalesStage` の結果。
- `templateSource` は Notion か fallback のどちらか。
- `logPayload` は `SalesLogWriter` に渡す構造化オブジェクト。Phase16 では `SalesLogWriter` が `prevStage` / `nextStage` / `stageTransitionReason` を含む SalesLog レコードを構築し、後続の Sales Analytics（KPI Funnel / Stage Transitions）で利用される。

### Step 3 — Template rendered

テンプレートがユーザー向けに生成される。

### Step 4 — Log emission

Orchestrator prepares:

- phase
- intent
- personaTags
- templateId & templateSource
- userMessage
- prevStage / nextStage / stageTransitionReason

これらを `logPayload` として `SalesLogWriter` に渡し、SalesLog に書き込む。

### Step 5 — dialogAgent finalizes answer

dialogAgent は最終回答を確定し、ユーザーに返す。

### Step 6 — SalesSessionMeta の更新（salesContextStore）

Phase16 では、SalesFlow 実行後に「このセッションはいまどの SalesStage にいるか」を保存するために、`salesContextStore` に `SalesSessionMeta` を書き込む。

- `SalesSessionKey = { tenantId, sessionId }` でセッションを一意に識別する
- `SalesSessionMeta` には少なくとも `currentStage` と `lastUpdatedAt` が含まれる
- `dialogAgent.ts` は `runSalesFlowWithLogging` の結果（`salesResult.nextStage`）を用いて、`updateSalesSessionMeta(key, { currentStage })` を呼び出す

これにより、次ターン以降で「現在の SalesStage」を参照したり、将来的には `lastIntent` / `personaTags` などをセッションメタとして扱う基盤が整う。

---

## 3. Components

- **salesIntentDetector**: YAML ベースの intent 判定
- **salesStageMachine**: 明示的なステージ遷移管理
- **template providers**: Notion / fallback からテンプレ取得
- **salesContextStore**: SalesSessionMeta の保存・取得
- **SalesLogWriter**: Notion / Postgres へのログ書き込み

---

## 4. Data Flow

1. User message → salesIntentDetector で intent 判定
2. salesStageMachine でステージ遷移決定
3. template providers からテンプレ取得
4. SalesLogWriter にログ書き込み
5. salesContextStore に SalesSessionMeta 更新

---

## 5. Logging Details

SalesLog レコードには以下を含む。

- tenantId, sessionId
- phase (clarify / propose / recommend / close)
- prevStage, nextStage, stageTransitionReason
- intent, personaTags
- userMessage
- templateSource (notion / fallback)
- templateId, templateText
- promptPreview
- timestamp

---

## 6. Future Runtime Enhancements

- Intent taxonomy の拡充と自動最適化
- SalesLogWriter の Postgres 対応強化
- SalesSessionMeta（Sales セッション状態）を使った SalesFlow エントリロジックの強化（前回ステージや lastIntent に応じた Clarify / Propose の分岐）
