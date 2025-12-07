# SalesFlow Design (Phase15)

This document describes the consolidated design of SalesFlow as of Phase15.

Phase15 builds on Phase14 by:
- Externalizing templates to a Notion-based TuningTemplates DB
- Introducing a state machine for stage control
- Centralizing template fallback behaviour
- Adding logging and analysis hooks for KPI and fallback visibility

## 1. SalesFlow Overview

SalesFlow consists of five logical stages represented by the `SalesStage` type:

- **clarify** — Understand user intent & missing information.
- **propose** — Make the first concrete proposal based on intent/persona.
- **recommend** — Provide refined recommendations or alternative options.
- **close** — Help the user commit to the next step or address objections.
- **ended** — Terminal state (no further SalesFlow turns).

These stages are implemented as externalizable templates stored in the **TuningTemplates Notion DB**, and are selected at runtime based on the current stage, detected intents, and persona tags.

## 2. Intent Detection

Sales intent detection is handled by a dedicated module:

- Rules are defined in `config/salesIntentRules.yaml` (see `INTENT_DETECTION_RULES.md`).
- `salesIntentDetector.ts` loads the YAML file at startup and:
  - Parses phase-specific intent rules (clarify / propose / recommend / close)
  - Applies them to a detection text built from the latest user message and conversation history
- If the YAML file cannot be loaded or parsed, the detector safely falls back to legacy, hard-coded rules.

The detector returns a `DetectedSalesIntents` structure that summarizes:

- Propose, recommend, and close intent candidates
- A short `detectionText` used for debugging and logging

This structure is later consumed by the stage machine and orchestrator.

## 3. Stage Control (State Machine)

Stage transitions are controlled by a small, deterministic state machine in:

- `src/agent/orchestrator/sales/salesStageMachine.ts`

The orchestrator calls:

```ts
computeNextSalesStage({
  previousStage,
  hasProposeIntent,
  hasRecommendIntent,
  hasCloseIntent,
  manualNextStage,
})
```

and receives a `SalesStageTransition`:

```ts
type SalesStageTransition = {
  previousStage: SalesStage | null
  nextStage: SalesStage
  reason: 'initial_clarify' | 'auto_progress_by_intent' | 'stay_in_stage' | 'manual_override'
}
```

High-level behaviour:

- Initial call (no `previousStage`) always starts in `clarify` with reason `initial_clarify`.
- From **clarify**, any detected intent (propose/recommend/close) moves to `propose` with reason `auto_progress_by_intent`.
- From **propose**, `close` intents take priority, then `recommend`, otherwise the stage stays at `propose`.
- From **recommend**, `close` intents move to `close`, otherwise the stage stays at `recommend`.
- **close** / **ended** default to staying in the same stage.
- If `manualNextStage` is provided, it overrides the transitions above and sets reason `manual_override`.

This keeps control flow explicit and testable, while still allowing future business rules to be layered on top.

## 4. Template Selection & Fallback

Template selection is performed via a `getSalesTemplate` helper and stage-specific providers:

- `ClarifyTemplateProvider`
- `ProposeTemplateProvider`
- `RecommendTemplateProvider`
- `CloseTemplateProvider`

Inputs to template selection:

- `phase` (SalesStage, usually `clarify` / `propose` / `recommend` / `close`)
- `intent` (detected by the intent detector or explicitly set)
- `personaTags` (e.g. `beginner`, `business`, `busy`, `price_sensitive`, `existing_user`, `general`, `intermediate`)

The selection flow is:

1. Try to resolve a Notion template from TuningTemplates using `(phase, intent, personaTags)`.
2. If no matching Notion template is found, fall back to a **stage-specific fallback builder**, which returns a safe, generic template text for that phase.
3. Record a `templateId` and `templateSource`:
   - `templateSource = "notion"` when a Notion template is used
   - `templateSource = "fallback"` when the internal fallback is used

Phase15 also adds beginner-specific fallbacks:
- When `personaTags` includes `beginner`, a more guided, simpler tone is used where appropriate.

## 5. Orchestrator Responsibilities

The main orchestrator (`salesOrchestrator.ts`) coordinates:

1. **Inputs**
   - Multi-step `plan` (from the planner)
   - Conversation `history`
   - `personaTags`
   - Detection context (`userMessage` and intents from `salesIntentDetector`)

2. **Stage decision**
   - Calls `salesStageMachine.computeNextSalesStage()` with the previous stage and current intent signals.
   - Receives `prevStage`, `nextStage`, and `stageTransitionReason`.

3. **Template selection**
   - Invokes `getSalesTemplate` for the decided `nextStage`.
   - Obtains `{ template, templateId, templateSource }`.

4. **Logging**
   - Builds a log payload for `SalesLogWriter` including:
     - `phase`/`stage`
     - `intent`
     - `personaTags`
     - `templateId` and `templateSource`
     - stage transition metadata

5. **Answer construction**
   - Combines the selected template with planner outputs and search results (when present).
   - Returns a response object that the dialog layer can render to the user.

Phase15 also introduces `runSalesFlowWithLogging`, a thin wrapper around the orchestrator that ensures consistent logging across all SalesFlow turns.

Phase15 では、これらのステージ設計に加えて「観測可能性」も強化された。  
具体的には、テンプレート選択結果（`templateId` / `templateSource`）とステージ遷移メタデータを `SalesLogWriter` から一貫して出力し、TemplateMatrix / TemplateGaps と照合できるようにしている。  
これにより、どの `phase × intent × personaTag` で fallback が多いか、どのステージにトラフィックが滞留しているかを、`SCRIPTS/` 配下の分析スクリプト（詳細は `SALES_ANALYTICS.md`）から定期的に可視化できる。

## 6. Logging & Analysis Hooks

SalesFlow emits structured logs via `SalesLogWriter`. As of Phase15:

- Each sales turn includes:
  - `phase` / `stage`
  - `intent`
  - `personaTags`
  - `templateId`
  - `templateSource` (e.g. `notion`, `fallback`)
- Logs can be exported to CSV and analyzed by scripts in `SCRIPTS/`:
  - Fallback coverage and TemplateMatrix alignment: `analyzeTemplateFallbacks.ts`
  - Stage/intent-level funnel and fallback KPIs: `analyzeSalesKpiFunnel.ts`

These hooks make it possible to:
- Identify intents/personas that still rely heavily on fallback templates
- Prioritize where to add or refine Notion templates
- Track the effectiveness of template tuning over time.

## 7. Future Design Enhancements

Future phases may explore:

- Richer personaTag interactions (multiple tags with scoring/priority)
- Cross-session SalesFlow memory (longer-term user context)
- ML-based or hybrid intent detection feeding into the same state machine
- A UI layer for non-technical users to inspect KPIs and drive template updates directly.