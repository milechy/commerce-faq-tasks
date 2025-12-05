

# Tuning Templates Workflow (Phase14)

This document defines how templates are authored, validated, and synced.

## 1. Authoring Templates (Notion)
Editors write templates inside the **TuningTemplates DB**:
- Phase
- Intent
- PersonaTag
- Title
- Template content
- Active flag

## 2. Sync Service
`NotionSyncService` loads templates at startup:
- Fetch DB entries
- Normalize fields
- Upsert into local repository

## 3. Validation
Developers run:
```
npx ts-node SCRIPTS/validateTuningTemplates.ts
```
This checks:
- missing required fields
- intent naming consistency
- persona coverage

## 4. Auto-generation Tools
- `generateTemplateMatrix.ts` → TEMPLATE_MATRIX.md
- `generateTemplateGaps.ts` → TEMPLATE_GAPS.md

## 5. How Templates Are Used at Runtime
- Orchestrator determines stage intent
- TemplateProvider selects best matching template
- SalesLogWriter logs TemplateId + metadata