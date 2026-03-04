# SalesFlow Runtime (Phase15-16)

Phase15-16 の Runtime では、従来の「その場しのぎの if 文ベース制御」から一歩進めて、(1) YAML ベースの `salesIntentDetector` による intent 検出、(2) `salesStageMachine` による明示的なステージ遷移、(3) Notion テンプレ / fallback のどちらが使われたかを表す `templateSource` ログ、(4) これらを一括で扱う `runSalesFlowWithLogging` ラッパー、(5) SalesLogWriter によるステージ遷移メタ付き SalesLog の出力、(6) `salesContextStore` による Sales セッションメタ（SalesSessionMeta）の保存、という 6 つの要素を追加・統合した。これにより、Runtime は「テンプレ生成」と「ログ / KPI 計測」、および「セッション状態の更新」がセットになった一貫したパイプラインとして動作する。

## 1. High-level Architecture

SalesFlow Runtime sits between:

- **multi-step planner** (search, retrieval planning)
- **template providers** (Clarify / Propose / Recommend / Close)
- **salesContextStore** (current SalesStage / SalesSessionMeta)
- **SalesLogWriter**

The orchestrator determines:

1. Current stage (clarify → propose → recommend → close → ended) via a state machine
2. Intent (from YAML rules or explicit selection)
3. Template selection (Notion or fallback)
4. Logging (including stage transition metadata)
5. Final answer output

## 2. Execution Sequence

### Step 1 — dialogAgent receives user input

- Extract sessionId
- Load conversation history
- Estimate context tokens
- Run multi-step planner

### Step 2 — SalesOrchestrator runs

Inputs:

- `plan`
- `history`
- `personaTags`
- detection context (user message, detected intents)
- optional intent override

Output (conceptual):

- `{ prevStage, nextStage, stageTransitionReason, intent, template, templateSource, templateId, logPayload }`

Where:

- `prevStage` / `nextStage` are `SalesStage` values resolved via `salesStageMachine.computeNextSalesStage()`
- `stageTransitionReason` is a label describing _why_ the transition happened (e.g. `initial_clarify`, `auto_progress_by_intent`, `stay_in_stage`, `manual_override`)
- `templateSource` distinguishes Notion templates vs internal fallbacks
- `logPayload` is a structured object passed to `SalesLogWriter`. Phase16 では `SalesLogWriter` が `prevStage` / `nextStage` / `stageTransitionReason` を含む SalesLog レコードを構築し、後続の Sales Analytics（KPI Funnel / Stage Transitions）で利用される。

### Step 3 — Template Provider selection

For the selected stage:

- `ClarifyTemplateProvider`
- `ProposeTemplateProvider`
- `RecommendTemplateProvider`
- `CloseTemplateProvider`

They resolve:

- intent
- personaTags
- Notion template match OR fallback builder

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

- Append to session history
- Return combined result (search steps + salesflow output)

### Step 6 — SalesSessionMeta の更新（salesContextStore）

Phase16 では、SalesFlow 実行後に「このセッションはいまどの SalesStage にいるか」を保存するために、`salesContextStore` に `SalesSessionMeta` を書き込む。

- `SalesSessionKey = { tenantId, sessionId }` でセッションを一意に識別する
- `SalesSessionMeta` には少なくとも `currentStage` と `lastUpdatedAt` が含まれる
- `dialogAgent.ts` は `runSalesFlowWithLogging` の結果（`salesResult.nextStage`）を用いて、`updateSalesSessionMeta(key, { currentStage })` を呼び出す

これにより、次ターン以降で「現在の SalesStage」を参照したり、将来的には `lastIntent` / `personaTags` などをセッションメタとして扱う基盤が整う。

## 3. Stage Transition Rules

Stage transitions are handled by a small state machine in:

`src/agent/orchestrator/sales/salesStageMachine.ts`

The state machine works on the `SalesStage` type:

```ts
type SalesStage = "clarify" | "propose" | "recommend" | "close" | "ended";
```

The orchestrator calls:

```ts
computeNextSalesStage({
  previousStage,
  hasProposeIntent,
  hasRecommendIntent,
  hasCloseIntent,
  manualNextStage,
});
```

and receives:

```ts
type SalesStageTransition = {
  previousStage: SalesStage | null;
  nextStage: SalesStage;
  reason:
    | "initial_clarify"
    | "auto_progress_by_intent"
    | "stay_in_stage"
    | "manual_override";
};
```

High-level rules in Phase15:

### Initial

- If `previousStage` is `null`, the state machine always starts in:
  - `nextStage = 'clarify'`
  - `reason = 'initial_clarify'`

### Clarify

- Input signals:
  - `hasProposeIntent`, `hasRecommendIntent`, `hasCloseIntent` come from intent detection (YAML rules) or overrides.
- Transitions:
  - If **any** of `hasProposeIntent`, `hasRecommendIntent`, `hasCloseIntent` is true:
    - `nextStage = 'propose'`
    - `reason = 'auto_progress_by_intent'`
  - Otherwise:
    - `nextStage = 'clarify'`
    - `reason = 'stay_in_stage'`

### Propose

- Transitions:
  - If `hasCloseIntent` is true:
    - `nextStage = 'close'`
    - `reason = 'auto_progress_by_intent'`
  - Else if `hasRecommendIntent` is true:
    - `nextStage = 'recommend'`
    - `reason = 'auto_progress_by_intent'`
  - Else:
    - `nextStage = 'propose'`
    - `reason = 'stay_in_stage'`

### Recommend

- Transitions:
  - If `hasCloseIntent` is true:
    - `nextStage = 'close'`
    - `reason = 'auto_progress_by_intent'`
  - Else:
    - `nextStage = 'recommend'`
    - `reason = 'stay_in_stage'`

### Close / Ended

- In Phase15, `close` / `ended` simply stay in the same stage by default:
  - `nextStage = previousStage`
  - `reason = 'stay_in_stage'`
- More advanced behaviours (e.g. re-opening a flow, explicit `ended` transition) are left as future enhancements.

### Manual overrides

- If `manualNextStage` is provided, it always takes precedence over the rules above:
  - `nextStage = manualNextStage`
  - `reason = 'manual_override'`

This design keeps the runtime deterministic, while still allowing:

- Small rule tweaks based on intents
- Operator or system-level overrides when needed

## 4. Fallback Behaviour

When Notion templates cannot be found for a given `(phase, intent, personaTags)`:

- `getSalesTemplate` falls back to a stage-specific fallback builder that returns a safe, generic template
- `templateSource` is set to `"fallback"` (otherwise `"notion"` when a Notion template is used)
- SalesLogWriter logs this `templateSource` so that fallback usage can be analyzed later

## 5. Persona Tag Handling

personaTags influence:

- template selection priority (persona-specific templates preferred over generic ones)
- content variants (e.g. more guided explanations for `beginner`)
- stage-specific fallback tone and level of detail
- potential future influence on intent detection and stage rules

## 6. Future Runtime Enhancements

- Richer state-machine rules (e.g. combining multiple intents, tenant-specific policies)
- ML classification for intent feeding into the same state machine
- Conversation memory beyond a single session (longer-term user state)
- Online monitoring dashboards for SalesFlow KPIs and fallback rates
- SalesSessionMeta（Sales セッション状態）を使った SalesFlow エントリロジックの強化（前回ステージや lastIntent に応じた Clarify / Propose の分岐）
