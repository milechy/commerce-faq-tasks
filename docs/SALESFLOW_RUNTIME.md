# SalesFlow Runtime (Phase14)

This document explains the runtime execution flow of SalesFlow after Phase14.

## 1. High-level Architecture
SalesFlow Runtime sits between:
- **multi-step planner** (search, retrieval planning)
- **template providers** (Clarify / Propose / Recommend / Close)
- **SalesLogWriter**

The orchestrator determines:
1. Current stage (clarify → propose → recommend → close)
2. Intent (from YAML rules or explicit selection)
3. Template selection (Notion or fallback)
4. Logging
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
- optional intent override

Output:
- `{ nextStage, intent, template, templateSource, templateId }`

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
Then passes to `SalesLogWriter`.

### Step 5 — dialogAgent finalizes answer
- Append to session history
- Return combined result (search steps + salesflow output)

## 3. Stage Transition Rules

### Clarify → Propose
Triggered when:
- Clarify questions resolved
- User provides enough info
- YAML intent rules match propose-level keywords

### Propose → Recommend
Triggered when:
- User asks for alternatives / details
- YAML rules detect higher-resolution interest
- Planner followup search implies deeper need

### Recommend → Close
Triggered when:
- User shows readiness to proceed
- Confidence in next action becomes high

## 4. Fallback Behaviour
When Notion templates cannot be found:
- Each stage has a dedicated fallback builder
- SalesLogWriter logs `templateSource: "fallback"`

## 5. Persona Tag Handling
personaTags influence:
- template selection priority
- content variant
- sales intent (optional future expansion)

## 6. Future Runtime Enhancements
- State machine-based transitions
- ML classification for intent
- Conversation memory beyond session
