# Sales Log Specification (Phase15)

Sales Log は、Clarify / Propose / Recommend / Close を含む **SalesFlow 全体のメタ情報を一元的に記録する仕組み**である。  
Notion または Postgres（将来拡張）に保存し、会話改善・テンプレ改善・分析用途で活用する。

---

## 1. 目的

- 各フェーズ（Clarify / Propose / Recommend / Close）で **どのテンプレをどのユーザーにどのタイミングで提示したか** を記録する。
- 既存の ClarifyLog（/integrations/notion/clarify-log）を一般化し、**1 つの仕組みで SalesFlow 全体を記録可能**にする。
- SalesPipeline の判断（intent）と実際に提示したテンプレを紐づけて分析可能にする。

---

## 2. 記録タイミング

### Clarify

- Clarify フェーズのテンプレ（質問）をユーザーに提示した直後に記録。

### Propose / Recommend / Close

- `SalesOrchestrator` で `nextStage` が決まり `prompt`（テンプレ）が生成されたタイミングで記録。
- 記録は **dialogAgent の回答確定時**に行うことが望ましい（回答＝テンプレが確定するため）。

---

## 3. データモデル（Notion / DB 共通）

| Field                   | Type     | Description                                                                                     |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `tenantId`              | string   | どのテナントの会話か                                                                            |
| `sessionId`             | string   | 会話セッション ID                                                                               |
| `phase`                 | enum     | clarify / propose / recommend / close                                                           |
| `prevStage`             | enum     | 遷移前の SalesStage（clarify / propose / recommend / close / ended）                            |
| `nextStage`             | enum     | 遷移後の SalesStage（clarify / propose / recommend / close / ended）                            |
| `stageTransitionReason` | enum     | ステージ遷移理由（initial_clarify / auto_progress_by_intent / stay_in_stage / manual_override） |
| `intent`                | string   | intent taxonomy の slug（例: trial_lesson_offer）                                               |
| `personaTags`           | string[] | テンプレ選択に使用された persona（例: ["beginner"]）                                            |
| `userMessage`           | string   | そのターンのユーザー発話全文                                                                    |
| `templateSource`        | enum     | notion / fallback                                                                               |
| `templateId`            | string?  | Notion テンプレのページ ID（fallback の場合 null）                                              |
| `templateText`          | string   | 実際にユーザーへ提示したテンプレ全文                                                            |
| `promptPreview`         | string   | 上記テンプレの先頭 120 字程度（Notion のリスト表示向け）                                        |
| `timestamp`             | datetime | 記録時刻                                                                                        |

---

## 4. intent の扱い

intent には必ず taxonomy で定義した slug を利用する。

- Clarify: level_diagnosis / goal_setting / ...
- Propose: trial_lesson_offer / propose_monthly_plan_basic / ...
- Recommend: recommend_course_based_on_level / ...
- Close: close_after_trial / ...

テンプレは intent と personaTags をキーにして Notion から選択され、fallback は builder 側で生成される。

---

## 5. templateSource の判定

### notion

Notion の TuningTemplates DB で intent + personaTags でマッチし、テンプレが取得できた場合。

### fallback

Notion 上で適切なテンプレが見つからず、builder（proposePromptBuilder など）側のハードコード文面を使用した場合。

---

## 6. 保存先の方針

### Phase15 時点：Notion

- `TuningTemplates` と同様に、`SalesLogs` 用の Notion DB を用意して保存する。
- 既存の ClarifyLog API と統合する場合は `/integrations/notion/sales-log` を用意する。

### 将来：Postgres

- 高トラフィックの顧客向けには DB 保存を実装予定。
- schema 例（Postgres）
  ```sql
  CREATE TABLE sales_logs (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT,
    session_id TEXT,
    phase TEXT,
    prev_stage TEXT,
    next_stage TEXT,
    stage_transition_reason TEXT,
    intent TEXT,
    persona_tags JSONB,
    user_message TEXT,
    template_source TEXT,
    template_id TEXT,
    template_text TEXT,
    prompt_preview TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW()
  );
  ```

---

## 7. 書き込みフロー（Runtime 設計）

### dialogAgent

- `runSalesFlowWithLogging`（内部で SalesOrchestrator / SalesStageMachine / SalesLogWriter を呼び出す）の結果で `prevStage` / `nextStage` / `stageTransitionReason` が決まり、`prompt`（テンプレ）が生成されたタイミングで記録。
- 実際には SalesLogWriter がレスポンス確定前後で呼ばれ、テンプレとステージ遷移メタ情報をまとめてログとして書き込む。

### SalesLogWriter（新規）

- Notion と Postgres の両実装を吸収する adapter 的役割。
- 呼び出し API:
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
    templateSource,
    templateId,
    templateText,
  });
  ```

---

## 8. 将来拡張

- `userAction`（返信した／離脱した／プラン選択したなど）を追跡し、行動データとして蓄積する。
- `llmGenerated`（LLM が意図推定や回答生成した場合のメタ情報）を保存するオプションを追加。
- 各 intent のコンバージョン率を計測し、自動最適化に利用する。

---

## 9. 実装順序（推奨）

1. この SPEC の確定
2. Notion に SalesLogs DB を作成
3. `SalesLogWriter` クラスを作成（Notion 版）
4. `dialogAgent` から SalesLogWriter を呼び出す
5. Propose / Recommend / Close のテンプレが出るたびに記録されることを確認
6. ClarifyLogWriter を SalesLogWriter に統合（最終ステップ）

---

**Phase15 の目標：SalesFlow 全体の観測とテンプレ最適化ができる基盤を完成させること（ステージ制御・テンプレソース・KPI レポートまでを一貫させる）。**

---

## 10. Cross-links

- See **SALESFLOW_RUNTIME.md** for runtime execution order.
- See **PERSONA_TAGS_REFERENCE.md** for personaTag usage.
- See **TUNING_TEMPLATES_WORKFLOW.md** for authoring guidelines.
