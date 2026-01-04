# Phase16 Summary

## 1. フェーズの目的

- Sales 周りの 3 本柱を揃えることを明示
  - SalesLog 拡張（ステージ遷移メタ）
  - SalesRules ローダ整備（テナント別ルール差し替え）
  - Sales セッションメタ（SalesSessionMeta）基盤

## 2. 実装・仕様変更の概要

### 2.1 SalesLog 拡張

- 追加されたフィールド：
  - `prevStage` / `nextStage` / `stageTransitionReason` / `timestamp`
- ランタイムでの流れ：
  - `SalesOrchestratorResult.stageTransition` →
    `runSalesFlowWithLogging` →
    `SalesLogWriter.buildSalesLogRecord`
- Analytics との連携：
  - `SCRIPTS/analyzeSalesKpiFunnel.ts` が Stage Transitions / Funnel Metrics を出力
  - サンプルログ `data/sales_logs.json` からレポートを生成できる

### 2.2 SalesRulesLoader の導入

- `SalesRulesLoader` インターフェースと `DefaultSalesRulesLoader`
- `initSalesRulesProviderFromLoader` / `initDefaultSalesRulesProvider`
- テナント別に `SalesRules` を差し替え可能になったこと

### 2.3 SalesSessionMeta / salesContextStore

- `SalesSessionMeta` 型：
  - `currentStage` / `lastIntent?` / `personaTags?` / `lastUpdatedAt`
- `SalesSessionKey`（`tenantId` + `sessionId`）
- In-memory store の公開 API：
  - `get/set/update/clearSalesSessionMeta` / `clearAllSalesSessionMeta`
- `dialogAgent.ts` からの利用：
  - SalesFlow 実行後に `salesResult.nextStage` を `currentStage` として保存

## 3. テスト・検証

- 追加・整備したテスト：
  - `src/agent/orchestrator/sales/salesLogWriter.test.ts`
  - `tests/agent/rulesLoader.test.ts` / `tests/agent/salesRulesLoader.test.ts`
  - `src/agent/orchestrator/sales/rulesLoader.test.ts`
  - `src/agent/dialog/salesContextStore.test.ts`
- KPI レポート確認：
  - `pnpm ts-node SCRIPTS/analyzeSalesKpiFunnel.ts data/sales_logs.json`
  - Stage Transitions / Funnel Metrics / Persona / Intent breakdown の確認

## 4. 関連ドキュメント・スクリプト

- 更新・参照した主なファイル：
  - `docs/SALES_LOG_SPEC.md`
  - `docs/SALES_ANALYTICS.md`
  - `docs/SALESFLOW_DESIGN.md`
  - `docs/SALESFLOW_RUNTIME.md`
  - `SCRIPTS/analyzeSalesKpiFunnel.ts`
- Phase16 での変更点は上記ドキュメントにも反映済みであることを明記

## 5. 今後の拡張アイデア（メモ）

- SalesLog 側：
  - `stageTransitionReason` 別集計（auto_progress / stay_in_stage など）
  - persona × Funnel 集計の追加
- SalesSessionMeta 側：
  - `lastIntent` / `personaTags` を `dialogAgent` からも更新
  - SalesFlow 初回呼び出し時に `SalesSessionMeta` を元に Clarify の挙動を変える
- RulesLoader 側：
  - Rules の外部ストア連携（Notion / DB）への差し替えポイントとして利用
