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

---

## 2026-04-06 — コード品質改善セッション

### 変更サマリー

| 項目 | 変更前 | 変更後 |
|---|---|---|
| 循環依存 | 7 chains | **0** ✅ |
| console.* 呼び出し (非テスト) | 226 | **1** (コメント内のみ) ✅ |
| .env.example 未登録変数 | 79 | **0** ✅ |
| .env.example stale変数 | 11 | **0** ✅ |
| pnpm test | 970/970 | **970/970** ✅ |
| pnpm typecheck | 0 errors | **0 errors** ✅ |

### B1: 循環依存解消 (7 → 0)

**根本原因:** `src/agent/dialog/types.ts` が実装ファイル (`dialogOrchestrator.ts`, `salesIntentDetector.ts`, `salesPipeline.ts`) を import していたため双方向参照が発生。

**解決策:** 以下の型定義を `dialog/types.ts` に集約し、元ファイルは re-export のみに変更:
- `OrchestratorStep` (from `dialogOrchestrator.ts`)
- `SalesPipelineKind`, `SalesMeta` (from `salesPipeline.ts`)
- `DetectedSalesIntents` (from `salesIntentDetector.ts`)
- `SalesPipelineKind` を `pipelines/*.ts` も直接 `dialog/types.ts` から import するよう変更 → chains 4-7 解消

**変更ファイル:**
- `src/agent/dialog/types.ts` — 4 imports 削除、5 型定義追加
- `src/agent/flow/dialogOrchestrator.ts` — OrchestratorStep re-export
- `src/agent/orchestrator/sales/salesIntentDetector.ts` — DetectedSalesIntents re-export
- `src/agent/orchestrator/sales/salesPipeline.ts` — SalesPipelineKind/SalesMeta re-export
- `src/agent/orchestrator/sales/pipelines/*.ts` (4ファイル) — import path変更

### B2: .env.example 再構築 (79 missing + 11 stale → 0)

全 106 変数を以下のカテゴリで整理:
Core / Database / Elasticsearch / Cross-encoder / Auth / Supabase / LLM-Groq / LLM-Alternate / Embeddings / Judge / Phase22 Flow / Avatar / Storage / Billing / Monitoring / Knowledge / Notion / n8n / Search

### B4: console.* → logger (pino) 移行 (226 → 1)

- `src/lib/logger.ts` を新規作成 (console互換の `AppLogger` インターface)
- 47 ファイルの `console.log/error/warn/info/debug` を `logger.*` に置換
- テスト2件 (`bookPdfRoutes.test.ts`, `pipelineQueue.test.ts`) の logger spy を更新

### 未対応項目 (将来タスク)

| 項目 | 現状 | 優先度 |
|---|---|---|
| Dead exports | 56件 | P2 — 静的解析false positiveを含む |
| `: any` 型 | 130件 | P2 |
| `as any` キャスト | 188件 | P2 |
| `@ts-ignore` | 25件 | P3 |
| `langGraphOrchestrator.ts` 1,849行 | 分割未着手 | P3 |

---

## 2026-04-10 — コードクリーンアップセッション #2

### 変更サマリー

| 項目 | 変更前 | 変更後 |
|---|---|---|
| Dead exports | 56件 | 21件（実質0: false positive 5 + テスト用途 16） |
| `: any` 型 | 134件 | 50件 |
| `as any` キャスト | 192件 | 79件 |
| `@ts-ignore` | 25件 | 0件 |
| pnpm test | 1050/1050 | 1050/1050 ✅ |
| pnpm typecheck | 0 errors | 0 errors ✅ |

### Dead Exports (56 → 21)

- 35件の export キーワード除去（関数自体は残存、ファイル内部で使用）
- 2ファイル削除: `src/agent/crew/CrewTask.ts`, `src/agent/orchestrator/crew/crewClient.ts`（CrewAI legacy）
- 残21件の内訳:
  - false positive 5件（GroqApiError×4 + RAG_TOTAL_MAX_CHARS）
  - テスト用途 16件（dead-code-check.sh がテストファイルの import を非スキャン）
- Codex Review P1修正2件: getSalesPipelineConfig / NotionSyncService の export 復元

### `: any` 型 (134 → 50)

主な修正パターン:
- Express `req: any, res: any` → `Request` / `Response` 型
- `apiStack: any[]` → `RequestHandler[]`
- DB `result.rows.map((row: any)` → `(result.rows as RowType[]).map`
- ES検索結果 `esRes: any` → `EsHit` 型定義 + キャスト
- Notion schemas ヘルパー → `NotionProp` インターフェース
- `catch (err: any)` × 7 → `catch (err: unknown)` + `(err as Error).message`

### `as any` キャスト (192 → 79)

主な修正パターン:
- `src/search/rerank.ts`: stableStatus() 戻り型を CeEngineStatus に明示、LegacyCeStatus 型（15→0件）
- `src/api/middleware/roleAuth.ts`: SupabaseJwtUser + AuthedReq 型を export、複数ファイルで再利用
- `src/api/admin/knowledge/routes.ts`: KnowledgeReq 型定義（13→0件）
- `src/api/admin/knowledge/bookPdfRoutes.ts`: BookPdfReq 型定義（10→0件）
- `src/api/admin/avatar/generationRoutes.ts`: AvatarReq 型 + LLM レスポンスに具体型（11→0件）
- feedback, tuning, tenants, engagement, abTestRoutes: AuthedReq 型で `(req as any)` 除去

### `@ts-ignore` (25 → 0)

- 22件: `@types/pg` devDependency 追加で全解消（Pool型、QueryResult型が正しく認識）
- 3件: Stripe パッケージ同梱の型で既に解決済み → 不要な @ts-ignore 削除
- 副次修正: searchAgent.ts — Pool | null 型付けに伴い pool! 非nullアサーション追加

### 未対応項目（将来タスク）

| 項目 | 現状 | 優先度 |
|---|---|---|
| Dead exports 残 | 21件（全て正当理由あり） | 対応不要 |
| `: any` 残 | 50件（外部ライブラリ型不足） | P3 |
| `as any` 残 | 79件（外部ライブラリ型不整合） | P3 |
| `@ts-ignore` | 0件 | ✅ 完了 |
| `langGraphOrchestrator.ts` | 1,849行 → 470行 ✅ 分割完了（flowControl/graphNodes/llmCalls/ragRetrieval） | ✅ 完了 |

### langGraphOrchestrator.ts 分割 (1,849行 → 470行)

5ファイル構成:
- `langGraphOrchestrator.ts` (470行) — runDialogGraph + re-export
- `flowControl.ts` (460行) — Phase22フロー制御 + ルーティング判定5関数
- `graphNodes.ts` (377行) — グラフノード8関数 + StateAnnotation
- `llmCalls.ts` (307行) — プロンプトビルダー + LLM呼び出し
- `ragRetrieval.ts` (217行) — RAG取得 + 履歴要約

依存方向: flowControl(leaf) ← llmCalls ← ragRetrieval ← graphNodes ← langGraphOrchestrator（循環なし）

### Claude Code カスタムエージェント導入

本セッションで `.claude/agents/` に4エージェントを導入:
- `@gate-runner` — Gate 1〜3 一括実行
- `@cleanup` — dead exports/any型/as any除去
- `@deploy-checker` — VPSデプロイ前後チェック
- `@test-writer` — テスト作成

環境変数:
- `CLAUDE_CODE_NO_FLICKER=1` — Focus View 有効化
- `MCP_CONNECTION_NONBLOCKING=true` — FT Pipeline --print 高速化
