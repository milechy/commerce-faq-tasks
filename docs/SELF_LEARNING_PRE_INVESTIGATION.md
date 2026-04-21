# 自己学習・自動改善 既存実装 事前調査レポート

**調査日**: 2026-04-21  
**対象リポジトリ**: commerce-faq-tasks (API + Admin UI)  
**目的**: 多業種ローンチ前に「LLM返答の自動改善ループ」を実装するにあたり、既存資産とギャップを把握する  
**調査方法**: read-only (grep/glob/read のみ、実装変更なし)

---

## 1. Prompt管理・Build/Tuning系

### 既存実装

| ファイル | 機能 |
|---|---|
| `src/api/admin/tuning/tuningRulesRepository.ts` | チューニングルールのCRUD。`trigger_pattern → expected_behavior` 形式で保存。`priority`, `is_active`, `approved_responses[]` を持つ |
| `src/api/admin/tuning/routes.ts` | `POST /v1/admin/tuning/suggest-rule` — Groq 8B が会話履歴からルール案を自動生成。ルール一覧/作成/更新/削除 API |
| `src/api/admin/ai-assist/systemPrompt.ts` | `tenants` テーブルの `system_prompt` フィールドを取得し、テナント別システムプロンプトを提供 |
| `src/agent/orchestrator/langGraphOrchestrator.ts` | `JUDGE_AUTO_EVALUATE` 環境変数でオートエバリュエーターをトリガー。Phase22フロー制御 + 安全終了保証 |
| `buildTuningPromptSection(rules)` (tuningRulesRepository.ts L252-260) | アクティブルールをシステムプロンプトのセクションとして整形・注入 |

### A/Bテスト基盤

| ファイル | 機能 |
|---|---|
| `src/agent/ab-test/variantSelector.ts` | `selectVariant(variants, fallbackPrompt)` — 重み付きA/Bバリアント選択 |
| `src/api/conversion/abTestRoutes.ts` | `assignVariant(visitorId, trafficSplit)` — ハッシュベースの決定論的割り当て。実験CRUD (`draft→running→completed/cancelled`) |
| `src/api/admin/variants/variantsRepository.ts` | バリアントのCRUD操作 |
| `src/api/admin/variants/routes.ts` | バリアント管理API |

**A/Bテスト基盤**: ✅ 存在する（バリアント選択 + 実験ライフサイクル管理）  
**制限**: `tuning_version` フィールドの明示的な管理なし。`tone` / `cta_template_id` フィールドなし（ルールは `trigger→behavior` のみ）

### テナント別Prompt

- `tenants.system_prompt` — テナントごとの基本プロンプトを DB に保管  
- `getActiveRulesForTenant(tenantId)` — アクティブなチューニングルールをテナント別に取得  
- **実現方法**: DB (`tenants` + `tuning_rules` テーブル) + プロンプト注入関数の組み合わせ

---

## 2. Judge/Evaluator系

### 既存実装

| ファイル | 機能 |
|---|---|
| `src/lib/gemini/client.ts` | `callGeminiJudge(prompt)` — Gemini 2.5 Flash REST API 呼び出し (temperature: 0.3) |
| `src/agent/judge/judgeEvaluator.ts` | メインオーケストレーション。セッションメッセージ取得 → Gemini Judge 呼び出し → スコア保存 → ルール自動シード |
| `src/agent/judge/conversationJudge.ts` | Groq `llama-3.3-70b` による代替Judge。few-shot examples (L33-80) 内蔵 |
| `src/api/admin/evaluations/evaluationsRepository.ts` | `listEvaluations()`, `getDetailedStats()`, `getKpiStats()`, `approveTuningRule()`, `rejectTuningRule()` |

### 4軸スコアリング

```
psychology_fit_score    (0-100) × 30%
customer_reaction_score (0-100) × 25%
stage_progress_score    (0-100) × 25%
taboo_violation_score   (0-100) × 20%  ← 高い = コンプライアンス良好
```

### Judgeスコア保管

- テーブル: `conversation_evaluations`
- フィールド: `id, tenant_id, session_id, score, 4軸スコア, feedback, suggested_rules, message_count, judge_model, evaluated_at, outcome, outcome_updated_by`

### 自動評価ループ

- **あり**: `JUDGE_AUTO_EVALUATE=true` でセッション完了後に自動評価実行  
- スコアが `JUDGE_SCORE_THRESHOLD`（デフォルト60）を下回ると `suggested_rules` を `tuning_rules` テーブルに `is_active=false` でシード  
- 管理者が `approveTuningRule()` / `rejectTuningRule()` で承認・却下 → Human-in-the-loop レビュー

### Judge Promptエンリッチメント (Phase60-A)

judgeEvaluator.ts は評価前に以下を収集してプロンプトに追加:

1. テナント別チューニングルール (`getActiveRulesForTenant`)
2. 知識コンテキスト (`searchKnowledgeForSuggestion`)
3. クロステナント集計統計 (`getCrossTenantContext`)

---

## 3. Feedback/改善基盤

### Analytics (Phase50)

| エンドポイント | 内容 |
|---|---|
| `GET /v1/admin/analytics/summary` | セッション数、平均Judgeスコア、知識ギャップ数、アバター率、センチメント分布、CV指標、前期差分デルタ |
| `GET /v1/admin/analytics/trends` | 日次時系列トレンド |
| `GET /v1/admin/analytics/evaluations` | スコア分布、軸別平均、低スコアセッション一覧 |

### low-score会話収集

- **実装あり**: `score < JUDGE_SCORE_THRESHOLD` 時に通知 (`low_score_alert`) + ギャップ検出 (`judge_low` ソース) が自動発火
- 収集された低スコアは `knowledge_gaps` テーブルに蓄積
- `getDetailedStats()` で低スコアセッションの詳細分析可能

### Knowledge Gap

- `src/agent/gap/gapDetector.ts` — 4ソースで検出: `no_rag`, `low_confidence`, `fallback`, `judge_low`
- 重複排除: 7日以内の類似質問は頻度インクリメントのみ
- 頻度5以上で `knowledge_gap_frequent` 通知
- `src/api/admin/knowledge-gaps/routes.ts` — 管理者がステータス (open/resolved) 管理
- `src/api/admin/knowledge/knowledgeGapRepository.ts` — CRUD

### HITLループ

- **一部あり**: Judge が `suggested_rules` を生成 → 管理者がApprove/Reject (evaluationsRepository)
- **欠如**: 会話レベルでの直接フィードバック収集（「この回答は良かった/悪かった」ボタン等）がない
- フィードバックループは Gap 検出 → 通知 → 管理者手動対応の片方向

### Auto-Tuning Flywheel (Phase58)

`src/api/conversion/autoTuning.ts`:

- `detectRepeatedJudgeSuggestions(tenantId)` — 30日間で3回以上提案されたルールを検出
- `detectABWinners(tenantId)` — 統計的有意なA/Bテスト勝者を検出
- `detectTopPrinciples(tenantId)` — CV数でランク付けされた心理学原則

---

## 4. メモリ・RAG基盤

### pgvector活用

| ファイル | 内容 |
|---|---|
| `src/search/pgvectorSearch.ts` | pgvector によるセマンティック検索 |
| `src/search/pgvector.ts` | pgvector クライアント |
| `src/search/hybrid.ts` | BM25 + ベクトルのハイブリッド検索 |
| `src/agent/llm/openaiEmbeddingClient.ts` | OpenAI text-embedding-3-small/large によるドキュメント埋め込み |
| `src/lib/knowledgeSearchUtil.ts` | `searchKnowledgeForSuggestion(tenantId, userMessage)` — Judge・チューニングルール生成に使用 |

### 成功パターン保存

- **クロステナント集計**: `src/lib/crossTenantContext.ts` — `getCrossTenantContext()` が全テナントをまたいで匿名集計
  - 集計内容: `avgScores, topPsychologyPrinciples, commonGapPatterns, effectiveRulePatterns`
  - Judge プロンプトに注入してグローバルパターンを活用
- **テナント固有の成功パターン永続保存**: **なし** — `sales_session_meta` 相当テーブルは未実装
- セールスコンテキストは `src/agent/dialog/salesContextStore.ts` でセッションローカルのみ管理

### Few-shot基盤

- `src/agent/judge/conversationJudge.ts` (L33-80): 高スコア・低スコア・タブー違反の Few-shot examples を静的定数として保持
- **動的 Few-shot 選択（実際の成功会話から自動収集）**: **なし**

---

## 5. Feature Flags

### 既存実装

| ファイル | 内容 |
|---|---|
| `src/agent/openclaw/featureFlag.ts` | カスタムフィーチャーフラグ実装（詳細実装あり） |
| `src/config/r2cFeatureCatalog.ts` | Phase61: キーワードマッチング用フィーチャーカタログ (setup/config/content/monitoring カテゴリ) |

主要フラグ (環境変数):

```bash
JUDGE_AUTO_EVALUATE        # Judgeの自動実行 on/off
JUDGE_SCORE_THRESHOLD      # スコア閾値 (default: 60)
GAP_DETECTION_ENABLED      # ギャップ検出 on/off (default: true)
GAP_CONFIDENCE_THRESHOLD   # 信頼度閾値 (default: 0.3)
FF_AVATAR_ENABLED          # アバター機能フラグ
KILL_SWITCH_AVATAR         # アバター緊急停止
```

### テナント別パラメータ

- 管理場所: `tenants` テーブル (`system_prompt`, プラン情報)  
- チューニング値: `tuning_rules` テーブル (`priority`, `is_active` でテナント別制御)  
- **明示的な tuning_version 管理**: **なし**（ルールは個別に CRUD されるが版管理の仕組みがない）

### A/Bテストのトラフィック割当

- `assignVariant(visitorId, trafficSplit)` — visitorId のハッシュ値で決定論的割り当て
- `trafficSplit` は実験定義に含まれる重みを参照

### tuning_version管理

- **なし**: 現在のチューニングルール群に「バージョン」概念がない。ルールの個別の `created_at` / `updated_at` のみ追跡可能

---

## 6. CVとLLM返答の紐付け

### Phase65実装

`src/api/conversion/conversionRoutes.ts`:

```
POST /api/conversion/attribute
```

記録フィールド:

```
tenant_id, session_id
conversion_type: purchase | inquiry | reservation | signup | other
conversion_value
psychology_principle_used[]  ← 使用された心理学原則の配列
trigger_type, trigger_rule_id
temp_score_at_conversion      ← CV発火時点のスコア
sales_stage_at_conversion     ← CV発火時のセールスステージ
message_count, session_duration_sec
```

### 逆引き分析基盤

- **一部あり**: `GET /v1/admin/conversion/attributions` で心理学原則の効果ランキング、平均スコア@CV を分析可能
- `GET /v1/admin/conversion/effectiveness` で原則別CV数を累積追跡
- **欠如**: 「なぜこの会話が成功したか」をセッション内容から遡及的に自動分析する基盤はない

### 準成果記録

- **なし**: `clarify_complete`, `recommendation_click` 等のマイクロコンバージョンの記録なし
- `conversion_type` は購買寄りの5種類に限定（purchase/inquiry/reservation/signup/other）

---

## 7. 既存docs・Phase参照

### 関連docs

| ファイル | 内容 |
|---|---|
| `docs/CODE_AUDIT_2026-04-19.md` | 最新コード監査 (238 TS files, 37,068 lines) |
| `docs/CONVERSION_TRACKING_GUIDE.md` | Phase65-2: パートナー向けCV計測ガイド |
| `docs/PHASE22_IMPLEMENTATION.md` | Phase22: フロー制御・安全終了保証 |
| `docs/PHASE23.md` | Phase23 詳細 |
| `docs/PHASE47_OPENCLAW_RESEARCH.md` | Phase47: OpenClaw調査 |
| `docs/investigation/` | 直近の調査メモ（Phase66バグ等） |

自己学習・自動改善を直接扱う **専用ドキュメントは存在しない**。  
実装は Phase45〜62 に分散しており、統合的な設計文書が不在。

### PHASE_ROADMAP.md記載

自己学習関連の言及フェーズ:

| Phase | 内容 |
|---|---|
| Phase45 | Judge評価エンジン (`conversationJudge.ts`) |
| Phase46 | 知識ギャップ検出 |
| Phase50 | Analyticsダッシュボード |
| Phase58 | Auto-tuningフライホイール (A/B winner検出・繰り返しルール提案検出) |
| Phase60-A | Judge enrichment (チューニングルール + 知識コンテキスト注入) |
| Phase60-B | クロステナント匿名コンテキスト集計 |
| Phase60-C | Perplexityディープリサーチ統合 |
| Phase61 | フィーチャーカタログ (r2cFeatureCatalog.ts) |
| Phase62 | フィードバックAI + オプションサービス提案 |
| Phase65 | CV追跡 + 心理学原則紐付け |

「Prompt Evolution」「self-improvement」「auto-tuning」を明示的に謳うPhaseは **未定義**。

### 過去PRキーワードヒット

```
0faf117 feat(phase66): R2C default virtual tenant + carnation misattribution fix
b551a99 feat(analytics): Phase65-3 CV指標・cv-statusエンドポイント・CVUnfiredAlert
c9a8ffd fix(events): Phase65 chat_conversion → conversion_attributions ブリッジ追加
eb1644a feat(demo): Phase65-1 carnation-demo 9ページ構成に拡張、CV発火シミュレーション追加
```

「self-improvement」「auto-tuning」「prompt-evolution」「self-learning」のキーワードを持つコミットは **なし**。

---

## 8. ギャップ分析（最重要）

理想として必要な4機能に対する現状評価:

### Prompt Evolution（プロンプト自動進化）

**△ 一部ある（追加が必要）**

| 要素 | 現状 |
|---|---|
| ルール自動提案 | ✓ Groq 8B が会話から提案 (`suggest-rule`) |
| 低スコア時の自動シード | ✓ Judge スコア < 閾値で `is_active=false` シード |
| 人間承認フロー | ✓ approve/reject API 実装済み |
| バージョン管理 | ✗ `tuning_version` 概念なし。特定時点のルール全体スナップショットが取れない |
| 自動A/Bテスト → プロンプト反映 | ✗ A/Bバリアントと `tuning_rules` が連携していない |
| 改善の自動デプロイ | ✗ 承認後の自動有効化なし（管理者が手動でis_active変更） |

**必要な追加**: tuning_version スナップショット、A/Bバリアント → ルール自動昇格、閾値通過時の自動有効化

---

### Conversation Analytics（会話分析）

**△ 一部ある（追加が必要）**

| 要素 | 現状 |
|---|---|
| セッション集計ダッシュボード | ✓ Phase50 Analytics API |
| Judge スコアトレンド | ✓ 日次時系列 |
| 心理学原則効果ランキング | ✓ CV × 原則の集計 |
| セールスステージ遷移分析 | △ `sales_stage_at_conversion` は CV 時点のみ記録 |
| 準成果（マイクロCV）分析 | ✗ `clarify_complete`, `recommendation_click` 未実装 |
| ターン別スコア推移 | ✗ セッション内の会話品質変化を追跡する仕組みがない |
| コホート分析（入会日別・業種別） | ✗ 未実装 |

**必要な追加**: マイクロCV記録、ターン別スコア推移、コホート分析

---

### Tenant Memory（テナント別学習メモリ）

**✗ ほぼなし（構築が必要）**

| 要素 | 現状 |
|---|---|
| テナント別システムプロンプト | ✓ `tenants.system_prompt` |
| テナント別チューニングルール | ✓ `tuning_rules.tenant_id` |
| テナント固有の成功会話ライブラリ | ✗ なし |
| テナント固有の Few-shot 動的選択 | ✗ Few-shot は静的定数のみ |
| 「このテナントで何が効く」パターン蓄積 | △ クロステナント集計は存在 (crossTenantContext) だが個別テナントの成功パターンの永続保存はない |
| セッション間の顧客記憶 | ✗ なし（毎回ゼロスタート） |

**必要な追加**: `tenant_successful_conversations` テーブル、テナント別 Few-shot 自動選択、成功パターンの埋め込み蓄積

---

### Active Learning（アクティブラーニング）

**✗ ほぼなし（構築が必要）**

| 要素 | 現状 |
|---|---|
| 不確実な回答の検出 | △ `low_confidence` ソースの Gap 検出はある |
| 人間への確認要求 | ✗ なし |
| ラベル付き会話の自動収集 | ✗ なし |
| オンライン強化学習 | ✗ なし |
| CV成功を「報酬」としたルール強化 | △ `autoTuning.detectTopPrinciples()` が近い概念だが自動反映まで至らない |
| 低信頼度クエリのエスカレーション | ✗ なし |

**必要な追加**: 低信頼度クエリのラベリングキュー、CV シグナルをルール強化に自動フィードバックする仕組み

---

### サマリーテーブル

| 機能 | 評価 | 既存資産 | 追加必要 |
|---|---|---|---|
| **Prompt Evolution** | △ | Judge自動提案、承認フロー | tuning_version、自動デプロイ |
| **Conversation Analytics** | △ | Phase50 Analytics、Judge統計 | マイクロCV、ターン別推移 |
| **Tenant Memory** | ✗ | crossTenantContext(集計のみ) | 成功会話ライブラリ、動的few-shot |
| **Active Learning** | ✗ | Gap検出、topPrinciples | CVシグナル自動反映、ラベリングキュー |

---

## 9. 推奨次アクション

### Phase A+ 実装すべき項目（優先度順）

#### A-1: Prompt Evolution MVP（推奨: 最初に実装）

既存の Judge + チューニングルール基盤が充実しているため、最小追加で高効果。

- `tuning_rules` に `version_tag` フィールド追加（例: `v2026-04-21`）
- 承認時の自動有効化オプション（`auto_approve_if_score > 80`）
- A/Bテスト勝者 → `tuning_rules` への自動昇格スクリプト (`autoTuning.detectABWinners()` を活用)

**工数見積り**: 3〜5日  
**既存資産流用**: `tuningRulesRepository.ts`, `evaluationsRepository.ts`, `autoTuning.ts`

---

#### A-2: マイクロCV記録（Conversation Analytics 拡張）

CVトラッキング基盤 (Phase65) を拡張するだけで実現可能。

- `conversion_attributions` に `event_type` フィールド追加
- `clarify_complete`, `recommendation_click`, `stage_advanced` を準成果として記録
- Analytics API に準成果ファネル分析エンドポイント追加

**工数見積り**: 2〜3日  
**既存資産流用**: `conversionRoutes.ts`, Analytics routes, `widget.js` の `trackConversion()`

---

#### A-3: テナント成功会話ライブラリ（Tenant Memory 基盤）

- テーブル `tenant_successful_conversations` 新設（`session_id`, `tenant_id`, `embedding`, `score`, `cv_achieved`）
- Judge スコア80以上 + CV達成のセッションを自動アーカイブ
- Few-shot 選択時にテナント固有の成功会話をベクトル検索で注入

**工数見積り**: 5〜7日  
**既存資産流用**: `pgvectorSearch.ts`, `openaiEmbeddingClient.ts`, `judgeEvaluator.ts`, `knowledgeSearchUtil.ts`

---

#### A-4: CVシグナルのルール自動強化（Active Learning 最小版）

- CV発火時に `psychology_principle_used[]` を `tuning_rules` の `priority` に反映（自動スコアアップ）
- `autoTuning.detectTopPrinciples()` の結果を週次バッチで `is_active=true` 昇格候補にする

**工数見積り**: 2〜3日  
**既存資産流用**: `conversionRoutes.ts`, `autoTuning.ts`, `tuningRulesRepository.ts`

---

### 実装順序の推奨

```
Phase A (MVP)
  → A-1: Prompt Evolution MVP  (3-5日) ← 既存資産が最も整っている
  → A-2: マイクロCV記録       (2-3日) ← Phase65拡張なので低リスク

Phase B (本格化)
  → A-3: Tenant Memory基盤    (5-7日) ← pgvector活用、新テーブル必要
  → A-4: CVシグナル自動強化   (2-3日) ← A-3完了後に意味が出る
```

**合計工数見積り**: Phase A (5〜8日) + Phase B (7〜10日) = 12〜18日

---

### 既存資産の流用可能性

| 資産 | 流用先 | 流用度 |
|---|---|---|
| `judgeEvaluator.ts` | A-1, A-3のトリガー | 高（修正少） |
| `tuningRulesRepository.ts` | A-1, A-4 | 高（フィールド追加のみ） |
| `autoTuning.ts` | A-1, A-4 | 高（ロジック再利用） |
| `conversionRoutes.ts` | A-2, A-4 | 高（拡張のみ） |
| `pgvectorSearch.ts` + `openaiEmbeddingClient.ts` | A-3 | 中（新テーブル設計必要） |
| `crossTenantContext.ts` | A-3のインスピレーション | 中（同じ集計思想） |
| Analytics routes (Phase50) | A-2 | 高（エンドポイント追加） |

---

*調査実施: Claude Code (Sonnet 4.6) — 2026-04-21*
