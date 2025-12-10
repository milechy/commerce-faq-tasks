# Phase15 Summary — SalesFlow Control & KPI

Phase15 では、英会話テナント向けの SalesFlow（Clarify → Propose → Recommend → Close → Ended）を対象に、

- Intent 検出の外部化（YAML）
- ステージ制御の state machine 化
- テンプレ選択と fallback の整理
- SalesLogWriter によるログ基盤
- Template fallback / KPI レポート CLI

を一貫した形で整備した。

---

## 1. スコープとゴール

### スコープ

- SalesFlow（Clarify / Propose / Recommend / Close / Ended）
- 英会話テナント向けの intent taxonomy
- Notion TuningTemplates + SalesLogs との連携
- ローカル / 本番ログを前提にした改善サイクル

### ゴール（Phase15）

- SalesFlow 全体の **ステージ遷移・テンプレソース・KPI** を一貫して観測できること
- fallback 多発箇所（intent / persona 単位）を定量的に把握できること
- Notion テンプレ追加 → fallback 率低下 → KPI 改善のフィードバックループが回る構造を作ること

---

## 2. Intent Rules（YAML 外部化）

### 実装ファイル

- ルール定義: `config/salesIntentRules.yaml`
- 実装: `src/agent/orchestrator/sales/salesIntentDetector.ts`
- テスト: `src/agent/orchestrator/sales/salesIntentDetector.test.ts`
- 設計ドキュメント: `docs/INTENT_DETECTION_RULES.md`

### ポイント

- SalesFlow 用の intent（propose / recommend / close）を YAML で定義
- detector は以下を行う:
  - YAML を読み込み、rule ごとにマッチング（キーワードなど）
  - `proposeIntent / recommendIntent / closeIntent` を返す
  - `detectionText` に「ユーザーメッセージ + 直近履歴」を連結して格納
- YAML 読み込みに失敗した場合は `detectSalesIntentsLegacy` に自動フォールバック
- Jest テストで YAML ルール / legacy fallback / detectionText をカバー

---

## 3. SalesStage Machine / Orchestrator 統合

### 実装ファイル

- ステージ制御: `src/agent/orchestrator/sales/salesStageMachine.ts`
- オーケストレータ: `src/agent/orchestrator/sales/salesOrchestrator.ts`
- テスト:
  - `src/agent/orchestrator/sales/salesStageMachine.test.ts`
  - `src/agent/orchestrator/sales/salesOrchestrator.test.ts`
- 設計ドキュメント:
  - `docs/SALESFLOW_DESIGN.md`
  - `docs/SALESFLOW_RUNTIME.md`

### ステージモデル

- `SalesStage`: `clarify | propose | recommend | close | ended`
- `SalesStageTransition`:
  - `prevStage`
  - `nextStage`
  - `reason`（`initial_clarify / auto_progress_by_intent / stay_in_stage / manual_override`）

### 動作

- `getInitialSalesStage()` で初回ステージを `clarify / initial_clarify` に決定
- `computeNextSalesStage()` が以下を基準に遷移を決定:
  - manualNextStage（ユーザー指定）があれば最優先
  - clarify / propose / recommend では intent の有無で自動進行
  - close / ended は原則ステージ維持
- `salesOrchestrator` は `computeNextSalesStage()` の結果を受けて：
  - `nextStage` に応じたテンプレ builder を呼び出す
  - meta（prevStage / nextStage / reason）を返す

---

## 4. Template Selection & Fallback（Notion / fallback）

### 実装ファイル

- テンプレ取得 / fallback:
  - `src/agent/orchestrator/sales/salesRules.ts`（`getSalesTemplate`）
- Notion Provider:
  - `src/agent/orchestrator/sales/rulesLoader.ts`
  - Phase13 で導入済みの SalesTemplateProvider / TuningTemplates を利用
- テスト:
  - `src/agent/orchestrator/sales/salesRules.test.ts`

### getSalesTemplate の挙動

1. SalesRulesProvider（Notion → メモリ）から intent + personaTags に応じたテンプレを取得
2. 見つかった場合:
   - `templateSource = "notion"`
   - Notion テンプレの text / id を採用
3. 見つからない場合:
   - `templateSource = "fallback"`
   - phase / personaTags（特に `beginner`）に応じたハードコードテンプレを返す

### TemplateMatrix / TemplateGaps との関係

- TemplateMatrix:
  - 軸: `phase × intent × personaTag`
  - 各セルに「Notion テンプレ有無（hasTemplate）」を記録
- TemplateGaps:
  - Matrix 上で `hasTemplate = false` かつ fallback 利用が多いセルをギャップとして扱う
  - Phase15 では、CLI レポートと SalesLogs を組み合わせて「どこのセルを優先改善すべきか」を可視化する基盤を整備

---

## 5. SalesLogWriter と Sales Log Spec（Phase15）

### 仕様ドキュメント

- `docs/SALES_LOG_SPEC.md`

### 実装イメージ

- クラス/モジュール: `SalesLogWriter`（Notion / Postgres adapter を吸収）
- 呼び出しインターフェイス例:

```ts
writeSalesLog({
  tenantId,
  sessionId,
  phase,
  prevStage,
  nextStage,
  stageTransitionReason,
  intent,
  personaTags,
  userMessage,
  templateSource, // notion / fallback
  templateId,
  templateText,
  promptPreview,
});
```
