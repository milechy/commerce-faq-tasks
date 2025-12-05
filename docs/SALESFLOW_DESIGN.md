

# SalesFlow Design (Phase14)

This document describes the consolidated design of SalesFlow as of Phase14.

## 1. SalesFlow Overview
SalesFlow consists of four stages:
- **Clarify** — Understand user intent & missing information.
- **Propose** — Make the first proposal based on intent/persona.
- **Recommend** — Provide refined recommendations.
- **Close** — Help the user commit to the next step.

These stages are implemented as externalizable templates stored in **TuningTemplates Notion DB**.

## 2. Template Selection Logic
Templates are selected by:
1. **Intent** (clarify/propose/recommend/close)
2. **Persona Tags**
3. **Fallback rules** when no persona-specific template exists

TemplateId is logged via SalesLogWriter.

## 3. Orchestrator Flow
The orchestrator performs:
- Input analysis (multi-step planning)
- Intent detection (optionally YAML-based rules)
- Sales stage routing
- Template provider lookup
- SalesLogWriter recording