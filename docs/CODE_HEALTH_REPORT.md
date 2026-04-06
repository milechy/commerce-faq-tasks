# RAJIUCE Code Health Report

**Generated:** 2026-04-06  
**Tool:** manual analysis (grep + madge + pnpm ls)

---

## Summary

| Category | Count | Status |
|---|---|---|
| Source files (src/) | 260 TS files / 40,521 lines | ✅ |
| Admin UI | 68 TSX/TS files / 27,118 lines | ✅ |
| Test files | 99 total (58 in tests/ + 41 in src/) | ✅ |
| SCRIPTS | 69 files | ✅ |
| Dead exports (src/) | 56 detected | ⚠️ |
| Circular dependencies | 7 chains detected | ⚠️ |
| Unregistered routes | 0 | ✅ |
| Env vars in code but not .env.example | 79 | ⚠️ |
| Stale .env.example entries | 11 | ⚠️ |

---

## A1: Dead Code Detection

### Unused Exports (56 detected)

関数・クラス・定数として export されているが、`src/` 内の他ファイルからは参照されていないもの。

| File | Symbol | Note |
|---|---|---|
| `src/ui/avatar/resolveAvatarUiMode.ts` | `resolveAvatarUiMode` | avatar UI utility |
| `src/middleware/topicGuard.ts` | `sessionAbuseCounts`, `evictExpiredTopicSessions` | L7 guard internals |
| `src/middleware/inputSanitizer.ts` | `evictExpiredSessions` | L5 sanitizer internal |
| `src/agent/llm/groqClient.ts` | `getGroqGlobalBackoffRemainingMs`, `GroqApiError`, `GroqRateLimitError`, `GroqServerError`, `GroqBadRequestError` | Error classes — likely used by callers at runtime |
| `src/agent/objection/objectionDetector.ts` | `POSITIVE_KEYWORDS` | Constant |
| `src/agent/config/ragLimits.ts` | `RAG_TOTAL_MAX_CHARS` | Config constant |
| `src/agent/crew/CrewTask.ts` | `CrewTask` | CrewAI legacy |
| `src/agent/http/middleware/auth.ts` | `createAuthMiddleware` | Legacy auth middleware |
| `src/agent/report/weeklyReportGenerator.ts` | `collectWeeklyMetrics` | Weekly report helper |
| `src/agent/orchestrator/sales/clarifyPromptBuilder.ts` | `buildClarifyPrompt` | SalesFlow helper |
| `src/agent/orchestrator/sales/notionSalesTemplatesProvider.ts` | `createNotionSalesTemplateProvider` | Notion integration |
| `src/agent/orchestrator/sales/pipelines/pipelineFactory.ts` | `getSalesPipelineConfig`, `inferPipelineKindFromTenant` | Pipeline factory |
| `src/agent/orchestrator/sales/rulesLoader.ts` | `DefaultSalesRulesLoader` | Rules loader |
| `src/agent/orchestrator/crew/crewClient.ts` | `CrewOrchestratorClient` | CrewAI legacy |
| `src/agent/flow/queryPlanner.ts` | `RuleBasedQueryPlanner` | Legacy planner |
| `src/search/langRouter.ts` | `langRouterSearch` | Lang router |
| `src/search/openviking/index.ts` | `isOpenVikingEnabled` | Search integration |
| `src/search/langIndex.ts` | `resolveEsIndex` | ES index resolver |
| `src/search/langEmbedding.ts` | `detectLangFromText`, `resolveFaqLang`, `MIGRATION_ADD_LANG_COLUMN` | Lang embedding |
| `src/integrations/notion/notionSyncService.ts` | `NotionSyncService` | Notion sync |
| `src/integrations/notion/clarifyLogWriter.ts` | `ClarifyLogWriter` | Notion clarify log |
| `src/lib/metrics/metricsCollector.ts` | `metricsCollector` | Metrics |

**注意:** grep による静的解析のため false positive を含む可能性がある。
- `GroqApiError` 等のエラークラスは実行時にキャッチ句で参照される可能性あり
- Notion 統合系は n8n/外部ツールから呼ばれている可能性あり
- `type` / `interface` は除外済み

### Unregistered Routes

0件 — 全ルートファイルは `src/index.ts` に登録されている。✅

---

## A2: File Structure Statistics

```
Source Code (src/)
  Files:  260 .ts files
  Lines:  40,521

Admin UI (admin-ui/src/)
  Files:  68 .tsx/.ts files
  Lines:  27,118

Tests
  tests/ (integration): 58 .test.ts files
  src/   (unit):         41 .test.ts files
  Total: 99 test files / 970 tests

SCRIPTS/
  Files: 69
```

### Top 10 Largest Files

| Lines | File |
|---|---|
| 2,210 | `admin-ui/src/pages/admin/knowledge/[tenantId].tsx` |
| 1,849 | `src/agent/orchestrator/langGraphOrchestrator.ts` |
| 1,648 | `admin-ui/src/pages/admin/tenants/[id].tsx` |
| 1,129 | `admin-ui/src/pages/admin/analytics/index.tsx` |
| 1,031 | `admin-ui/src/pages/admin/billing/index.tsx` |
| 889  | `admin-ui/src/pages/admin/avatar/studio.tsx` |
| 880  | `src/api/admin/knowledge/routes.ts` |
| 837  | `admin-ui/src/pages/admin/knowledge-gaps/index.tsx` |
| 837  | `admin-ui/src/components/knowledge/KnowledgeListTab.tsx` |
| 825  | `src/api/admin/analytics/routes.ts` |

**要注目:** `langGraphOrchestrator.ts` (1,849行) は分割候補。`[tenantId].tsx` (2,210行) はAdmin UIの最大ファイル。

---

## A3: Dependency Health

### Circular Dependencies (7 chains)

madge で検出された循環依存:

1. `agent/dialog/types.ts` → `agent/flow/dialogOrchestrator.ts`
2. `agent/dialog/types.ts` → `agent/orchestrator/sales/salesIntentDetector.ts`
3. `agent/dialog/types.ts` → `agent/orchestrator/sales/salesPipeline.ts`
4. `agent/orchestrator/sales/salesPipeline.ts` → `pipelineFactory.ts` → `ecPipeline.ts`
5. `agent/orchestrator/sales/salesPipeline.ts` → `pipelineFactory.ts` → `reservationPipeline.ts`
6. `agent/orchestrator/sales/salesPipeline.ts` → `pipelineFactory.ts` → `saasPipeline.ts`
7. `agent/orchestrator/sales/salesPipeline.ts` → `pipelineFactory.ts`

**根本原因:** `agent/dialog/types.ts` が型定義ファイルだが、型の利用先が逆参照している。
**対策:** `types.ts` から型を切り出し、純粋な型定義ファイル（循環なし）に分離する。（将来タスク）

### npm Dependencies

- 総 dependencies: 21 パッケージ
- 潜在的未使用: `@langchain/core`（コード内でimportなし？ — langGraphOrchestrator.ts 経由の可能性あり）、`pino-pretty`（開発用ロガーとして正常）
- 依存警告: 0 件 ✅

---

## A4: Environment Variable Status

### コード内で参照されている変数: 106個

### .env.example に存在しない変数 (79個 — 要更新)

主要な漏れ:
```
GROQ_ANSWER_120B_MODEL, GROQ_ANSWER_20B_MODEL, GROQ_FAQ_GEN_MODEL
GROQ_PLANNER_120B_MODEL, GROQ_PLANNER_20B_MODEL
LLM_API_KEY, LLM_API_BASE, LLM_CHAT_MODEL, LLM_MODEL_120B, LLM_MODEL_20B
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
SENTIMENT_SERVICE_URL
PHASE22_MAX_TURNS, PHASE22_MAX_CLARIFY_REPEATS, PHASE22_MAX_CONFIRM_REPEATS
SLACK_WEBHOOK_URL
SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL
KNOWLEDGE_ENCRYPTION_KEY
OPENCLAW_ENABLED, OPENVIKING_ENABLED
```

### .env.example に存在するがコードで未使用 (11個 — stale)

```
AVATAR_IDLE_PROMPT
BASIC_AUTH_TENANT_ID
GEMINI_API_KEY       ← コードでは GEMINI_API_KEY として参照されていない？
GROQ_CHAT_MODEL
GROQ_MODEL_70B
JUDGE_AUTO_EVALUATE
JUDGE_SCORE_THRESHOLD
LEMONSLICE_AGENT_ID
LEMONSLICE_API_KEY
SUPABASE_BUCKET_BOOK_PDFS
SUPABASE_STORAGE_URL
```

---

## 要対応リスト

### P1 (高優先度)

| # | 問題 | 対応 |
|---|---|---|
| 1 | `.env.example` が79変数の漏れ | `SCRIPTS/env-check.sh` で定期チェック。CLAUDE.md に `.env.example` 更新ルールを追加 |
| 2 | 循環依存 7chains (`agent/dialog/types.ts`) | 型定義を分離（将来Phaseで対応） |

### P2 (中優先度)

| # | 問題 | 対応 |
|---|---|---|
| 3 | Dead exports 56件 | `SCRIPTS/dead-code-check.sh` で定期監視。明らかな不要コードは削除 |
| 4 | `langGraphOrchestrator.ts` 1,849行 | モジュール分割（将来Phaseで対応） |

### P3 (低優先度)

| # | 問題 | 対応 |
|---|---|---|
| 5 | `@langchain/core` 未使用疑い | 実際の使用箇所を確認してから判断 |
| 6 | `.env.example` の stale 11変数 | 動作確認後に削除 |

---

*このレポートは `SCRIPTS/dead-code-check.sh` と `SCRIPTS/env-check.sh` で自動更新可能*
