# Phase20: Sales Answer Quality & Policy Intelligence

## Goal
Stabilize and significantly improve sales-related responses so that the system reliably returns concrete, policy-aligned answers (shipping, returns, warranty, fees), not generic clarifications.

## Scope
- Strengthen rule-based + retrieval hybrid answers for sales intents
- Ensure CE rerank results are actually reflected in final answers
- Reduce unnecessary clarification loops for known policy questions

## Key Deliverables
- Sales answer templates mapped to intents (shipping, returns, defects)
- Clarify-vs-answer decision matrix (rule-first)
- Regression tests for sales Q&A quality
- Logging of answer source (rule / RAG / CE)

## Technical Tasks
- Refine `salesIntentDetector` thresholds
- Enrich policy docs in search index
- Tune rerank → answer handoff logic
- Add answer-quality assertions to tests

## Exit Criteria
- Sales questions return direct answers in >90% of known-policy cases
- No CE-active path silently downgraded to heuristic
- Tests cover main sales scenarios
