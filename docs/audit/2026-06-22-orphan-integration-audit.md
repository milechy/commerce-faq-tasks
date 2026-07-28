# 孤立コード / フロント↔バック非連携 監査レポート

## サマリ

- **走査範囲**: backend `src/`(非テスト .ts、top-level export 834件抽出)、`admin-ui/src`(113ファイル)、`public/widget.js`、`avatar-agent/`、`tests/`、`SCRIPTS/`、`cloudflare-workers/`、`docs/`。BEルート約178件(完全パス復元)と FE呼び出し(authFetch/fetch)約110件 + widget.js 11エンドポイントを comm 突合し、未マッチ候補を個別 grep で再照合。
- **確定件数: 34件**(全件 adversarial 検証済み、誤検知ゼロ)
- **カテゴリ別**:
  - broken-fe-call: 2件(FE→BE のパス/メソッド不一致で 404/405)
  - contract-mismatch: 3件(JSONフィールド/メソッド不整合)
  - orphaned-endpoint: 8件(BE実装済みだが呼び出し元ゼロ)
  - half-wired-feature: 4件(BE完備だが FE がモック表示でデータ未連携)
  - dead-export: 10件(参照ゼロの export 関数/型)
  - orphaned-component: 11件(import されない React コンポーネント)
- **誤検知で除外した件数の注記**:
  - dead-export 走査で occ==2(定義+1使用)の **135件は実使用が大半のため除外**。occ==1(定義のみ)の9件 + 別途確認の型1件のみを確定。
  - 「未使用 export」候補の多くは tests/・SCRIPTS/・同一ファイル内使用・型のみ使用を含めると実使用と判明し除外(過去レポートでは80件中 真dead 1件の前例)。
  - FE→BE 突合で widget.js の9エンドポイント(`/api/voice/asr` 含む)は **全て合致(broken無し)** と確認し除外。

---

## broken-fe-call(壊れた FE→BE 連携 — 本番で 404/405)

### 1. [medium] `admin-ui/src/pages/admin/avatar/studio.tsx:290` — Avatar config reset が 404

- **照合キー**: `POST /v1/admin/avatar-configs/:id/reset-to-default`(FE) vs `POST /v1/admin/avatar/configs/:id/reset-to-default`(BE, routes.ts:690)
- **問題**: FE が `avatar-configs`(ハイフン結合)を呼ぶが、BE実体は `avatar/configs`(スラッシュ区切り)。この1行だけ表記揺れで、本番の「デフォルトに戻す」ボタンが 404。他の avatar configs 系(activate/voice-clone/configs/:id)は全て slash 形式で一致。
- **推奨アクション**: **繋ぐ** — FE のパスを `avatar-configs` → `avatar/configs` に1行修正。

### 2. [medium] `admin-ui/src/components/admin/AIReportTab.tsx:685` — 判定ルール一覧が常にモック表示

- **照合キー**: `GET /v1/admin/tuning?source=judge&status=suggested`(FE) vs BE には bare `GET /v1/admin/tuning` 不在(あるのは `/v1/admin/tuning-rules` と `PUT /v1/admin/tuning/:id/approve|reject` のみ)
- **問題**: bare GET が 404 → `res.ok` 失敗 → catch で握りつぶし → `rules` が常に `MOCK_RULES` のまま。画面はクラッシュしないが super_admin に**偽データが本物のように表示される**(half-wired と broken の複合)。
- **推奨アクション**: **要確認/繋ぐ** — 正しい一覧エンドポイント(`/v1/admin/tuning-rules` か新規 bare ルート)に接続するか、モック依存を解消。super_admin 限定だが実害(偽データ提示)あり。

---

## contract-mismatch(リクエスト/レスポンス契約の不整合)

### 1. [medium] `src/api/internal/usageRoutes.ts:21` — agent 報告のトークン数が破棄され課金 $0

- **照合キー**: `POST /api/internal/usage` body — agent.py:184-194 送信 `{tenantId, inputTokens, outputTokens, model, featureUsed}` vs BE destructure `{tenantId, requestId, ttsTextBytes, avatarCredits, avatarSessionMs}`
- **問題**: agent が報告した実トークン数を BE が読まず、`trackUsage` に `inputTokens:0, outputTokens:0` をハードコード。`model`/`featureUsed` も無視し `GROQ_VERSATILE_70B`/`'avatar'` 固定。→ avatar Groq LLM コストが $0 で記録され**課金/計測が過小**。
- **推奨アクション**: **繋ぐ** — body から `inputTokens/outputTokens/model/featureUsed` を読んで `trackUsage` に渡す。(注: tts/credits/sessionMs の主要コストは別 POST で正しく捕捉されているため影響は1コスト要素に限定)

### 2. [medium] `admin-ui/src/components/admin/TenantTuningTab.tsx:30` — ルールトグルが 404 で失敗

- **照合キー**: `PATCH /v1/admin/tuning-rules/:id`(FE) vs BE は同パスを `PUT` のみ定義(routes.ts:343)、PATCH ハンドラ不在
- **問題**: Express は PATCH を PUT にルートしないため 404 → `toggleRule` が throw → 「更新に失敗しました」。同等トグルを `pages/admin/tuning/index.tsx:36` は `PUT` で正しく実装しており、本 component(tenants/[id].tsx:427 でマウント)だけメソッドが外れ値。
- **推奨アクション**: **繋ぐ** — FE の `method:"PATCH"` → `"PUT"` に1行修正(BE updateSchema は is_active optional を許容済み)。

### 3. [low] `avatar-agent/agent.py:553` — DataChannel `'chat'` 経路が到達不能(dead code)

- **照合キー**: agent.py `elif msg_type=='chat'`(→handle_chat→call_groq_llm) vs widget publishData 送信型は `widget_connected/tts_request/thinking_start/state_change` の4種のみ
- **問題**: widget が `type:'chat'` を送らないため agent の Groq fallback(call_groq_llm / _report_groq_usage)は本番で起動せず、上記 usage 破棄バグも顕在化しない。コード自体が到達不能でコメントも「レガシー/フォールバック」と明記。
- **推奨アクション**: **消す(別PR)** — 到達不能 fallback。削除前に意図的な保守用かを確認推奨。

---

## orphaned-endpoint(BE実装済みだが呼び出し元ゼロ)

### 1. [medium] `src/api/avatar/anamRoutes.ts:142` — Anam セッション終了課金が記録されない

- **照合キー**: `POST /api/avatar/anam-session-end`(`sessionSeconds` 受領 → trackUsage `anam_session_seconds`)。caller を widget/avatar-agent/admin-ui 全域で 0件
- **問題**: widget は開始(`/api/avatar/anam-session`:1138)は呼ぶが、終了は呼ばない。teardown(cleanupAnam:1523、beforeunload:2560)は `stopStreaming()` / `cleanupLiveKit()` のみで session-end を POST しない。downstream 課金配線は完備(costCalculator/usageTracker)だが**書き手不在で Anam セッション時間課金が一切発火しない**(start without close)。
- **推奨アクション**: **繋ぐ** — widget の teardown/beforeunload で sessionSeconds を計測し `navigator.sendBeacon` 等で POST。収益/正確性ギャップ。

### 2. [medium] `src/api/admin/knowledge/faqCrudRoutes.ts:493` — FAQ 一括削除 UI 未配線

- **照合キー**: `DELETE /v1/admin/knowledge/faq/bulk`。FE caller 0件(参照は定義+ログ+postmortem doc のみ)
- **問題**: Phase36 で BulkActionBar(`onBulkDelete` prop + i18n キー)が作られたが、BulkActionBar 自体が未 import(下記 orphaned-component 参照)。KnowledgeListTab は単体 DELETE のみ実装。一括削除機能が**フロント・バック両方で配線途中のまま放置**。auth-guard/tenant-scoped/transaction-safe なので脆弱性ではない。
- **推奨アクション**: **要確認** — 一括削除 UI を完成させ繋ぐか、endpoint + BulkActionBar をまとめて削除するか(別PR)。

### 3. [low] `src/api/admin/variants/routes.ts:113` — A/Bテスト系3本が FE 未連携

- **照合キー**: `GET /v1/admin/variants` / `GET /v1/admin/variants/stats` / `PUT /v1/admin/variants`。FE caller 0件
- **問題**: ABTestTab は `useState(MOCK_VARIANTS)` で fetch を一切持たず、これら API を呼ばない(tenants/[id].tsx:405 でマウント=描画はされるがモック表示)。エンドポイント自体は配線・テスト・認可済みで壊れてはいない(FE実装が後追い段階)。stats は内部 dead-code-report で UNREACHABLE 判定。
- **推奨アクション**: **要確認(消すな)** — ABTestTab を実API接続するか、未実装と明示記録。安易な削除は将来基盤を壊す。

### 4. [low] `src/api/admin/reports/routes.ts:1` — レポート一覧/単一取得が FE 未連携

- **照合キー**: `GET /v1/admin/reports` / `GET /v1/admin/reports/:id`。FE は `/unread-count`(tenants/[id].tsx:233)のみ呼び出し
- **問題**: 週次レポート表示UI(WeeklyReportSection)は MOCK_WEEKLY を表示し本物の list/:id を叩かない。unread-count バッジは機能。認証/tenant分離あり、未配線の死蔵状態(壊れてはいない)。
- **推奨アクション**: **繋ぐ** — WeeklyReportSection を `GET /v1/admin/reports` に接続(half-wired #4と同根)。

### 5. [low] `src/api/admin/feedback/feedbackRoutes.ts:225` — 改善マークトグルが UI 未配線

- **照合キー**: `PATCH /v1/admin/feedback/:messageId/flag`(Super Admin専用)。FE caller 0件(参照は authGuard test + コメントのみ)
- **問題**: トグル(`/flag`)も読み取りフィルタ(`?flagged=true`)も FE から呼ばれない。BE は endpoint/repo/query filter/migration/index 完備だが UI 配線のみ欠落。FE の「要改善」は別カラム(status enum)を別経路で更新しており、`flagged_for_improvement` カラムとは独立。
- **推奨アクション**: **要確認** — UI を足すか削除するか判断待ち。

### 6. [low] `src/api/admin/evaluations/routes.ts:1` — 評価の by-id 取得が HTTP 未消費

- **照合キー**: `GET /v1/admin/evaluations/by-id/:id`。非テスト caller 0件(FE は `/:sessionId` `/stats` `/kpi-stats` を使用)
- **問題**: 到達可能だが誰も呼ばない。ただし背後の `getEvaluationById` 関数は PATCH rules 経路(routes.ts:279)で内部利用されており**関数 dead ではなく HTTP 未消費**。catch-all `/:sessionId` の前に配置され shadow もされない。
- **推奨アクション**: **要確認(低リスク)** — 管理ツール/数値ID直引き用途で意図的に残された可能性。削除しても内部関数・他ルートに影響なし。

### 7. [low] `src/index.ts:240` — `POST /ce/warmup` の実呼び出し痕跡ゼロ

- **照合キー**: `POST /ce/warmup`(Cross-Encoder ウォームアップ)。FE/widget/agent/test/SCRIPTS から実呼び出し 0件
- **問題**: 明示 warmup の caller は無いが、`detect-dead-code.sh:140` の EXCLUDE_PATHS allowlist に登録済み=維持者が「呼び出し元なしの infra path」と認識し意図的に whitelist。rerank scoreBatch 経由の暗黙 warmup 経路もあり、ops 手動トリガとして配置された infra endpoint と判断。
- **推奨アクション**: **要確認(放置可)** — 意図的 infra endpoint。害は小さい。

---

## half-wired-feature(BE完備だが FE がモック表示でデータ未連携)

### 1. [medium] `admin-ui/src/components/admin/ObjectionPatternsTab.tsx:72` — 反論パターンが偽データ表示・操作が永続しない

- **照合キー**: `MOCK_PATTERNS` 固定 vs BE `/v1/admin/objection-patterns`(CRUD完備)
- **問題**: タブは MOCK_PATTERNS で初期化し fetch/authFetch ゼロ。handleDelete はローカル state 更新のみ(TODO コメントで DELETE API 未配線を明記、コメント内パスも実route と不一致)。BE は table/UPSERT writer/RAG reader/CRUD API/auth-guard test 全て存在し会話パイプラインで稼働中。→ **実テナントの蓄積済み反論パターンが管理画面に出ず、UI の追加/削除も DB に反映されない**(タブは描画される=偽データを表示する生きたUI)。
- **推奨アクション**: **繋ぐ** — fetch を実装し `/v1/admin/objection-patterns` の CRUD に接続。

### 2. [medium] `admin-ui/src/components/admin/AIReportTab.tsx:506` — 週次レポートが固定ダミー表示

- **照合キー**: `const reports = MOCK_WEEKLY;`(無条件代入、fetch皆無) vs BE `GET /v1/admin/reports`(reportsRepository/weeklyReportGenerator/migration 完備)
- **問題**: WeeklyReportSection が固定ダミー(week_label '3/20-3/26'、avg_score 72/67)を全ロールに常時表示。同タブの stats/rules は実API配線済みなのに週次だけ未接続。BE は逆に完全配線済みで、FE 表示セクションが既存 list endpoint に未接続なだけ。
- **推奨アクション**: **繋ぐ** — `GET /v1/admin/reports` に接続(orphaned-endpoint #4 と同根)。

### 3. [medium] `src/search/openviking/index.ts:13` — OpenViking モジュールが本番経路から到達不能

- **照合キー**: `OPENVIKING_ENABLED` / `searchPrincipleChunksViaOpenViking` 他。production import 0件
- **問題**: adapter+client+feature flag を備えた完成モジュールで env.ts 登録済みだが、hybrid.ts/searchAgent.ts/principleSearch.ts から一切 import されない(index.ts の「principleSearch.ts で差し替え」コメントは未実施)。実呼び出しは `SCRIPTS/run-benchmark.ts` の実験条件 BPRIME(静的推定値計算のみ、実関数は呼ばない)とそのテストだけ。`OPENVIKING_ENABLED` は .env.example=false で恒久 OFF。git 最終更新 2026-04-10。
- **推奨アクション**: **要確認/消す(別PR)** — 孤立した未使用モジュール。本番投入予定が無ければ削除候補。

### 4. [medium] `admin-ui/src/components/admin/AIReportTab.tsx:685` 関連(broken-fe-call #2 と同体)

- 判定ルール一覧の MOCK フォールバック。上記 broken-fe-call #2 参照。

---

## dead-export(参照ゼロの export 関数/型 — 全て severity low)

| # | file:line | symbol | 照合キー | 問題 | アクション |
|---|---|---|---|---|---|
| 1 | `src/integrations/notion/notionSchemas.ts:25` | `mapFaqRow` | grep 全域=定義行のみ、barrel無し | Notion mapper 群が一括死蔵。型(NotionFaq)のみ repo で使用、mapper 未配線。想定 caller の notionSyncService.ts は**存在しない** | 消す(クラスタごと別PR) |
| 2 | `src/integrations/notion/notionSchemas.ts:63` | `mapProductRow` | 同上 | 同 mapper クラスタ | 消す(別PR) |
| 3 | `src/integrations/notion/notionSchemas.ts:101` | `mapLpPointRow` | 同上 | LP Point sync runner 不在、bulkUpsert は件数ログのみ(MVP TODO) | 消す(別PR) |
| 4 | `src/integrations/notion/notionSchemas.ts:132` | `mapTuningTemplateRow` | 同上 | 唯一の歴史的消費元 notionSyncService.ts 削除済み(dist に stale 残骸) | 消す(SCRIPTS の壊れた import も併せ別PR) |
| 5 | `src/types/contracts.ts:64` | `RAGResult` | grep -rnw=定義行のみ | 未使用 interface。固有フィールド searchLatencyMs/modelRouting は他で未構築 | 消す(別PR) |
| 6 | `src/types/contracts.ts:59` | `RagContextItem` | 同上 | 実使用は別型 RagContext(flowControl.ts:63)。本型は参照ゼロ | 消す(別PR) |
| 7 | `src/agent/types.ts:90` | `AgentSearchOptions` | grep=定義行のみ | 後継型 AgentSearchParams に置換済みの残骸 interface | 消す(別PR) |
| 8 | `src/ui/adapter/adapterTypes.ts:23` | `AdapterUIMode` | adapterTypes.ts 自体が import 元ゼロ | ファイル全体が canonical(agentDialog/contracts)の重複残骸 | 消す(ファイルごと別PR検討) |
| 9 | `src/lib/metrics/kpiDefinitions.ts:16` | `KpiMetricName` | grep 全域=定義行のみ | 値定数 KPI_METRIC_NAMES は多用されるが derived type は未使用 | 消す/放置可 |

---

## orphaned-component(import されない React コンポーネント — 全て severity low)

| # | file:line | symbol | 照合キー | 問題 | アクション |
|---|---|---|---|---|---|
| 1 | `admin-ui/src/pages/FaqList.tsx:27` | `FaqList` | grep=自ファイルのみ。App.tsx:182 は `/faqs` を `<Navigate to="/admin">` | 旧FAQ一覧。ナレッジ管理に置換済み、render されない | 消す(別PR) |
| 2 | `admin-ui/src/pages/FaqForm.tsx:22` | `FaqForm` | App.tsx に import/Route なし | 旧FAQ作成/編集。FaqList と同様の旧UI残骸 | 消す(別PR) |
| 3 | `admin-ui/src/components/AdminNavBar.tsx:87` | `AdminNavBar` | 460行。App.tsx は AppSidebar/MobileHeader/MobileBottomBar 使用 | 旧ナビバー。現行レイアウトに置換済み | 消す(別PR) |
| 4 | `admin-ui/src/components/AdminAIChat.tsx:23` | `AdminAIChat` | 参照はコメント2件のみ(App.tsx:188 が撤去を明記) | 旧サポートAI FAB。AdminAgent に一本化済み | 消す(別PR) |
| 5 | `admin-ui/src/components/feedback/FeedbackChat.tsx:22` | `FeedbackChat` | 参照は AdminAIChat の古いコメントのみ | 299行。FeedbackPage が import せず孤立 | 消す(別PR) |
| 6 | `admin-ui/src/components/widget/ChatWidget.tsx:159` | widget/ クラスタ | ChatWidget/ChatInput/MessageList が相互参照のみ | 閉じた孤立クラスタ。public/widget.js は別実装で未使用 | 消す(3ファイル別PR) |
| 7 | `admin-ui/src/components/knowledge/Pagination.tsx:12` | `knowledge/Pagination` | common/Pagination(named)が実使用、本ファイル(default)は参照ゼロ | 重複死蔵。consumer は named import で構文上取込不可 | 消す(別PR) |
| 8 | `admin-ui/src/components/knowledge/BulkActionBar.tsx:10` | `BulkActionBar` | grep=自ファイルのみ。KnowledgeListTab に bulk state 無し | Phase36 一括操作バー。endpoint(orphaned #2)と共に未配線 | 消す or 配線(別PR) |
| 9 | `admin-ui/src/components/knowledge/FaqSearchBar.tsx:8` | `FaqSearchBar` | grep=自ファイルのみ | FAQ検索バー。Phase36 放棄UIの一部 | 消す(別PR) |
| 10 | `admin-ui/src/components/knowledge/PdfUploadSection.tsx:14` | `PdfUploadSection`(+admin/FileUpload) | grep=自ファイルのみ。FileUpload は本ファイルからのみ import | 孤立。連鎖で FileUpload も到達不能(現行PDFは PdfUploadTab) | 消す(2ファイル別PR) |
| 11 | `admin-ui/src/components/BackLink.tsx:8` | `BackLink` | grep=自ファイルのみ | 31行の戻るリンク。各ページは inline 実装 | 消す(別PR) |

---

## 要人間判断(消すべきか繋ぐべきか不明)

用途が確定せず、削除すると将来機能を壊す/未配線を完成させるべきか判断が要る項目:

1. **`src/api/admin/variants/routes.ts:113`(A/Bテスト3本)** — 配線・テスト・認可済みの正規エンドポイント。ABTestTab が MOCK_VARIANTS 段階。**ABTestTab を実API接続するか、未実装と明示記録するか**。安易な削除は将来の A/Bテスト基盤を壊す。

2. **`src/api/admin/feedback/feedbackRoutes.ts:225`(`/flag` トグル)** — Super Admin 専用の改善マーク機能。BE 完備・UI 配線のみ欠落。**UI を足すか削除するか**。`flagged_for_improvement` カラムは status enum とは独立機構。

3. **`src/api/admin/knowledge/faqCrudRoutes.ts:493`(FAQ bulk delete)+ BulkActionBar.tsx** — Phase36 で両側を作り始めて放置。**一括削除UIを完成させ繋ぐか、endpoint+component をまとめて削除するか**。

4. **`src/search/openviking/*`(OpenViking モジュール)** — env登録済みの完成モジュールだが恒久 OFF・本番未到達・2026-04-10 以降放置。**本番投入予定の有無を確認**。予定が無ければ削除候補。

5. **`src/index.ts:240`(`POST /ce/warmup`)** — dead-code allowlist に意図的登録済みの ops 手動トリガ infra endpoint。**ops 運用で実際に叩いているか確認**。叩いていなければ削除可だが害は小さく放置可。

6. **`src/api/admin/evaluations/routes.ts:1`(`/by-id/:id`)** — HTTP 未消費だが内部関数 getEvaluationById は生存。**管理ツール/数値ID直引き用途で意図的に残したかを確認**。削除しても内部関数・他ルートに無影響。

7. **`avatar-agent/agent.py:553`(DataChannel `'chat'` fallback)** — コメントで「レガシー/フォールバック」明記の到達不能経路。**意図的な保守用 fallback かを確認**してから削除。