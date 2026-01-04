# Phase21: Conversational Sales Flow & Multi-Turn Control

## Goal
Enable coherent, multi-turn sales conversations that progress toward resolution instead of repeating or stalling.

## Scope
- Session-aware sales context accumulation
- Explicit step progression (clarify → answer → confirm)
- Prevent redundant follow-up questions

## Key Deliverables
- Sales conversation state machine
- Context carry-over between turns
- Clear terminal conditions for sales flows

## Technical Tasks
- Extend sales context store schema
- Improve dialog orchestrator step control
- Add multi-turn integration tests
- Surface conversation state in logs

## Exit Criteria
- Multi-turn sales flows complete without looping
- Context persists correctly across turns
- Observability shows clear flow transitions
