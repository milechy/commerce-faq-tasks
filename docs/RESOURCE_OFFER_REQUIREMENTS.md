# 会話内資料提示（資料オファー）機能 要件定義

**対象**: エンドユーザー向け会話（`/api/chat`、`public/widget.js`）における、確度の低い訪問者への資料（ホワイトペーパー等）提示機能。資料のアップロード・管理はテナント向けCopilot UI（`admin-ui/src/pages/copilot-preview/`）。
**位置づけ**: 実装ではなく、実装前に固定すべき目的・スコープ・制約・受け入れ条件。`docs/SALES_AGENT_REQUIREMENTS.md` の Layer 0（会話を成立させる）の一形態という位置づけ。
**発端**: 赤嶺氏からのR2Cバージョンアップ提案 + hkobayashi案 — 確度の低い「ちょっと見客」には結論まで導こうとせず、「まずは参考までにこちらの資料をご覧ください」で受け止める。
**調査時点**: 2026-09-05
**調査方法**: 記憶や過去の説明ではなく実コードを読んで記述。行番号はすべて実測値。

**前提決定（2026-09-05、hkobayashi）**:
1. 資料はテナントがアップロードするPDF、または外部URL。書籍PDF取り込み（`POST /v1/admin/knowledge/book-pdf`、Phase47 Book RAG）とは完全に別経路とする。資料はAIの回答生成の知識源にしない（検索・埋め込み対象にしない）。
2. `admin-ui/src/lib/bookPdfUpload.ts` のファイル種別・サイズ検証ロジックのみ再利用可。アップロード先・保存先・取り込みパイプラインは新設し、書籍RAGの仕組みには一切乗せない。
3. 提示要否はLLMが会話内容から都度判断する。
4. 頻度制御: 1会話1回まで。
5. 計測: 提示・クリックを `behavioral_events` に記録するのみ（DL数の集計・CV相関分析は今回のスコープ外、既存analytics基盤側で後日拡張）。
6. PDF内容の自動モデレーション（テキスト抽出+LLM判定）も最初から導入する。画像のvision judgeに相当する層をPDFにも設ける。
7. `tuning_rules` に資料参照用の新カラム（`resource_id`）を追加し、構造化参照にする。
8. 資料はまず1テナント1件固定（複数登録・出し分けは需要が見えてから拡張）。
9. リード情報（メールアドレス等）のフォームゲート取得は今回のスコープ外。将来検討事項として明記のみ残す。

**関連**: `docs/SALES_AGENT_REQUIREMENTS.md`（Layer 0〜3の全体設計）

---

## 1. 用語整理

「資料」= テナントが用意する営業資料（PDF or 外部URL）。**書籍PDF（Phase47 Book RAG）とは別物**。書籍PDFはR2C運用限定でpgvectorに埋め込まれ、AIの回答根拠として使われる（200字抜粋制約あり）。資料はそのままダウンロード/閲覧させるだけの静的アセットで、検索・要約・埋め込みの対象にしない。

## 2. 現状把握（実コード）

### 2.1 半分だけ存在する足場

- `PlannerStep.cta` にはすでに `"download"` という値が定義されている（`src/agent/types.ts:165`、`src/agent/dialog/types.ts:183`）が、消費側の実装は存在しない（grep該当ゼロ）。本機能でこの空きスロットを実配線する。
- `DialogTurnResult.productCard`（`ProductCard`型、`src/agent/dialog/types.ts:144-151`）は、テキストと分離した構造化カードをwidgetへ渡す前例。ただし `src/agent/dialog/dialogAgent.ts:268-298` でのpopulateは `salesResult.nextStage === "recommend"` というSalesFlowのstage遷移による**構造的トリガー**であり、LLMのtool-call判断ではない。
- **既知の穴**: `src/api/chat/route.ts:663-664` はAPIレスポンスに `productCard` を載せているが、`public/widget.js` はこれを一切参照していない（grep該当ゼロ）。バックエンドは配線済みだがwidgetは未消費＝到達しないコード（`CLAUDE.md` 禁止15と同型の穴）。
  **→ 本機能の資料カードは同じ穴を作らない。widget側のレンダリングまでを同一PRのスコープに含めることを必須条件とする。**

### 2.2 顧客向けチャットの「LLM判断」の既存パターン

- `ProposeIntent` / `RecommendIntent` / `CloseIntent`（`src/agent/orchestrator/sales/*.ts`）という型は存在するが、**実装時の検証で判明した訂正**: これらを実際に決定しているのは `src/agent/orchestrator/sales/salesIntentDetector.ts` の正規表現/YAML（`config/salesIntentRules.yaml`）によるルールベース判定であり、LLMが構造化JSONを出力してこれらを決めているわけではない（旧記述は誤り）。
- 顧客向けチャット側には Groq/Gemini の native `tool_calls`（function calling）機構は存在しない（`tool_calls` / `tools:` のgrep該当ゼロ）。admin-uiのエージェントツール体系（`toolDefinitions.ts` 等）とは完全に別系統。
- LLMが構造化JSONを出力し `dialogAgent.ts` がそれを消費する経路は、リポジトリ全体で唯一 `src/agent/flow/llmMultiStepPlannerRuntime.ts`（`useLlmPlanner: true` 時のみ）。しかし `public/widget.js` はこのオプションを一度も有効化しておらず、**本番の顧客トラフィックではこの経路は常に不使用（dark path）**。ここに `resourceOffer` を実装すると、型チェック・単体テストは通るが本番では永久に発火しない「配線されたが未消費」のコード（`productCard`と同型の欠陥、→ 禁止67）になる。
  **→ 実装した内容: `resourceOffer`はLLMの構造化出力フィールドではなく、本番で毎ターン実行されるルールベースの信号から導出する（`src/agent/dialog/dialogAgent.ts`の`isLowIntentBrowsing()`）。主信号は「`detectSalesIntents()`がpropose/recommend/closeのいずれのintentも検出しなかったこと」、副次的なOR条件として`multiStepPlan.confidence === "low"`を残すが、本番のルールベースプランナー（`src/agent/flow/multiStepPlanner.ts`）は`confidence`を常に`'medium'`固定で返すため、現状この副次条件は実質的に無効（将来confidence算出が実質化されたときのための前方互換の保険としてのみ残す）。**

### 2.3 アバター画像モデレーションの前例（PR #1223, `5c2e752a`）

- `src/lib/imageContentGuard.ts`: `checkImageForInfringement()` がGemini 2.5 Flash visionで著作権/NSFW/肖像権をJSON判定。**fail-open**（API障害時はwarnログのみで通す）。`src/api/admin/avatar/routes.ts` で保存前に呼ぶ。
- `admin-ui/src/pages/admin/avatar/StudioImageSection.tsx:127-158,272`: 「この画像が第三者の著作権・商標権・肖像権を侵害しないことを確認しました」チェックボックス。**こちらはfail-openではないハードゲート**（未チェックはボタン自体が押せない）。
  **→ 資料アップロードもこの二層を踏襲する: ①テキスト抽出+LLM判定の自動チェック（fail-open）②本人確認チェックボックス（ハードゲート）。**
- PDFのテキスト抽出には `src/lib/book-pipeline/pdfExtractor.ts` が使う `pdf-parse`（既存依存）をそのまま流用できるが、**`extractPdfText()` 関数自体は書籍PDFの暗号化ダウンロード（`book-pdfs` バケット、AES-256-GCM復号）に結合している**ため、その関数は再利用しない。資料PDF用には非暗号化バッファに対する `pdf-parse` 直呼び出しを別途実装する（複製ではなく、結合が異なるので別実装が正しい）。抽出テキストをGemini 2.5 Flashで著作権/不適切表現をJSON判定し、`imageContentGuard.ts` と同じくfail-openとする。

### 2.4 CV/成果指標との接続点

- `chat_sessions.outcome`（nullable、`tenants.conversion_types` の値のいずれか。既定 `["購入完了","予約完了","問い合わせ送信","離脱","不明"]`、`chatHistoryRepository.ts:545-549`）。更新経路はagent tool `record_session_outcome`（`toolDefinitions.ts:1635`、`confirmPolicy.ts`でrisk=`medium`）または `PATCH /v1/admin/chat-history/sessions/:sessionId/outcome`。
- `CVUnfiredAlert.tsx` は `not_fired_tenants` という別集計（30日CV無発火アラート、super_admin向け）を読んでおり、セッション単位のoutcomeとは別物。
  **→ 「資料DLがその後のCVにどう繋がったか」は新しい計測基盤を作らず（`CLAUDE.md` 禁止32）、`behavioral_events` の資料イベントと既存 `chat_sessions.outcome` をJOINして分析する形にする。`conversion_types` に「資料DL」を強制で追加はしない（テナントごとに意味が異なるため）。**

### 2.5 Hermes/学習ループの着地先

- Hermes提案は `POST /v1/hermes-mcp/proposals`（`src/api/hermes-mcp/routes.ts`）が `tuning_rules` に `source='hermes'`, `is_active=false` でINSERTし、Judge提案（`src/agent/judge/evaluationAnalyzer.ts:159-165`、同じく`is_active=false`固定）と**同一テーブル・同一承認UI**（`copilot-preview/index.tsx` の `rulesList` カード、生成 L1013 / 描画 L2883）に合流している。
  **→ 「この質問パターンには資料オファーが効きそうだ」というHermes/Judge由来の提案も、新しい提案テーブル・新しい承認画面を作らず既存 `tuning_rules` に載せる（`CLAUDE.md` 禁止31）。`tuning_rules` に `resource_id`（`tenant_resources.id` への参照、nullable）カラムを追加し、`expected_behavior` の自然文だけに頼らず構造化して資料を特定する。**

### 2.6 通知

- `src/lib/notifications.ts` の `createNotification({recipientRole, recipientTenantId, type, title, message, link?, metadata?})` はfire-and-forgetのプレーンINSERT。資料DL発生時に `recipientRole: 'client_admin'` で「資料がダウンロードされました」通知（ホットリード信号）に転用できる。

### 2.7 非RAGファイルストレージの前例

- アバター画像は `supabaseAdmin.storage.from(AVATAR_BUCKET).upload(...)`（`src/api/admin/avatar/routes.ts:95-127`）、パスは `${tenantId}/${filename}.${ext}` でテナントスコープ。バケットは機能ごとに専用命名（`avatar-images`, `avatar-defaults`）。
  **→ 資料も専用バケット（例: `tenant-resources`）を新設し、同じ `${tenantId}/...` パス規約を踏襲する。**

## 3. スコープ

### 今回入れる
- Copilot UIからの資料（PDF/URL）アップロード・確認・削除（**1テナント1件固定**、上書きアップロードで更新）
- 著作権等の確認チェックボックス（ハードゲート）＋ テキスト抽出+LLMによる自動モデレーション（fail-open）
- LLMによる構造化出力ベースの提示要否判断（1会話1回キャップ）
- widgetでの資料カード表示（§2.1のproductCardの穴を繰り返さないため必須）
- `behavioral_events` への提示・クリックイベント記録
- テナントへの通知（資料DL発生時）
- `tuning_rules.resource_id` カラム追加（Hermes/Judge由来の資料オファー提案の構造化着地先）

### 今回入れない（将来検討）
- 資料DL時のメールアドレス等リード情報のフォーム取得（今回は「見せる・渡す」だけ）
- 資料の複数登録・用途別（業種別/ページ別）出し分け（1件固定で開始し、需要が見えてから拡張）
- Hermes/Judgeからの「資料オファールール」自動提案の生成ロジック自体（着地先カラムのみ用意、生成は別タスク）
- 書籍RAGとの統合・資料内容の検索可能化（意図的に対象外、§2.1参照）

## 4. 実装の置き場所（案）

| やりたいこと | 置き場所 |
|---|---|
| 資料メタデータ | 新テーブル `tenant_resources`（id, tenant_id **UNIQUE**（1件固定を制約で保証）, title, description, storage_path or external_url, file_type, moderation_status, moderation_reason, rights_confirmed, is_published, created_at） |
| ファイル実体 | Supabase Storage 新バケット `tenant-resources`、パス `${tenantId}/${resourceId}.${ext}` |
| クライアント側検証 | `admin-ui/src/lib/bookPdfUpload.ts` の `isPdfFile`/`validateBookPdfFile` 相当を汎用化 or 同ファイルに新関数追加（複製しない） |
| PDFテキスト抽出（自動モデレーション用） | `pdf-parse`（既存依存）を直接呼ぶ新関数。`src/lib/book-pipeline/pdfExtractor.ts` の `extractPdfText()` は書籍PDF復号に結合しているため流用しない |
| 自動モデレーション判定 | `src/lib/imageContentGuard.ts` と同型のGemini 2.5 Flash JSON判定関数を新設（fail-open） |
| Copilot UIツール | `get_resource` / `upload_resource` / `delete_resource`（`toolDefinitions.ts` + `actionExecutor.ts` の `switch` + `REAL_TOOL_LABEL` の3点セット、`confirmPolicy.ts` でアップロード/削除を分類） |
| カード同期（管理画面） | 3層（`actionExecutor.ts` の `*CardPayload`、`useAgentChatTransport.ts` の `AgentActionCard`、`copilot-preview/index.tsx` のCard union） |
| 顧客向け提示判断 | `src/agent/dialog/dialogAgent.ts` の `isLowIntentBrowsing()`（実装済み。§2.2参照。LLM構造化出力ではなく `detectSalesIntents()` ベース） |
| widgetレンダリング | `public/widget.js` の既存Shadow DOM構築部に資料カード表示を追加（`innerHTML` 禁止、`textContent`/`createElement` のみ） |
| 計測 | 既存 `behavioral_events` に `event_type: 'resource_offered' | 'resource_clicked'` を追加 |
| 通知 | `src/lib/notifications.ts` の `createNotification` |
| 学習ループ着地 | 既存 `tuning_rules` に `resource_id`（`tenant_resources.id` 参照、nullable）カラムを追加。承認フローはsource問わず既存のまま共通 |

## 5. 実装上の制約

### 5.1 既存コードへの統合方針（新規ファイルを安易に作らない）

**新規ファイルとして正当化できるもの**（既存レイヤーの複製ではなく、genuinely新しい関心事）:

| 新規ファイル | 理由 |
|---|---|
| `src/api/admin/resources/routes.ts` | `src/api/admin/avatar/routes.ts` / `tuning/routes.ts` と並ぶ新機能のAPI層。既存ディレクトリへの間借りは責務混在になる |
| `src/api/admin/resources/resourcesRepository.ts` | `tuningRulesRepository.ts` と同じ粒度のDBアクセス層 |
| `src/api/admin/resources/migration_tenant_resources.sql` | 新テーブル。機能ディレクトリにcolocate（既存規約） |
| `src/api/admin/resources/migration_tuning_rules_resource_id.sql` | `tuning_rules`への列追加だが、**列を必要とする機能側のディレクトリに置く**（前例: `src/agent/judge/migration_tuning_rules_judge.sql` はjudge機能がtuning_rulesに列追加した際、tuning側ではなくjudge側に置かれている） |
| `src/lib/resourceContentGuard.ts` | `imageContentGuard.ts`と同じ「ドメイン別モデレーション薄ラッパー」枠。**Gemini呼び出し自体は複製しない** — 既存の `callGeminiJudge()`（`src/lib/gemini/client.ts:78`、テキスト入出力の汎用プリミティブ）をそのまま呼ぶ。`imageContentGuard.ts`が`callGeminiVisionJudge()`を呼ぶのと対称 |
| PDFテキスト抽出用の小関数（例: `src/lib/resourcePdfExtract.ts`） | `src/lib/book-pipeline/pdfExtractor.ts` の `extractPdfText()` は**書籍PDFのAES-256-GCM復号に結合**しており、非暗号化の資料PDFには使えない。`pdf-parse`（既存依存、`pdfExtractor.ts`が使っているのと同じライブラリ）を直接呼ぶだけの薄い新関数にする。中身が違う処理を無理に共用しない（禁止6の逆 — 異なる関心事を1ファイルに無理に同居させない） |

**既存ファイルを拡張するだけで済ませる（新規ファイルを作らない）箇所**:

| 拡張対象 | やること |
|---|---|
| `admin-ui/src/lib/bookPdfUpload.ts` | `validateBookPdfFile`と同型の資料用バリデーション関数を追加。**第2の添付経路を作らない**（実装の置き場所テーブルに明記済みの既存原則） |
| `src/api/admin/agent/toolDefinitions.ts` + `actionExecutor.ts` の `switch` + `copilot-preview/index.tsx` の `REAL_TOOL_LABEL` | ツール追加は必ずこの3点セット。新ファイルにツール定義を分散させない |
| `src/api/admin/agent/confirmPolicy.ts` の `WRITE_TOOL_RISK_TIERS` | `upload_resource: 'medium'`, `delete_resource: 'high'` を追記するだけ。新しいリスク階層表を作らない |
| `admin-ui/src/lib/useAgentChatTransport.ts` の `AgentActionCard` union | `ResourceAgentActionCard`を追加。新ファイルでunion定義を割らない |
| `public/widget.js` の既存Shadow DOM構築関数群 | 資料カード描画を追加。第2のwidget実装・iframeを作らない |
| `src/lib/notifications.ts` の `createNotification` | 呼ぶだけ。新しい通知チャネルを作らない |
| 既存の `behavioral_events` INSERT経路 | `event_type`に`resource_offered`/`resource_clicked`を追加するだけ。第2のイベント送信経路・第2の訪問者IDを作らない |
| `src/agent/dialog/dialogAgent.ts` | `isLowIntentBrowsing()`を追加（§2.2参照）。新しいsales stageやオーケストレータ、LLM tool-calling基盤を作らない |

### 5.2 守るべき設計原則・命名規則・既存パターン

- **テーブル/カラム**: snake_case。`tenant_resources`（複数形、既存テーブルに合わせる）。カラム: `tenant_id`, `storage_path`, `external_url`, `file_type`, `moderation_status`, `moderation_reason`, `rights_confirmed`, `is_published`, `created_at`, `updated_at`。
- **ツール名**: 既存語彙の`動詞_目的語`snake_case。1件固定なので一覧系(`list_*`)ではなく単数`get_resource`/`upload_resource`/`delete_resource`。
- **migrationファイル名**: `migration_<機能>.sql`。`ADD COLUMN IF NOT EXISTS` + `COMMENT ON COLUMN`必須（`CLAUDE.md`明記のルール）。
- **リスク分類**: `confirmPolicy.ts`の定義に厳密に従う。`upload_resource`は`medium`（「永続コンテンツ（顧客が目にしうる実体）を作成・変更する。原理的には戻せるが、内容を作り直す必要がある」の定義に一致）。`delete_resource`は`high`（既存の全`delete_*`ツールと同じく不可逆な破棄）。
- **カード型の命名**: 既存の`weekly_summary`→`weeklySummary`パターンに倣い、サーバ`kind`はsnake_case→クライアントはcamelCase。Payload型は`Omit<XxxAgentActionCard, "kind">`で3層の重複定義を避ける。
- **i18n**: 内部語（`tenant_resources`, `moderation_status`等）をそのまま画面に出さない。`admin-ui/src/i18n/ja.ts`に`resource.*`キーを追加。
- **fail-open/fail-closedの向き**: 自動モデレーションはfail-open（`imageContentGuard.ts`に合わせる）。一方、著作権確認チェックボックスはハードゲート（チェック無しでは提出不可）。この非対称は意図的 — 自動判定はベストエフォート、人間の確認は必須。
- **公開の既定値**: 禁止5の精神に沿い、アップロード直後は`is_published=false`。モデレーション通過後、テナント自身の明示的な「公開する」操作で初めて`is_published=true`にする。モデレーションが「疑わしい」と判定した場合は自動的には公開させない。

### 5.3 やってはいけないこと

- 資料PDFのテキストをpgvector/Elasticsearchへ入れない。書籍取り込みの埋め込み・索引投入関数を資料アップロードのハンドラから一切importしない。
- `bookPdfUpload.ts`のバリデーション関数は再利用してよいが、`POST /v1/admin/knowledge/book-pdf`エンドポイント自体には資料PDFを送らない（書籍取り込みパイプラインに混入させない）。
- `tenantId`をリクエストボディから受け取らない（既存原則、JWT/APIキーのみ）。
- `storage_path`/`external_url`を`req.body`から無検証で保存しない。外部URLはURL形式検証に加え、内部IP/localhost/プライベートレンジを拒否する（SSRF対策）。
- `upload_resource`/`delete_resource`を`confirmPolicy.ts`に未分類のまま追加しない（`confirmPolicy.test.ts`が機械的に検出して落ちる）。
- widgetの資料カード描画で`innerHTML`を使わない（既存ルール、`textContent`/`createElement`のみ）。
- 1会話1回の頻度制御をLLMの応答文の文字列一致で実装しない（禁止3）。会話ターン数やセッションメタデータ等の構造化フラグで判定する。
- 資料提示の成否をLLMが生成した自然文の断定（「資料を提示しました」等）だけで判定しない。実際に構造化データ（`resourceCard`）が返された事実で判定する（禁止17と同じ理由）。
- モデレーションが「疑わしい」と判定した資料を自動削除しない。「不在」と「要確認」を同じ扱いにしない（禁止20と同型の区別）。確認導線を用意する。
- 資料オファーの成否判定を、既存Judgeの4軸評価（`psychology_fit`等）に無理に押し込まない。用途の違う指標を混ぜて数値の意味を破壊しない。
- E2Eで資料アップロード・削除等の書き込み経路を検証したことにしない（`e2eWriteGuard`はE2Eからの非GETを一律403にする設計。書き込みはバックエンド結合テストで端から端まで検証する）。

## 6. テスト観点

### 6.1 正常系

1. テナントが資料（PDF）をアップロードすると `tenant_resources` に1件作成され、`is_published=false`で保存される
2. 自動モデレーションが「問題なし」を返し、確認チェックボックスもチェック済みの場合、テナントの「公開する」操作で`is_published=true`になる
3. 会話中、確度が低いと判断されたターンでLLMの構造化出力に資料オファーが含まれ、`/api/chat`レスポンスに`resourceCard`が載る
4. widgetが`resourceCard`を受け取り、ダウンロードリンク付きのカードを表示する
5. 資料カードのクリックが`behavioral_events`に`resource_clicked`として記録される
6. 資料アップロード/資料DL発生時にテナントへ通知が作成される（どちらのタイミングにするかは着手時に確定し1本テストを書く）
7. Hermes/Judgeが`tuning_rules`に`resource_id`付きの提案（`is_active=false`）をINSERTでき、Copilot UIで承認すると`is_active=true`になり、以後のプロンプトに反映される

### 6.2 異常系・境界値

8. アップロードファイルがPDFでもURLでもない形式 → クライアント側で拒否、**サーバ側でも再検証**（クライアントのみのバイパス対策）
9. ファイルサイズが上限超過 → 拒否。上限ちょうど（境界値）は許可
10. 外部URLに内部IP/localhost/プライベートレンジを指定 → 拒否（SSRF対策）
11. Gemini API障害時の自動モデレーション → fail-openでアップロード自体は継続するが、`moderation_status`は「未検査」等の中間状態のまま残り、「通過」扱いにはしない
12. 著作権確認チェックボックス未チェックでの保存試行 → クライアントでボタン無効化、**サーバ側でも`rights_confirmed=false`のリクエストを拒否**（クライアントバイパス対策）
13. 1会話で既に1回資料オファー済みの状態で、LLMが再度オファーしようとする → サーバ側でガードし2回目の`resourceCard`を返さない
14. 資料が1件も登録されていないテナントの会話 → `resourceCard`を返さない（存在しない資料を提示しない）
15. 他テナントの`resource_id`を`tuning_rules.resource_id`に指定 → 外部キー制約 or アプリ側チェックで弾く/無視する（IDOR）
16. 2件目の資料をアップロードしようとする（1件固定） → UNIQUE制約 or 明示的な上書き確認のどちらかで一貫した挙動になっていることをテストで固定する
17. 壊れたPDF/パスワード付きPDFでテキスト抽出に失敗する → 「未検査」扱いにし、アップロード自体の成功/失敗を明確に返す（黙って握りつぶさない）

### 6.3 ユーザーがやりそうなイレギュラーな操作（最低10個）

1. アップロード中にブラウザタブを閉じる/リロードする → 中途半端なレコードが残らない
2. 同じ資料を連打でアップロードボタンを押す（二重送信） → 冪等キーまたはUIロックで2件生成されない
3. アップロード完了直後に「公開する」ボタンを連打する
4. 資料を公開した直後に削除し、直後にもう一度アップロードする（削除→即再作成の競合）
5. 複数タブ/複数デバイスで同時に別ファイルをアップロードする（最後勝ちか競合検出か、挙動を1つに決めてテストする）
6. 確認チェックボックスをチェック→アンチェック→チェックと繰り返してから送信する
7. モバイル（390px）でドラッグ&ドロップではなくファイル選択ダイアログから選ぶ（タッチ操作、44px以上のタップ領域）
8. アップロード中にネットワークが切断される（進捗表示が「失敗」で確定し、無限スピナーを残さない）
9. widget側で資料カードが表示された直後に会話を続けて別の質問をする（カードが古い状態のまま残るか消えるか、挙動の一貫性）
10. 資料カードのリンクを別タブで開いた後、元のチャットに戻って同じカードをもう一度クリックする（2回目のクリックイベント記録の扱い）
11. プライベートブラウズ/localStorage無効の状態でwidgetを使う（資料カード表示に影響しないことを確認）
12. super_adminがpreviewModeで他テナントの資料管理画面を開こうとする（テナントスコープの越境防止）
13. `external_url`にアップロード時点では生きていたが後から404になる外部リンクを登録する（クリック時404はwidget側でどう扱うか決めてテストする）

## 7. 受け入れ条件

**データ整合性・権限**
- [ ] 資料アップロード/削除/取得が `tenant_id` でスコープされ、他テナントから見えない（IDOR）
- [ ] 1テナントにつき資料は最大1件（DB制約または明示的な上書きロジックのどちらかで一貫）
- [ ] `tuning_rules.resource_id` が存在しない/他テナントのIDを参照した場合に安全に無視される

**公開ゲート**
- [ ] 著作権確認チェックボックス未チェックでは保存できない（クライアント・サーバ両方で強制）
- [ ] 自動モデレーション（テキスト抽出+LLM判定）がAPI障害時にfail-openで通過し、アップロード操作自体をブロックしない
- [ ] 自動モデレーションが「疑わしい」と判定した資料は自動公開されず、`moderation_status`で確認可能な状態になる

**顧客向け提示**
- [ ] widget側で実際に資料カードが表示され、クリックで遷移する（`productCard`の「バックエンド配線済み・widget未消費」の穴を繰り返さないことをE2Eで固定）
- [ ] 1会話で2回目の資料オファーが起きないことをテストで固定
- [ ] 資料が0件のテナントの会話では資料オファーが発生しない

**計測・学習ループ**
- [ ] `behavioral_events` に `resource_offered`/`resource_clicked` が記録される
- [ ] 資料の内容がpgvector/Elasticsearchに一切入らないことを確認するテスト
- [ ] Hermes/Judge由来の`resource_id`付き提案が承認後に本番プロンプトへ反映されることを実機/結合テストで確認

**Gate準拠**
- [ ] `pnpm verify`（typecheck/lint/test）がGreen
- [ ] `confirmPolicy.test.ts` が `upload_resource`/`delete_resource` の分類漏れを検出しないこと（正しく分類済み）
- [ ] 書き込み経路（アップロード・削除・公開）はE2Eではなくバックエンド結合テストで端から端まで検証されている

## 8. 決定事項サマリー（2026-09-05）

| 論点 | 決定 |
|---|---|
| PDF自動モデレーション | 導入する（テキスト抽出+LLM判定、fail-open） |
| `tuning_rules`拡張 | `resource_id`カラムを追加（構造化参照） |
| 資料の数 | 1テナント1件固定で開始 |
| リード獲得フォーム | 今回スコープ外。将来検討事項として明記のみ |

未決定は残っていない。次は実装計画（Asana子タスク化 → Planner起票）へ進める段階。
