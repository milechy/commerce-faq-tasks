# Tuning Templates Workflow (Phase15)

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

At runtime, templates are selected in multiple stages:

1. Orchestrator determines:

   - `phase` (clarify / propose / recommend / close)
   - `intent` (from YAML intent rules, or explicit selection)
   - `personaTags` (from user profile / inferred persona)

2. `getSalesTemplate({ phase, intent, personaTags })` is called.

   - Internally this delegates to a `SalesTemplateProvider` (Notion-backed) which uses the synced TuningTemplates DB.
   - The provider is responsible for choosing the **best matching Notion template** using information such as TemplateMatrix / TemplateGaps (Phase15 では実装詳細は provider 側に隠蔽される想定)。

3. Notion テンプレート解決の優先度（コンセプト）:

   1. `intent + persona` の完全一致テンプレート
   2. `intent` は一致し、persona が ANY（または空）のテンプレート
   3. `phase + persona` 向けの汎用テンプレート
   4. `phase` 共通の汎用テンプレート（persona ANY）

   ※ これらは Notion 側のテンプレ設計と TemplateMatrix/TEMPLATE_GAPS.md によってチューニングされる。

4. Provider からテンプレートが見つからなかった場合（`null` が返る場合）、Phase15 では `getSalesTemplate` が **コード内のフォールバックテンプレート**を返す:

   - `phase` ごとの最低限のテンプレート（clarify / propose / recommend / close）
   - 一部 personaTags（例: `beginner`）向けの簡易バリエーション
   - それでも不足する場合は、`fallback_default` として「もう一度要望を丁寧に確認する」ための安全な文面を返す

5. SalesLogWriter は、選択されたテンプレートの:
   - `templateId`（Notion ページ ID または `fallback:phase:...` 形式の ID）
   - `phase`
   - `intent`
   - `personaTags`
   - `templateSource`（notion / fallback 等）
     をメタデータとして記録する。

この設計により:

- Notion 上のテンプレを柔軟に差し替えつつ、
- 「テンプレが存在しないために会話が止まる」ことを防ぎ、
- どのレイヤーのテンプレがどれだけ使われているかを SalesLog から分析できる。
