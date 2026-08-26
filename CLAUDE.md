# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


# 運用体制(2026-05-28〜)

- **Claude Code CLI = 主担当**。調査/実装/Gate/PR/ログ/DB/VPS/grep/Playwright、実機作業すべて。Asanaタスクを自走で実装まで進める。
- **Claude.ai = サブ**。実機に触れない判断のみ。止めるのは4点だけ: ①merge可否 ②Codex結果(実害セキュリティ) ③Phase/スコープ方針 ④不可逆操作。
- **24hループ(Phase70)は2026-05-28に完全自走確定**（6罠攻略、PR #197/#217/#218/#219/#220/#221/#222）。Tier-S id=4 試運転中。
- CLIは段取り/設定/接続/worktree/調査/テスト/機械チェックで止まらず自走、結果のみ報告。

## セッション開始時の必須確認（毎回）

CLIは新セッション開始時に以下を確認・報告する（省略禁止）:
- `claude --version`（最新版との差分を確認）
- `claude plugin list`（導入済みプラグイン一覧）
- `.claude/skills/`・`.claude/agents/`・`.claude/hooks/` の現状
- 公式 changelog（https://code.claude.com/docs/en/changelog）から前回確認版以降の新機能を抽出
- 当日タスクに活用できる新機能・資産を能動的に提案する（確認だけで終わらせない）

# RAJIUCE CLAUDE.md

## Core Principles
1. **Security First** — Book content never leaves DB. Book-sourced RAG excerpts ≤200 chars(著作権保護。src/agent/config/ragLimits.ts の BOOK_EXCERPT_MAX_CHARS）。FAQ/learned_memory由来は別枠(FAQ_EXCERPT_MAX_CHARS)。API keys SHA-256 hashed. tenantId from JWT only.
2. **Mobile First** — Touch targets ≥44px. Font ≥16px. Test 390px viewport first.
3. **Partner Friendly** — No jargon. Every error = kind message. Every action = success feedback.

## チャットUI / 管理エージェント
詳細は配下の CLAUDE.md を参照: `src/api/admin/CLAUDE.md`（認可・SQL・ツール追加手順・計測）/ `admin-ui/CLAUDE.md`（面の役割分担・禁止事項・テスト）

## Definition of Done
- pnpm typecheck → 0 errors
- pnpm lint → 0 warnings
- pnpm test → all pass
- pnpm test:e2e → mobile viewport passes
- Codex Gate → P0/P1 none
- **追加した機能に到達する経路がある。** API を足したなら呼ぶUI/ツールが、ツールを足したなら
  呼ばせる導線が、同じPRに入っている。「後続PRでUIを繋ぐ」は**到達しないコードを本番に置くことと同義**
  （上の5項目は到達しないコードでも全て通る。実例は「絶対にやってはいけないこと」15）。
- **課金・請求に関わる変更は、本番（またはテストモード）で1周させるまで完了ではない。**
  `stripe_usage_reports.status='sent'` / `stripe_webhook_events.completed_at IS NOT NULL` /
  `usage_logs.billing_status='paid'` が**それぞれ1件以上**になることを確認する。
  「テストが緑」「デプロイ済み」は請求が成立したことを意味しない（→ 42・51）。

## Anti-Slop
- ragExcerpt.slice(0, 200) 必須
- tenantId: JWTまたはAPIキーから取得、bodyから禁止
- console.log(ragContent) 禁止
- 120Bモデル: 複雑クエリ/safety時のみ（比率 ≤10%）
- PII・書籍内容をメトリクスラベル/アラートメッセージに含めない

## Architecture Summary
- Widget: `public/widget.js` — 1行埋め込み、Shadow DOM、data-api-key 認証
- API: `src/index.ts` — Express + 4層セキュリティスタック (rateLimiter → auth → tenantContext → securityPolicy)
- CORS: グローバル適用 (OPTIONS preflight 対応)
- RAG: pgvector + Elasticsearch → Cross-encoder rerank → Groq 20B/120B
- Flow: clarify → answer → confirm → terminal (Phase22 State Machine)
- Sales: clarify → propose → recommend → close (SalesFlow Pipeline)
- Monitoring: Prometheus + Grafana + Slack AlertEngine (Phase24)
- Judge: Gemini 2.5 Flash → 4軸評価 → チューニングルール自動提案 (Phase45)
- Gap: 4トリガー → Gemini推薦エンジン → 知識追加 (Phase46)
- Book RAG: PDF → 6フィールド構造化 → pgvector + ES (Phase47)
- LLM Defense: L5 Input Sanitizer → L6 Prompt Firewall → L7 Topic Guard → L8 Output Guard (Phase48)
- Key endpoints / env vars: `docs/API_REFERENCE.md`

## プロダクトの目的とスコープ

R2C は、テナント（店舗・EC事業者）のサイトに1行で埋め込む **AI接客ウィジェット**（`public/widget.js`）と、
その運用を行う **テナント向け管理画面**（`admin-ui/`）からなる。

- **価値が生まれる地点**はエンドユーザーとの会話であって、管理画面の設定作業ではない。
  機能追加の是非は「テナントの顧客との会話が改善するか」で判断する。
- **管理画面はチャット・ファースト（`/copilot-preview`）へ移行中**。テナント向け旧UIページ（`/admin/*`）は
  段階的に閉じる（基準: `docs/LEGACY_UI_SUNSET.md`）。
- **旧UIは無くならない。** super_admin 向け運用面としては残り続ける。
  したがって「旧UIを消す」ではなく「**テナント向け**旧UIページを閉じる」が正しい目標。
- **「GUI固有だから」は面の外に置く理由にならない。** 面の外に残してよいのは
  「**見て・聴いて最終的に採否を決める瞬間**」だけ。何を出すか・どう振る舞うか・止めるかは会話に写せる。
  PDF取り込み（#585）とアバター（`docs/AVATAR_CHAT_MIGRATION.md`）は、この基準で分類を後から覆した実例。
- **ただし「誰の機能か」は別問題。** 書籍/PDFナレッジは **R2C 運用限定**であり、
  テナント向けチャットの守備範囲外（抜粋200字の著作権制約が「R2Cが投入内容を管理している」前提で成り立つため）。
  PDF取り込み（#585）は「GUI固有の壁は越えられる」ことの実証であって、テナントへの開放判断ではない。
- 別製品（R2C2 / aaas、DIA）とはコードを共有しない。Supabase認証と App Switcher のみ共有。

- **価値は「会話が改善し続けること」にある。** ただし 2026-08-24 の本番実測では、実ユーザーの会話は
  carnation **90 日で 13 件・平均 1.54 通・最長 2 通（＝1往復）**、Judge の評価下限 4 通に到達した会話は
  **0 件**。一方でチャットは **90 日で 1,516 回開かれている**。本番セッションの大半は E2E と
  空エスカレーションで、CV は会話と結合 0 件、`outcome` 記録は 1/1,041 だった。
  **機能を足す前に「その効果を測れる状態か」を必ず確認する。** 確認には ①フラグ
  ②**スキーマが本番に適用されているか** ③母数が存在するか の3つを含める
  （現状と要件: `docs/LEARNING_LOOP_REQUIREMENTS.md`）。
- **「AIに教えた」の対象が経路ごとに割れている。** RAG・`tuning_rules` を一切通らないのは
  Anam の `chat-stream` 経路のみ(既定で503封鎖)。`avatar-agent/` 自体はLLMを持たず
  `/api/chat` の回答をTTSするだけで、RAGにはこの `/api/chat` 経由で連動済み
  (詳細: `.claude/rules/knowledge.md`「アバターは知識経路を通す」)。
  「学習する」系を足すときは**どの回答経路に届くか**を必ず確認する。
- **「学習する」系の機能は、入口（会話→評価）と出口（承認→本番プロンプト）が繋がって初めて価値を持つ。**
  片側だけ作らない。Judge・提案・承認・A/B・Hermes はいずれも「完成済み」に見えて、
  1 箇所の配線欠落で全体が無効化された前例がある。

- **広告・ブランディング表示は収益源ではなく、獲得とアップグレードの動線である。**
  現規模の他社広告収入は1会話あたり円未満で、Starter→Growth のアップグレード1件が
  広告インプレッション約2万回分に相当する。したがって施策の成否は広告収入ではなく
  **アップグレード率**で判定する。「広告で稼ぐ」を目標に据えた設計をしない。
- **ウィジェット上の表示物は、エンドユーザー（テナントの顧客）にとっては価値ゼロである。**
  バッジも広告も、その人が得たいのは疑問の解決だけ。設計制約は「価値を提供する」ではなく
  **「どれだけ邪魔しないか」**。会話完了率の悪化は、施策の成否以前にプロダクトの毀損とみなす。
- **広告枠はテナントの資産であって R2C の資産ではない。** インプレッションが発生するのは
  テナントのサイト、見るのはテナントが集客した顧客。第三者広告は許諾と収益分配なしに出さない。
- **事業として成立する地点は「計上 → 倍率 → 請求 → 決済」が一周したときであって、機能が動いたときではない。**
  外部API利用は従量課金でテナントに請求される設計だが、2026-08-25 の実測では Stripe への請求送信が
  **サービス開始以来 0 件**、webhook 受信も 0 件、全テナントが `billing_enabled=false` だった。
  会話がいくら改善しても、この一周が繋がっていなければ収益は 0 のまま**無言で**推移する。
  課金に関わる変更は「計上を入れた」で完了とせず、**請求書が立ち決済されるところまで**を到達点とする
  （不変ルールは `.claude/rules/billing.md`、経緯と実測値は MEMORY.md の収益監査）。
- **価格は確定している。コードから導かない。** 2026-08-26 に価格を確定した
  （初期費用ゼロ / Starter 純従量 ¥20/会話 / **Standard ¥9,800** / Growth ¥29,800 / Enterprise 個別。
  いずれも年払いは 2ヶ月無料）。
  価格の水準は原価から機械的に決まらない。テキストの実測原価は 1 会話 ¥0.55 だが確定価格は ¥20（36倍）で、
  これは国内相場（中央値 月 ¥24,000）に合わせた**事業判断**であって原価×マージンの計算結果ではない。
  したがって **`MARGIN_RATE` を上げ下げして「値上げ/値下げした」と扱わない** —
  あれは原価表示用の係数であって、テナントへの請求単価ではない。
  根拠と採算検証は Asana 1217848935050634 と MEMORY.md の価格確定。**同じ調査を繰り返さない。**
- **初期費用は全プランで取らない（方針）。** 理由は ①一時収益は SaaS バリュエーションで倍率がかからず、
  同じ現金でも経常収益に乗せた方が企業価値への寄与が 5〜10 倍 ②購入意思が最高潮の瞬間に最大の壁を作る
  ③国内 26 社調査でも**初期費用の中央値は ¥0**。導入支援が必要になっても「**任意オプション**」に留め、
  必須にしてセルフサーブ導線を塞がない。固定費の前倒し回収は**年払い（2ヶ月無料）**が担う。
- **公開価格そのものが差別化要因である。** 国内 26 社中 14 社（54%）が月額を非公開。
  相見積もりを取る体力のない SMB にとって「サイトを見れば総額が分かる」ことに価値がある。
  したがって **LP の価格表記と実際の課金は一致していなければならない**（→ 禁止 54）。
- **アバターは R2C の唯一の差別化要因なので、段階的に開放する。** 国内にリアルタイム AI アバター接客 SaaS で
  公開価格を持つ直接競合は存在しない（2026-08-26 調査）。一方で海外のアバター系は ¥1,200〜7,800/月 の
  入門プランを普通に持つ。したがって **Standard（¥9,800）でアバター利用そのものを開放し、
  Growth 以上でアバターの自社カスタム作成を開放する**という二段構えを取る。
  固定費 ¥22,500/月 はテナント数で割るため、**安いプランで頭数が増えると全員の按分負担が下がる** —
  入門プランは値引きではなく、既存 Growth の採算も改善する施策である
  （Growth 2社のみ：総粗利 ¥19,400/月 → Standard 3社追加：総粗利 ¥42,830/月）。

## 管理UIの構造（チャット・ファースト移行中の不変ルール）

チャットUIは現在 3 実装ある。**これ以上増やさない。**

| 面 | 実体 | 位置づけ |
|---|---|---|
| Surface B（全画面） | `admin-ui/src/pages/copilot-preview/` | **主面**。新機能はここに入れる |
| Surface A（パネル） | `admin-ui/src/components/AdminAgent/` | **機能凍結**。旧UIページ閉鎖に合わせて畳む（`docs/CHAT_SURFACE_DECISION.md` 推奨(c)） |
| テストチャット | `admin-ui/src/pages/admin/chat-test/` | GUI固有。移植対象外 |

- **`/copilot-preview` はテナント専用UI。** super_admin 専用機能をここに足さない
  （PR #507 で誤追加の 11 ツールを撤去した経緯がある）。
- パネルに新機能（カード・チップ・レール・ブートストラップ）を移植しない。共有層のバグ修正は対象外＝行ってよい。

## 実装の置き場所（新規ファイルを作る前に必ず読む）

**共有済みの層を再実装しない。** 過去に「正しい実装が同リポジトリにあるのに再利用されず、
日本語入力が約13日間壊れた」事故がある（`docs/CHAT_SURFACE_DECISION.md` §3.1）。

| やりたいこと | 置き場所（既存） |
|---|---|
| チャット送信・sessionId・履歴窓・`targetTenantId`・エラー文言 | `admin-ui/src/lib/useAgentChatTransport.ts` |
| 会話の保存・復元 | `admin-ui/src/lib/chatSessionStore.ts` |
| Enter送信・IME合成の扱い | `admin-ui/src/lib/utils.ts` の `shouldSubmitOnEnter` |
| 構造化カードの追加 | **3層すべてに同じフィールド形状を書く**（サーバ／フロントの境界を跨ぐため型を共有できず手動同期）。①`actionExecutor.ts` の `*CardPayload` 型 + `ActionCardPayload` union ②`admin-ui/src/lib/useAgentChatTransport.ts` の `AgentActionCard` union ③`copilot-preview/index.tsx` の `Card` union + `a.card?.kind === "..."` の変換分岐。`kind` のみ **サーバ snake_case → クライアント camelCase** に変換し、他は `Omit<XAgentActionCard, "kind">` で再利用して二重定義を避ける（`weekly_summary` → `weeklySummary` が基準）。**1層でも漏れると型は通るのに描画されない。** |
| エージェントのツール追加 | `src/api/admin/agent/toolDefinitions.ts` + `actionExecutor.ts` の `switch` に `case` + `copilot-preview/index.tsx` の `REAL_TOOL_LABEL`（**この3点セット**。ラベル漏れは生の英語ツール名が画面に出る。**網羅性・陳腐化・重複は `confirmPolicy.test.ts` が機械検査済み**。同テストは未文書化の4点目 `REAL_WRITE_TOOLS` も双方向で検査する） |
| ファイル添付（コンポーザの📎／ドラッグ＆ドロップ） | `admin-ui/src/lib/bookPdfUpload.ts` の検証 + `pdfUpload` カードの進捗表示を拡張。**第2の添付経路を作らない** |
| ツール内でのプラン機能判定 | 注入済み `db` に `queryTenantPlan` + `planHasFeature`。`tenantHasFeature` は内部で `getPool()` を呼び、テストのモックPoolと食い違う |
| 確定前の下書き・生成候補の保持 | 実体テーブル（例 `avatar_configs`）。**プロセス内 Map（`knowledgeImportStaging` 型）を新設しない** — 面をまたぐ／リロードでTTL失効し孤児化する |
| 書き込みツールのリスク分類 | `src/api/admin/agent/confirmPolicy.ts`（未分類は `confirmPolicy.test.ts` が検出して落ちる。**同テストは `actionExecutor.ts` と `copilot-preview/index.tsx` を readFileSync して検査するため、両ファイルのパス・変数名を変えるとテストが例外で死ぬ**） |
| 設定変更の監査記録 | `src/api/admin/agent/agentAuditLog.ts` → 既存 `tenant_settings_history`。**新テーブルを作らない** |
| ツール実行の計測 | `agentRoutes.ts` にのみ実装。`actionExecutor.ts` の各 `case` には手を入れない（`docs/AGENT_METRICS.md`） |
| テナント設定の取得・更新 | `GET/PATCH /v1/admin/my-tenant`（`src/api/admin/tenants/routes.ts`） |
| 汎用UI部品（ページネーション・検索窓・期間フィルタ・通知ベル） | `admin-ui/src/components/common/`。**`components/ui/` は存在しない**（shadcn/ui 未導入）。使う前に必ず grep する |
| テナント/運用者への通知 | `src/lib/notifications.ts` の `createNotification`（`recipientRole` は `super_admin` / `client_admin` 両対応、`recipientTenantId` を必ず添える）。ベル・既読・スコープはAPI側に実装済み。**`notification_preferences` は保存されるだけで誰も読んでいない** |
| DB列追加 | 機能ディレクトリ内に `migration_<機能>.sql`。`ADD COLUMN IF NOT EXISTS` + `COMMENT ON COLUMN` で意味を明記 |
| 日付・週境界の計算 | `src/lib/date/weekRange.ts`（JST暦週。UTCベースの算術のみで実装し process TZ に依存しない）。詳細: `docs/WEEKLY_SUMMARY_REQUIREMENTS.md` |
| 有人対応（エスカレーション）の会話取得・返信 | `src/api/admin/chat-history/` の `getMessages` / `saveMessage`。取得経路を増やさない（FAQ書き込み経路(10系統。`.claude/rules/knowledge.md`)と同じ轍を踏まない）。契約は `src/api/admin/CLAUDE.md` |
| プラン制限のフロント判定 | `admin-ui/src/lib/planFeatures.ts`（`planHasFeature` / `GatedFeature`）。ページごとに403判定を書かない |
| CORS の許可ヘッダ | `src/lib/cors.ts` の `ALLOWED_HEADERS`（単一情報源。第2の許可リストを作らない） |
| 承認状態の判定・更新 | **`is_active` が唯一の真実**、`status` は承認判断の記録。両方を書くのは `approveTuningRule` / `rejectTuningRule`（`src/api/admin/evaluations/evaluationsRepository.ts`）と `updateRule`（`src/api/admin/tuning/tuningRulesRepository.ts`）の3点のみ。呼び出し側や LLM プロンプトに整合性を委ねない |
| 本番プロンプトへのルール注入 | `tuningRulesRepository.ts` の `getActiveRulesForTenant` / `buildTuningPromptSection`（唯一の入口） |
| 会話の自動評価 | `src/agent/judge/judgeEvaluator.ts` の `evaluateSession` のみ。**第2の Judge 実装を作らない**（評価軸が割れてスコアが比較不能になる） |
| 定期実行 | `src/index.ts` の既存 `setInterval` 群（AlertEngine / pipelineQueue self-heal と同じ場所・同じ形）。cron / launchd / 新プロセスを増やさない |
| 「どのルール・どの variant が効いたか」の記録 | 既存 `chat_messages.metadata`（`rag_hit_count` と同じ場所）。**新テーブルを作らない** |
| LLM 由来の改善提案の着地先 | 既存 `tuning_rules`（`source='judge' \| 'hermes'`、`is_active=false`）。提案元ごとにテーブルを増やさない |
| ページ行動・訪問者の文脈 | 既存 `behavioral_events`。**第2のイベント送信経路・第2の訪問者 ID を作らない**（`/api/chat` は `visitor_id` を受信済み） |
| テスト流量の除外 | `src/api/admin/analytics/summaryQueries.ts` の `userSourceClause` / `userSourceExists` のみ。`metadata->>'source'` の判定文字列を各所に書かない |
| プラン段の追加・変更 | **4点セット**。①`src/lib/billing/planFeatures.ts`（`TenantPlan` / `PLAN_RANK` / `FEATURE_MIN_PLAN`）②`admin-ui/src/pages/admin/tenants/types.ts` の `PLAN_OPTIONS` ③`src/lib/billing/planPricing.ts` の `PLAN_MULTIPLIERS`（**`stripeSync.ts` にはもう無い。re-export も置かない**）④`tenants.plan` の CHECK 制約 migration と**その本番適用**。**1つでも漏れると型は通るのに請求・表示・INSERT のいずれかが割れる**（`PLAN_MULTIPLIERS` の欠落は `?? 1.0` に落ちて満額請求、CHECK 未適用は本番だけ DB エラー） |
| 請求数量・請求予定額の算出 | `src/lib/billing/stripeSync.ts` の `computeExpectedBilling`（**唯一の集計式**。Stripe送信も突合ジョブも画面も同じ関数を通す。集計SQLを書き写すと、突合が「両方とも同じバグを踏んでいるだけ」になる） |
| 1リクエストの単価・プラン倍率 | `src/lib/billing/planPricing.ts`（純粋な値と純粋関数のみ。`usageTracker` が最高トラフィックの書き込み経路から参照するため、Stripe連携モジュールに依存させない） |
| 金額の表示整形 | `admin-ui/src/pages/admin/billing/utils.ts`。**単位ごとに別関数**（USDセント用と JPY 用を同じ関数で扱わない → 48） |
| ウィジェットの表示物（バッジ・ブランディング・告知） | `src/api/widget/widgetGenerator.ts` の設定注入 + `public/widget.js` の既存 Shadow DOM 構築部。**第2の埋め込み経路・第2のウィジェット実装を作らない**。`innerHTML` 禁止（`textContent` / `createElement` のみ） |
| ウィジェット由来の外部遷移・クリックの計測 | 既存 `behavioral_events`（`/api/chat` は `visitor_id` を受信済み）。`chat_sessions.metadata.source`（`trafficSource.ts`）は**会話の分類契約**であり、クリック計測の置き場所ではない。lane-plans と共有のため変更は team-lead に相談 |

**新規ファイルを作ってよいのは**、テスト可能な純関数として切り出す場合のみ。
その場合も `confirmPolicy.ts` / `agentAuditLog.ts` と同じ粒度・同じディレクトリに置き、隣に `*.test.ts` を作る。

**ナレッジ配線(`src/search/**` / `src/lib/knowledge/**` 等)を触るときは `.claude/rules/knowledge.md` が
自動ロードされる。** 読み側の可視性述語の場所、書き込み経路の実数、索引同期の正典ヘルパはそちらが一次情報。

## 指示ルール（tuning_rules）の不変ルール

エンドユーザーへの応答方針を決める唯一のテナント設定。**壊れても画面に何も出ないため、事故が沈黙する。**

**3層の役割分担を混ぜない**

| 層 | 役割 | 破ってはいけないこと |
|---|---|---|
| FAQ / 知識データ（RAG） | **事実の単一情報源** | 他層の記述が事実と矛盾しても、事実はこちらを正とする |
| `tuning_rules.expected_behavior` | **方針**（どう振る舞うか） | 事実の格納場所として使わない（「保証は2年」はFAQへ） |
| `tuning_rules.approved_responses` | **文体・言い回しの見本** | 逐語コピーを強制しない。事実を上書きさせない |

**置き場所（単一実装。2箇所目を作ると旧UIとチャットで挙動が割れる）**

| やりたいこと | 置き場所（既存） |
|---|---|
| ルールの発火条件の判定 | `src/api/admin/tuning/triggerMatching.ts` の `matchesTriggerPattern` |
| ルールのプロンプト注入 | `src/api/admin/tuning/tuningRulesRepository.ts` の `buildTuningPromptSection` |
| 優先度の3段階表現 | `admin-ui/src/lib/tuningPriority.ts`（閾値・代表値を他所に書かない） |

**既知の破れ（是正前に触るなら前提を確認する）**: 自動生成ルールの無断有効化 / 採用済み返答が回答生成に未到達 /
一致判定が半角カンマ区切りの部分一致のみ / ツール結果500字打ち切りによる一覧欠落 /
**`approved_at` を書くのは `approveTuningRule`・`rejectTuningRule`（`evaluationsRepository.ts`）のみで、
チャット経由の `updateRule` は書かない。** 前者のエンドポイント自体は `super_admin` / `client_admin`
双方に開いているが（`evaluations/routes.ts` の `ALLOWED_EVALUATION_ROLES`）、呼び出す旧UI
（`AIReportTab.tsx` / `SuggestedRulesCard.tsx`）が super_admin 限定のため、店主が実際に使える唯一の
承認経路（チャット）だけが承認時刻を残さない。`approved_at` を before/after の境界に使う効果測定
（`analytics/ruleEffect.ts`）は、チャット承認したルールを永久に「未承認」として扱う。
詳細と受け入れ条件: `docs/TUNING_RULE_CHAT_REQUIREMENTS.md`

## 学習ループの不変ルール

「使うほど賢くなる」を支える経路。**壊れても画面に何も出ないため事故が沈黙する**点は指示ルールと同じ。

**点火の3条件（1つでも欠けると、エラーなしで何も起きない）**

| 条件 | 確認方法 | 欠けたときの見え方 |
|---|---|---|
| ①フラグ | `tenants.features`（env は緊急停止用途に限る → 禁止41） | 機能が無効。ただし画面からは分からない |
| ②スキーマ | 実行中の DB に列が存在するか（→ 禁止42） | **記録だけが静かに落ちる。エラーは出ない** |
| ③母数 | 評価・集計の下限を満たす会話が存在するか（→ 禁止43） | 全て 0 件。フラグを疑っても直らない |

**表示の既定は「空」である。** 学習系の数値は当面ほぼ全て 0 件または「判定に足りない」から始まる。
空は例外ではなく**既定の状態**として設計する。0 は 0 と書き、母数が足りないときは比率・矢印・
「効果なし」を出さず**到達条件**（現在 N 件 / 必要 N 件）を出す（→ 禁止34）。
「学習しています」を出した瞬間それは営業上の主張になる。**0 を 0 と表示できない設計にしない。**

**提案の出所を必ず伴わせる。** `source`（judge / hermes / manual）と根拠の会話を示さずに承認させない。
承認は `is_active` を立てる行為であり、**本番の応答方針が変わる**（→ 禁止29・33）。

## 絶対にやってはいけないこと

1. **`tenantId` を client 由来（request body / query / `x-tenant-id` ヘッダ）から取る。**
   常に認証済み `req.tenantId`（JWT の `app_metadata.tenant_id` / APIキー）からのみ取得する。
   `x-tenant-id` ヘッダは読まない。書き込みの宛先を `body.target` で受けない。
   super_admin の `targetTenantId` は `isSuperAdmin` ガード下でのみ有効、という既存条件を変えない。
   （2026-08-22 監査で `agentSearchRoute.ts` がヘッダ信用で越境read、`knowledge/routes.ts` の commit が
   `body.target` で越境write していた。姉妹の `agentDialogRoute.ts` は `req.tenantId` を使う正しい実装）。
2. **共有済みの層を手書きでコピーする**（transport / IME / セッションストア / 確認ポリシー）。
3. **フローの分岐を LLM の応答文の文字列一致で新規に作る。**
   既存3箇所（確認ブロック判定・監査の `successMarker`・計測のブロック判定）は現状維持するが、
   **新規はここに乗せない**。構造化データで判定する。
4. **確認ゲートを迂回する書き込み経路を作る。** 新しい書き込みツールは必ず `confirmPolicy` に分類する。
5. **エンドユーザーに出る内容を、テナントの確認なしで公開する。**
   テンプレート・自動生成の知識は `is_published = false` で投入し、確認後に公開する。
   **指示ルールも同じ**: AI が自動生成した `tuning_rules`（Judge 由来）は必ず `is_active = false` で INSERT する。
   列を省略するとスキーマ既定 `DEFAULT true` が効いて即座に本番の応答方針へ入る（`src/agent/judge/evaluationAnalyzer.ts` は現在この通り `is_active = false` を明示している。省略する変更をしない）。
   逆に `migration.sql` の `DEFAULT` 自体は、既存データへの影響を評価せずに変えない。
6. **同じ関心事を2ファイルに複製したまま片方だけ直す。**
   既知の重複: 業種テンプレ（`src/api/admin/agent/industryFaqTemplates.ts` と
   `admin-ui/src/components/onboarding/industryFaqTemplates.ts`）。増やさない、直すときは必ず両方。
   **FAQ書き込み経路は実際には10系統ある**（4系統ではない。内訳と索引同期の正典ヘルパは
   `.claude/rules/knowledge.md` 参照）。**11系統目を作らない。**
7. **ユーザー単位・テナント単位の進行状態を localStorage に持つ。** ブラウザを変えると消える。サーバが正。
8. **DB migration を自動実行する。** 不可逆操作は人間承認（24h自走中は禁止項目）。
9. **オンボーディング等の作業フロー中に、同タブで旧UIへ遷移させる。** 会話と進行が飛ぶ。別タブ固定。
10. **費用が発生する操作を、使用量を計上しないまま／費用が出ると伝えないまま会話に開放する。**
    外部APIの呼び出しは従量課金でテナントに請求される設計なので、`trackUsage` 漏れは請求漏れ（当社負担）になる
    （実例: `falGenerationRoutes.ts` が未計上）。回数上限で止めるのではなく、**計上を必ず入れる**ことと、
    会話は「もう1回」のコストが低いため**費用が発生する旨を実行前に伝える**ことの2点で守る。
11. **プラン制限の案内を同一会話で繰り返す。** 制限に当たった瞬間だけ、1会話1回（PR #580 で是正済み）。
12. **ツールの成功文言に確認ゲートの言い回し（「確認が必要です」「確認をスキップできません」等）を混ぜる。**
    計測もフロントのチップ表示も結果文字列の部分一致で判定しているため、正常応答が `blocked` として数えられる
    （`docs/AGENT_METRICS.md`。`get_embed_code` で実際に踏んだ）。
13. **`isSuperAdmin` でテナント向け機能を出し分ける。**
    `useAuth.tsx` の `isSuperAdmin` は previewMode 中に false へ落ちる。
    super_admin が `/copilot-preview` を使うには previewMode に入るしかないため、
    `isSuperAdmin && ...` で隠した機能は**R2C運用者自身からも消える**。
    運用者に残す機能の判定は生の `user?.role === "super_admin"` を使う（前例: `components/dashboard/CVUnfiredAlert.tsx`）。
14. **機能ゲートをUI側だけに置く。** 画面から消しただけの制限は、API直叩き・ブックマーク・
    会話履歴に残った旧UIリンクの再クリックで破られる。**サーバ側の role/plan ガードを必ず同じPRに含める**
    （前例: `pre_dispatch` の Enterprise 制限がUIのみで `livekitTokenRoutes` に強制が無かった）。
15. **動線として閉じていないツールを足す。** 一覧を返す手段が無いのに id 必須の `activate_avatar` だけがある状態は、
    チャットからは実行不能で「あるのに使えない」。ツールは**ユーザーが会話だけで完了できる単位**で追加する。
    **同じことが API と UI の間でも起きる。** `GET /v1/admin/analytics/rule-effect/:ruleId` は
    DiD推定・信頼区間・母数ゲートまで実装され全テスト緑のまま、`admin-ui` 側に呼び出しが1件も無い状態で
    マージされた（PR #869）。**「作った」と「届いた」は別。** 実装前に「誰がどの画面から呼ぶか」を
    1行で答えられること（Definition of Done の到達可能性）。
16. **`AT TIME ZONE` を片側だけ書く。** `timestamptz` カラムとの比較は往復変換が必須。
    サーバTZ依存の実装は**本番でのみ実際の時刻とズレ、数値はもっともらしく出るため気づけない**
    （`src/lib/date/weekRange.ts` は process TZ に一切依存しない実装で、この事故を回避している）。
17. **チャットに出す集計値をLLMの生成文のまま表示する。** 数値・期間・件数はサーバが構造化データ
    （card）として返し、LLMは解釈・提案のみを担う。丸め・省略・語り換えが構造的に起こり得るため
    （例: `get_weekly_briefing`。詳細: `docs/WEEKLY_SUMMARY_REQUIREMENTS.md`）。
    `text` と `card` は**同一オブジェクトから組み立てる**（2箇所で計算すると必ず食い違う）。
    **既知の違反**: `get_analytics_summary` / `get_conversion_summary` / `get_monitoring_summary` は
    数値を扱いながらカード化されておらず自然文のみを返す（是正対象）。新しい数値ツールはこれらに倣わない。
18. **チャットUIからバックエンドを直接fetchする経路を足すとき、previewMode中のテナントスコープ
    (`?tenant=`)を載せ忘れる。** エージェントツール経由の呼び出しは `targetTenantId` が自動で載るが、
    直接fetch（`generateAvatarCandidates`・`matchAvatarVoice`・`uploadUrl`のような、500字制約や
    外部API呼び出しでツール経由にできない処理）は自分で載せる必要があり、この非対称を知らないまま
    新しい直接fetch経路を足すと静かに漏れる。載せ忘れると、費用と保存先が操作対象テナントではなく
    super_admin自身の（空の）テナントに紐づき、画面上は正常に見えるためQAで気づけない
    （実例: `falGenerationRoutes.ts`/`generationRoutes.ts` の生成系4ルート。
    `escalations`/`tuning`/`knowledge`/テストチャットでも過去に同根の修正が4回ある再発パターン。
    PR #481/#483、および #P0-1〜#P0-3）。
19. **アバター表示を「時間経過」で自動的に隠す機構を作らない（再導入も禁止）。**
    LemonSlice セッションは UI を隠してもサーバ側 idle_timeout(300s) まで課金され続けるため、
    時間ベースの自動非表示は必ず「見せないのに払う」状態を作る。33秒非アクティブ折りたたみは
    #424→#740→#742 と3度周辺修正を重ねても再発し続け、PR #743 で機構ごと削除した。
    大表示のライフサイクルは「ユーザーが閉じる / 接続失敗 / セッション実終了」のみに従う。
    セッション実終了（TrackUnsubscribed）時は暗転ではなく静止画（`lastAvatarImageUrl`）へ戻す
    — 空の暗い領域は利用者に「消えた」と映り、同系統の再発報告になる。
    **診断の教訓**: 表示系の「消える/切れる」報告は体感秒数から原因を推測しない。
    250ms サンプラで DOM（表示状態・要素有無）+ MediaStreamTrack（live/muted）+
    LiveKit Room（state/publication）を同時記録してから直す（推測ベースの修正で
    2度誤った実績がある。手順は `MEMORY.md` の該当 trap を参照）。
20. **「存在しない」と「空」を同じ値で表現する。**
    `getMessages()` が「セッション不在」と「本文0件」の両方で `[]` を返していたため、
    呼び出し側が区別できず、対応中の会話253件すべてが404になった（返信自体は技術的に可能なのに、
    画面が「会話の取得に失敗しました」を出し続けてオペレーターが手を止める）。
    不在は `null`、在るが0件は `[]` のように**型で区別**し、呼び出し元は両方を明示分岐する。
    ただし**テナント越境だけは必ず「不存在」側に倒す**（`[]` を返すとIDの実在が漏れる）。
21. **HTTPステータスの意味を潰して1つの文言にまとめる。**
    `tenants/[id].tsx` が catch で全エラーを握り潰し、**500を「テナントが見つかりませんでした」**
    と表示していたため、サーバ障害の切り分けが丸ごと遠回りになった。
    401/403/404/500 は画面文言と次の行動を分ける。とくに
    **403 `plan_upgrade_required` は「エラー」ではなく正常系の分岐**であり、赤帯にしない・
    「0件」と描画しない（403なのに「合計成約数 0」を出すと、テナントは計測が動いていると誤解する）。
22. **クライアントが送るヘッダを、サーバの許可リストに足さずに増やす。**
    `playwright.config.ts` の `x-r2c-traffic-source` が `src/lib/cors.ts` の `ALLOWED_HEADERS` に無く、
    **admin-ui の全 fetch がプリフライトで落ちていた**。ドキュメント読み込みは素通りするので
    画面は出てデータだけ載らない — 最も気づきにくい形で壊れ、E2Eは「動いているのに何も見ていない」
    状態になる。送出ヘッダを増やす変更は `ALLOWED_HEADERS` への追加と**必ず同じPRに含める**。
    逆に、指標汚染防止のために入ったヘッダを**消す方向で直さない**。
23. **本番DBスキーマとコードのズレを、アプリのエラーメッセージだけで判断する。**
    `ADD COLUMN` 系 migration の未適用は「取得に失敗しました」という一般文言でしか現れず、
    **一覧APIは200のまま詳細APIだけ500**になる（`GET /v1/admin/tenants` は通り、
    `GET /v1/admin/tenants/:id` と `/v1/admin/my-tenant` だけが落ちた）。
    500を見たら、**成功しているクエリとの SELECT 差分列**を取り、該当 migration ファイルを
    特定してから直す。コード側で列を削って回避しない。適用は人間承認（→ 8）。
    共有APIの障害は「1画面の故障」ではなく「全画面の仕様変更」として扱う
    （`my-tenant` の500で `AppSidebar.tsx` の `planHasFeature(null, …)` が全テナントから
    プラン機能メニューを静かに消していた）。
24. **tenant 述語のない SQL / 検索クエリを書く。** 非 super_admin の list / update / delete / 検索で
    `WHERE tenant_id = $自テナント` を欠くと越境になる。`:id` 系は取得・更新・削除のいずれでも
    所有チェック（`AND tenant_id = $自テナント`）を必須にする（IDOR）。DB に RLS は無く、API は
    Postgres superuser 接続なので、**テナント境界は各ルートの手書き `WHERE` が唯一の防壁**。
    1 箇所の欠落がそのまま全面リークになる（監査で tuning / evaluations / chat-history の
    `resolve-escalation` 等に欠落を確認）。全 admin ルータに `roleAuthMiddleware`
    （client_admin の tenant 空を 403 に倒す）を配線し、リポジトリは「`null`=super_admin のみ許容」の
    明示スコープにする。「`isSuperAdmin ? undefined : jwtTenantId || undefined`」で空 tenant を
    super_admin と同じ undefined に潰さない。
25. **セッション / キャッシュ / インメモリ Map をテナント非スコープでキー付けする。**
    対話履歴・abuse カウンタ等は必ず `${tenantId}::${sessionId}` でキー付けする
    （正例 `salesContextStore.ts`。違反例 `contextStore.ts` は生 `sessionId` のみで越境リークした）。
    `sessionId` はクライアント任意文字列なので、別テナントが同じ値を送れば履歴を相互参照できる。
26. **認証を fail-open にする。** `SUPABASE_JWT_SECRET` 未設定で素通し（warn だけで next）や、
    `NODE_ENV==="development"` で `jwt.decode` のみの署名スキップを残さない。production では secret 必須で
    fail-fast、それ以外でも secret 未設定は 503。`jwt.verify` は `algorithms:['HS256']` を固定し、
    `aud` / `role` / `purpose` を検証する。**tenant 不明の JWT を `"demo"` テナントに落とさない**（401 にする）。
    ロール検査のない管理ルート（「認証済みなら通す」だけ）を作らない。
27. **公開配布物と管理 API で同じ署名鍵を使う。** widget が配布するセッショントークンは
    管理用（Supabase）とは別 secret（`WIDGET_JWT_SECRET`）で署名し、`purpose` クレームで用途を固定する。
    `SUPABASE_JWT_SECRET` で署名した任意トークン（widget の `_wt`、admin-ui バンドル同梱の Supabase anon key、
    chat-test トークン）が Bearer として管理面に届く状態を作らない。`"widget-secret-dev"` の
    ハードコードフォールバックを残さない。
28. **レートリミッタを認証前・全テナント単一バケットで運用する。** 認証前は nginx 注入の `X-Real-IP` を
    キーにした IP リミッタ、認証後は `tenantId` をキーにしたテナント別リミッタの 2 段にする。
    `req.tenantId ?? "anonymous"` の単一バケットにすると、攻撃者 1 人の flood で全テナントの
    ウィジェットが 429 になり、マルチテナント SaaS として成立しない
    （`trust proxy` 未設定のため `req.ip` は常に 127.0.0.1。IP キーには `X-Real-IP` の採用が必要）。
29. **承認状態を 2 つの列で二重管理したまま片方だけ直す。**
    `tuning_rules` は `is_active`（本番に効くか）が唯一の真実、`status` は承認判断の記録。
    不変条件は `status='active' ⇒ is_active=true` / `status='rejected' ⇒ is_active=false`。
    承認 API が `status` だけを更新していたため、**承認したルールが本番に一生入らない**状態が続いた
    （`getActiveRulesForTenant` は `is_active` しか見ない）。逆に却下 API は `is_active` を下げないため、
    却下済みルールが注入され続ける。効力を持つ列を新設するときは、**どちらが真実かを先に決めてから**書く
    （先例: `src/lib/sai/saiTaskRulesRepository.ts` は「tuning_rules で status と is_active が
    同期していなかった反省を踏まえた設計」と明記している）。
30. **費用が発生する定期処理を、多重起動しうる形で登録する。**
    同一対象の二重処理はそのまま二重課金になる。`intervalId` の二重登録ガードに加えて
    **tick の重なりガード（`isRunning`）**を必ず入れる（既存の metricsFlush / alertEngine には無い）。
    `instances: 1` はデプロイ規約であって不変条件ではない（手動起動・blue/green の重なりで破れる）。
31. **提案の受け皿（承認インボックス）を増やす。**
    既に judge 提案 / evaluation の `suggested_rules` / `knowledge_gaps` / Hermes 提案の 4 系統が
    並列に存在し、Hermes だけ UI が無い。新しい提案元を足すときは**既存の着地先に合流させる**。
    専用テーブル・専用画面・専用通知先を作らない。
32. **効果計測のために新テーブル・新しい計測基盤を作る。**
    `chat_messages.metadata` と既存 analytics で足りる。「効いたか」を見える化するのが目的であって、
    基盤の刷新ではない。
33. **外部・LLM 由来のテキストを、防御層（L5 Input Sanitizer / L6 Prompt Firewall）を迂回して
    システムプロンプトへ入れる。** Hermes 提案・Judge 提案・採用済み返答はいずれもテナント外／
    モデル由来の入力面。**人が承認した後も同じ**。承認は注入経路の免罪符ではない。
34. **計測の土台が壊れたまま「効果が出た／出ない」を数値で出す。**
    母数が E2E と空セッションで汚染されている状態の比率は、参考値としても表示しない。
    母数不足のときに `0` や矢印（↑↓）や「効果なし」を出すと、誤った自信を与える
    （`src/api/admin/analytics/routes.ts` は分母 1 でも trend を出している。是正対象）。
35. **会話の振る舞いを変える機能を、全テナント一斉に有効化する。**
    本番トラフィックの 98% が実顧客 1 社に集中しているため、「1 テナントで観察」は
    実質「全ユーザーで本番投入」を意味する。`tenants.features` のフラグで段階的に開け、
    自社テナント（`r2c_default`）とテストチャットで目視してから実顧客に開く。
36. **A/B variant の割当をセッションに固定しないまま統計を出す。**
    1 会話が複数 variant にまたがると勝敗判定が無意味になる。割当は `sessionId` で固定し、
    `chat_sessions.prompt_variant_id` に必ず記録する（記録しないと統計が常に空になる）。
37. **`starter` より下のプラン段を足すときに、fail-safe の落とし先を直さない。**
    `planFeatures.ts` は「取得失敗・未設定時は最も制限の強い段」を不変条件として
    3 箇所で `starter` に倒している（`rank()` の `?? PLAN_RANK.starter` / `queryTenantPlan` の
    allowlist / その `catch` 返り値）。最下段を入れ替えると、この 3 箇所が
    **DB 障害時に無料テナントを Starter へ「昇格」させる経路に反転する**。
    型チェックもテストも通り、障害時にしか発現しないため気づけない。
    プラン段を増やすときは**必ず 3 箇所を同時に直し、3 箇所それぞれにテストを書く**。
38. **ウィジェットの配布経路が 2 系統あり、24 時間キャッシュされる事実を無視した設計をする。**
    ①`GET /widget/:tenantSlug.js`（`src/api/widget/routes.ts`）— テナント設定を注入する動的版。
    ②`public/widget.js` + `data-tenant` 属性 — プラン判定を一切経由しない静的版。
    さらに①は `db === null` のとき②へ**リダイレクトする**。
    プランに依存する表示・制限をウィジェットに足すときは、**この 3 経路すべてで意図した挙動になるか**を
    先に確認する。②と③は `planFeatures.ts` の fail-safe 思想と**逆向きの fail-open** である。
    加えて①は `Cache-Control: public, max-age=86400` のため、
    **プラン変更の反映に最大 24 時間かかる**。即時反映を前提にした仕様・文言を書かない。
39. **原価の負担者が R2C 側に反転する機能を、利用量の上限なしで開放する。**
    通常の外部 API 利用は従量課金でテナントに請求されるため「回数上限で止めるのではなく計上を必ず入れる」が
    原則（→ 10）。**無料プラン・広告原資プランはこの原則の唯一の例外**で、原価を当社が負担するため
    上限が無いと青天井になる。かつ**請求ゼロでも `trackUsage` は必ず通す** —
    `usage_logs.cost_total_cents` に残らないと赤字が不可視になる。
    上限はサーバ側で保持する（クライアント保持は → 7）。月次境界は
    `src/lib/date/weekRange.ts` に倣い process TZ に依存しない実装にする（→ 16）。
40. **エンドユーザーに出す宣伝・広告表示を、AI の発話文やアバターの音声に混ぜる。**
    景表法ステマ規制（2023-10-01 施行）は AI キャラクター・バーチャルヒューマンを明確に対象とし、
    EU AI Act 第 50 条の透明性義務は 2026-08-02 から執行済み。
    宣伝表示は **AI の回答テキストとは構造的に分離した DOM** として出し、
    **文面を LLM に生成させず入稿値をそのまま描画**し、**アバターの発話経路に一切繋がない**。
    多数のテナントサイトから張る外部リンクには `rel="nofollow sponsored noopener"` を付ける
    （付けないと Google の link scheme に該当し、ペナルティは **r2c.biz 側**に来る。
    `noreferrer` は付けない — 流入計測が片肺になる）。
41. **環境変数だけで有効／無効が決まる機能を新設する。**
    点火状態が画面に出ないものは、**点火されていないことに誰も気づけない**。
    2026-08-24 時点で `LEARNED_MEMORY_ENABLED=true` / `TENANTS=carnation` は本番に入っており
    読み書きとも有効だったが `learned_memory` は 0 件のままだった。原因はフラグではなく上流
    （評価が起きない）で、**その切り分けに VPS への SSH が必要だった**。
    段階開放は `tenants.features` を既定とし、env は緊急停止用途に限る。
42. **スキーマの適用を確認せずに「点火」する。**
    禁止23 は「500 を見たら SELECT 差分列を取る」だが、**今回は 500 すら出なかった**。
    `chat_sessions.visitor_id` は未適用のまま配備コードが無条件に INSERT しており、
    `saveMessage` が fire-and-forget のため**客には答えが返り記録だけが無言で落ちる**状態だった
    （2026-08-24 に適用して解消）。同時に `faq_docs.product_*` の未適用で
    **URL取得タブが1件も保存できていなかった**（全件 catch に落ち `inserted: 0` を返す）。
    **マージ済み・デプロイ済みは「本番で動いている」を意味しない。**
    列を要求する機能を有効化する前に、実行中の DB に列が存在することを確認する。
    既存のスキーマ↔コード整合テストは **migration ファイルの文字列**を見るだけで適用の有無は見ない。
43. **「学習しない」「数字が出ない」の原因を、フラグと配線だけに求める。**
    閾値・下限値も同格の容疑者として必ず併記する。`sweepCandidates.ts` の
    `DEFAULT_MIN_MESSAGE_COUNT = 4` に到達した会話が本番に 0 件だったため、
    Judge の対象テナントを広げても**何も起きない**状態だった。
    点火の順序は「会話が伸びる → 評価対象が生まれる → 評価を広げる」であって逆ではない。
44. **押せるのに何も起きない UI を置く。**
    モックデータで動く画面・no-op のボタン・書き手のいないバッジやフィルタ・
    権限が無いユーザーに見えている操作。**ITリテラシーが低いユーザーほど「押したのに何も起きない」を
    自分の操作ミスと解釈し、以後その画面全体を信用しなくなる。** 運用者側もモックの数字で
    意思決定しうる。実装するか消すかの二択にし、**非表示だけで済ませない**（→ 14）。
45. **気づける場所と直せる場所を分ける。**
    ある事実に気づける画面には、その事実に対する操作を**同居**させる。
    AI提案ルールの承認がチャットにしか無く、旧UI `/admin/tuning` では提案が
    「ただの無効ルール」に見えて `is_active` トグルで**承認を経ず本番へ載る**のが実例。
    分けた瞬間に、低リテラシーのユーザーは操作をあきらめる。
46. **知識（RAG）を通さずに顧客への回答を生成する経路を作る。**
    顧客に出す回答は本体API `/api/chat`（FAQ/pgvector/learned_memory/tuning_rules を通る
    実回答経路）が生成したものだけ。アバターは受け取ったテキストを TTS 再生するだけで、
    **自分で LLM を呼んで答えを作らない**。この経路を足すと、FAQ を直しても学習が進んでも
    その回答だけ古いまま・知識ゼロのままになり、**画面上は正常に見える**。
    実例: `avatar-agent/agent.py` の `handle_chat`（data channel `type:"chat"` → Groq 直呼び）と
    `/api/avatar/chat-stream`。前者は本番発火0件のまま廃止済みモデルを指し続けていた（E5で撤去）。
    後者は既定で 503 に封鎖（`ANAM_CHAT_STREAM_ENABLED`）。**封鎖を外すなら先に知識経路を通すこと。**
    ガード: `avatar-agent/test_no_rag_free_answer_path.py`。
47. **共有プールの読み取り権を同意と紐付けずに配る／出す(share)と読む(共有プール参照)を別フラグにする。**
    共有学習プールの参加モデルでは「出す」と「読む」を1つの `share` 同意に統合する
    （出すだけ同意して読み放題、読むだけ同意して提供義務なし、を作らない）。
    プラン別の強制（free_ad は share 強制ON、有料プランは既定OFF・選択可）を実装する際も、
    fail-safe の向きに注意する: プラン取得の「失敗」を `free_ad` の「確定」として扱うと、
    DB障害の瞬間に全テナントが強制データ共有になる（`src/lib/billing/planFeatures.ts` の
    `resolveShareForPlan` / `queryTenantPlanResult` 参照。判定不能時は強制しない）。
    ガード: `tests/phase38/globalRuleGate.test.ts`（S3で追加予定。本ブランチ時点では未存在）。
    根拠: 要件のX1/X2。
48. **原価と請求額を、同じ語・同じ単位・同じ関数で扱う。**
    `usage_logs.cost_total_cents` は **USD セント建ての原価×マージン**であって請求額ではない。
    Stripe の実請求は「件数 × プラン倍率 × Stripe price」で、円は**ゼロデシマル**（`amount_due` はそのまま円）。
    管理画面はこの2つを混ぜ、USD セント値に `¥` を付けて表示し、請求書は 100 で割って表示していた
    （同じ請求書がチャットカードと 100 倍違う）。**変数名に単位を含め**（`cost_total_cents` / `amount_jpy`）、
    整形関数も単位ごとに分ける。原価を「請求額」というラベルで画面に出さない。
49. **請求数量の定義を変える。**
    請求数量は **`billable=true` の `usage_logs` 行数**（`anam_session` のみ秒→分換算）× 行ごとの `plan_multiplier`。
    したがって ①同一リクエストで行を増やす（追加の LLM 呼び出しは `extraLlmUsages` に内包する）
    ②`billing_status` を集計のフィルタに戻す ③絶対値送信を増分方式に戻す
    ④冪等キー `billing:<tenant>:<period>:<quantity>` の形式を変える — のいずれも、
    請求額を静かに水増し・過少にする（詳細: `.claude/rules/billing.md`）。
50. **監視の対象が 0 件のときに「異常なし」と報告する。**
    月次突合は `stripe_usage_reports` に行があるテナントだけを見るため、
    **請求送信が一度も走っていない状態では「乖離 0 件」を毎日報告し続ける**。
    `billingHealthCheck` も `billing_enabled=true` が 0 件なら沈黙する。
    「壊れているときこそ何も言わない」構造を新しく作らない。監視を足すときは
    **対象が 0 件であること自体を異常として鳴らす**条件を必ず併記する
    （`SLACK_WEBHOOK_URL` 未設定でサイレント return する経路も同じ穴 → 41）。
51. **書かれない列に依存した更新を「修正した」ことにする。**
    `invoice.payment_succeeded` は `usage_logs.stripe_subscription_id` を条件に UPDATE するが、
    この列への書き込みはリポジトリ全体で 0 件で、**常に 0 行更新**
    （`billing_status` は永久に `reported` 止まり）。テストが `mockDb.query` に渡された
    **SQL 文字列の一致だけ**を見ているため、恒久 no-op のまま緑だった。
    更新系は**更新行数**か**更新後の実値**をアサートする（→ テストの最低ライン）。
52. **固定費を原価に含めずに採算を語る。**
    `costCalculator.ts` はアバター原価を $0.007/クレジットの**純変動費としてのみ**計上し、
    LemonSlice $100/月 + LiveKit $50/月 = **¥22,500/月の固定費を一切モデル化していない**。
    この固定費はアバター利用テナントだけが原因で、利用量に関わらず発生する。
    1,000 クレジットしか使わない月でもコードは原価 $7 と計算するが、実際には $150 払っている（回収率 5%）。
    **採算・値付け・プラン設計を検討するときに `cost_total_cents` の集計だけで判断しない。**
    固定費の按分は `_chargeMonthlyFixedShare` が担うが、これは**請求側の仕組みであって原価モデルではない**。
53. **他製品のコストを R2C の按分に混ぜる。**
    Hetzner のプロジェクト "Commerce-FAQ / Sales AaaS" には **R2C 以外のサーバーが同居している**
    （`aaas-prod` = R2C2、`AgentS` = Sai）。Supabase も 8 プロジェクト中 R2C は 1 つだけ。
    請求書やコンソールの**見出しを信じて総額を `PLATFORM_MONTHLY_FEE_JPY` に入れると、
    他製品のインフラ費をテナントに請求する**ことになる。固定費を触るときは費目ごとに帰属を確認する。
    Sai は `chargeOneOffJpy` で別途回収済みなので、按分に入れると二重計上になる。
    実額と除外根拠は MEMORY.md の固定費（2026-08-26 に実請求書から確定済み・再算出不要）。
54. **LP の価格表記と課金実装を別々に変える。**
    LP の「〜500対話/月」「従量課金×1.5」は現在**課金ロジックと一切紐づいていない単なる文言**。
    顧客はこれを込み枠と解釈するため、このまま純従量で請求すると「話が違う」となる。
    公開価格の透明性が差別化要因である以上（→ プロダクトの目的とスコープ）、
    **価格表記と課金コードは同じ PR で変える**。
55. **プランを 1 段増やすときに、影響箇所を分けて直す。**
    プランは `PLAN_RANK` / `PLAN_MULTIPLIERS` / `FEATURE_MIN_PLAN` / DB の CHECK 制約 /
    `admin-ui` 側のミラー（`admin-ui/src/lib/planFeatures.ts`・`PLAN_OPTIONS`）に**分散して定義されている**。
    さらに fail-safe の落とし先が 3 箇所ある（`rank()` の既定値 / `queryTenantPlan` の allowlist /
    その catch 返り値）。**これらを同じ PR で同時に直さないと、型チェックもテストも通ったまま
    障害時にだけ発現する**（free_ad 追加時に「最も危険な変更」と位置づけられたのと同型）。
    段の間に挿入する場合は特に、既存プランの `PLAN_RANK` の相対順序が崩れていないかを必ず確認する。

## テストの最低ライン

**配置（既存規約に合わせる）**

| 対象 | ランナー | 置き場所 |
|---|---|---|
| バックエンド | jest | ソース隣に `*.test.ts`（横断は `tests/api/`） |
| admin-ui | vitest + happy-dom + testing-library | ソース隣に `*.test.tsx` |
| E2E | playwright | `tests/e2e/*.spec.ts` |

**CIが守ってくれない範囲（Gate 1 を省略した瞬間に無防備になる）**

- Gate 1 が走らせるのは root の `typecheck` / `lint`(oxlint) / `test`(jest)。
  oxlint は `admin-ui/src` も対象（`oxlint src admin-ui/src`）なので、lint は両側を見ている。
- jest の testMatch は `{src,tests}/**/*.test.ts` で、**`.tsx` は対象外**。
- **admin-ui の vitest / `tsc -b` は Gate 3 で走る**（`Gate 3 — admin-ui typecheck + test + build`。
  vitest は2026-08-18、typecheck は既存エラー24件解消後の同日に追加）。
  それ以前は CI 非実行で、`useAuth.test.tsx` のフレークが #662 以降ずっと赤いまま
  誰にも気づかれていなかった。同じ穴を作らないため、admin-ui にテストランナーを
  増やす場合は必ず CI に配線すること。
- Cloudflare Pages は main merge = 即本番。上記の穴に入る変更は検出機会が無いまま本番に出る。

**最低限意識すること**

- **回帰テストを消さない。** 既に直したバグ（IME誤送信、previewMode のテナントスコープ漏れ、
  super_admin バイパス）は、テストが唯一の再発防止装置。
- **書いた回帰テストが実際に噛むことを確認する。** 修正を一時的に戻して**そのテストが赤くなること**を
  見てから復元する。通ることだけを確認したテストは、条件を取り違えていても緑のままになる。
  実例: 効果測定の打ち切り開示テストは、`truncated` を `false` 固定に戻して初めて
  「片側だけが上限を超えた場合を見ていない」ことが判明した（PR #872）。
- **正常系だけで通さない。** 外部API・DB書き込みは「一部失敗」「全件失敗」「タイムアウト」を必ず書く。
  特に**一部失敗時に表示件数と実件数が一致すること**（黙って成功と表示しない）。
- **権限の境界を必ずテストする。** client_admin / super_admin / previewMode の3ロールで、
  他テナントのデータに到達しないこと。既存の `qa-preview-scope-leak.spec.ts` / `qa-irregular-3roles.spec.ts` に追記する。
- **モバイル 390px を先に確認する。** タップ44px以上・フォント16px以上（Core Principles: Mobile First）。
- **イレギュラー操作を1件以上書く。** 連打・途中リロード・途中ログアウト・別端末・複数タブ・
  プライベートブラウズ（localStorage 無効）。実ユーザーはこの順路で壊す。
- **ツール戻り値は500字で切られる前提でテストする。** 一覧・下書きが件数超過や長文で黙って欠ける経路
  （`get_*` の一覧、`suggest_*` の末尾指示）を必ず1件書く。
- **「新規APIを作らない」もテストで固定する。** 既存エンドポイントを叩くことをテスト名に書く既存例に倣う
  （`copilot-preview/index.test.tsx`）。
- **外部API失敗でUIが確定状態になること。** タイムアウト・5xx でカードや進捗表示が「失敗」で終わり、
  **無限スピナーを残さない**。外部依存（生成・音声・LLM）を足すたびに1件書く。
- **「無い」と「空」を別のテストで書く。** 一覧・詳細を返すAPIは最低
  **①データあり ②存在するが0件（200） ③存在しない（404） ④他テナント（404）** の4本。
  ②と③を1本にまとめない。この区別が無いテストは「253件が全部404」を検出できなかった。
- **エラー分岐はステータス別に書く。** 403/404/500 を1つの catch でまとめたテストは、
  誤った文言を出す実装をそのまま通す。プラン制限（403）で**数値が `0` と描画されないこと**も固定する。
- **定期処理は「止まる」「多重起動しない」を書く。** ポーリング・自動更新は、画面離脱で停止し、
  再入場で二重に走らないこと。離脱後も404/401を叩き続ける実装はテストが無いと気づけない。
- **ライト/ダーク双方で判読できることを目視で確認する。** 自動テストの対象外なので Gate で守る。
  稼働状況の赤カードとアバター作成ウィザードがライトテーマで読めない状態を長期間見逃した。
- **端から端までを 1 本書く。** 単体テストがモジュール内で閉じていたため、
  「機能は完成・テストは緑・ロードマップは完了」のまま配線が切れていた前例が複数ある。
  学習・承認まわりは「会話 → 評価 → 承認 → 次の会話のプロンプトに含まれる」を 1 本で通す。
- **承認が本番に効くことをテストで固定する。** 承認 → `getActiveRulesForTenant` が返す →
  プロンプト文字列に含まれる、まで検証する。ステータス列の更新だけを見ない。
- **フラグ OFF で従来挙動が変わらないことを固定する。** 段階的開放の担保はこれだけ。
- **定期処理は「止まる」「多重起動しない」に加えて「tick が重ならない」を書く。**
- **母数不足のときに数値を出さないことをテストで固定する。**
- **テスト自身が前提を作ってから検証していないか確認する。**
  `tests/integration/wiring-check.test.ts` は自分で `setFlowSessionMeta` を呼んでから
  「本番経路が返す」ことを検証しており、存在しない配線を通していた（偽グリーン）。
- **プラン段を足したら fail-safe の 3 経路を必ず書く。** `plan` が NULL / 未知の文字列 /
  DB 例外 の 3 ケースで、**最も制限の強い段に落ちること**を固定する（→ 絶対にやってはいけないこと 37）。
  「正しいプランで正しく動く」だけのテストは、反転を検出できない。
- **プラン変更の「反映されない」経路をテストで固定する。** ウィジェットは配布 2 系統 + 24 時間キャッシュ
  （→ 38）。**変更が即時に反映されないことが仕様である**なら、それをテスト名に書いて固定する。
  書かないと、次に触る人が即時反映を前提にした実装を足す。
- **無料・原価当社負担の経路でも `usage_logs` に行が残ることを書く。** 請求数量が 0 になることと、
  原価が計上されることは**別のアサーション**。前者だけを見ると赤字が不可視のまま通る。
- **月次・期間の境界は TZ=UTC と TZ=Asia/Tokyo の両方で緑にする。** 片側だけの実装は
  本番でのみズレ、数値はもっともらしく出る（→ 16）。
- **書き込みフローは E2E で検証できない。** E2E は専用ステージングが無く本番
  （`admin.r2c.biz` / `api.r2c.biz`）を叩くため、`e2eWriteGuard` が
  `x-r2c-traffic-source: e2e` を持つ非GETを一律 403 にしている。
  **是正・承認・登録の書き込み経路はバックエンドの結合テストで端から端まで通す**のが唯一の手段で、
  「E2E が緑だから大丈夫」は成立しない。E2E に期待できるのは閲覧・権限境界・レイアウトまで。
- **既存の機械的ガードを壊さない。** `confirmPolicy.test.ts` / `cardPayloadSync.test.ts` /
  `index.wiringInvariants.test.ts` は対象ファイルを**相対パスで `readFileSync` し正規表現で拾う**。
  `actionExecutor.ts` / `copilot-preview/index.tsx` / `useAgentChatTransport.ts` の
  **パス・定数名・リテラルの引用符を変えるとテストが例外で死ぬ**（アサーション失敗ではないため
  原因が分かりにくい）。移動・改名する場合はガードテストの更新を同じ PR に含める。
- **スキーマは「ファイルの文字列」ではなく「実行中の DB に列があるか」を見る。**
  既存のスキーマ↔コード整合テスト（`evaluationAnalyzer.test.ts` 等）は migration ファイルを
  読むだけで、本番適用は検証していない（→ 禁止42）。
- **母数の境界を 0 / 1 / 下限ちょうど / 下限−1 で書く。** 比率・矢印・「効果あり」を出さず
  `0` も描画しないことを固定する。会話長は Judge 下限が 4 通なので **0 / 1 / 3 / 4 通**で書き、
  **下限未満が「エラー」ではなく「対象外」として扱われること**まで見る。
- **金額と更新系は「文字列」ではなく「値」でアサートする。** SQL 文字列の一致で緑にしない。
  UPDATE は更新行数、金額は実値（単位付き）を見る。この規律が無かったため
  `payment_succeeded` の恒久 no-op が緑のまま通った（→ 51）。
- **単位が混ざらないことを1本で固定する。**「USD セントの原価」と「円の請求額」を
  同じ画面・同じ CSV に出すなら、両方の実値を1本のテストで検証する（→ 48）。
- **請求の境界を書く。** 月末 23:59 の降格が遡及しないこと／月をまたぐセッションの帰属／
  当月 0 件で送信しないこと／`plan_multiplier` が NULL と 0 で別扱いになること。
  「正しいプランで正しく請求される」だけのテストは、遡及も過少請求も検出できない。

## 命名・エラーハンドリング

**命名**

- エージェントのツール名: snake_case の `動詞_目的語`。既存の語彙に合わせる
  （`get_*` / `set_*` / `save_*` / `suggest_*` / `import_*` / `commit_*` / `discard_*`。
  一覧は `get_*_list` / `list_*`、状態切替は `activate_*` / `deactivate_*` / `dismiss_*`）。
- localStorage / sessionStorage キー: `r2c_` プレフィックス必須。
- migration ファイル: `migration_<機能>.sql`、機能ディレクトリに colocate。
- テストファイル: 対象ファイル名 + `.test.ts(x)`、対象の隣。
- プラン値: snake_case の文字列リテラル（`starter` / `growth` / `enterprise`）。
  機能ゲート名も snake_case（`voice_clone` / `pre_dispatch`）。`GatedFeature` の既存語彙に合わせる。
- **画面に出す語彙は内部語と分ける。** システムの識別子をそのままラベルにしない。
  対応は i18n（`admin-ui/src/i18n/ja.ts`、`<画面>.<用途>`）に集約しコンポーネントに直書きしない。
  `tuning_rule` →「AIへの指示」／`is_active`・`status` →「使用中・停止中」（承認前は「AIからの提案」。
  **2列あることを画面に出さない**）／Judge スコア →「会話の出来ばえ」／
  `learned_memory` →「AIが会話から覚えたこと」／RAG・embedding・pgvector・variant → **出さない**。
  なお現在 admin-ui には ja/en のキー対応テストも「日本語直書き禁止」テストも無い。先例は
  `KnowledgeListTab.test.tsx` 等の**実 `ja.ts` を通す辞書モック**（キーをそのまま返すモックでは
  誤ったキーを検出できない、という理由が明記されている）。
- **金額の変数名・列名には単位を含める**（`*_cents` は USD セント、`*_jpy` は円）。
  単位を持たない `amount` / `cost` を新設しない（→ 48）。
- **`request_id` はリトライ・二重クリックで同じ値になる形式にする。**
  `usage_logs` は `ON CONFLICT (request_id) DO NOTHING` で重複を弾くため、時刻や乱数を含めると
  同一処理が2行になり原価が二重に見える（`sai_agent` が実際に2行立っている）。

**エラーハンドリング**

- **ユーザー向け文言をハードコードしない。** 共通文言は定数から使う
  （例: `AGENT_CHAT_ERROR_MESSAGE` / `AGENT_CHAT_AUTH_REQUIRED_MESSAGE`）。同じ文言を4箇所に散らさない。
  画面固有の文言は i18n キー（`<画面>.<用途>`）にする。`escalations/[sessionId].tsx` は
  `t("chat_history.loading")` と生文字列 `"会話の取得に失敗しました"` を同一ファイル内で混在させている（是正対象）。
- **すべてのエラーに親切な日本語メッセージを付ける**（Core Principles: Partner Friendly）。
  「失敗しました」で終えず、**次に何をすればよいか**を書く。
  再試行を促すなら**再試行ボタンを同時に置く**（リロードしか手が無い状態を残さない）。
- **空状態とエラー状態で語彙を分ける。** 空状態に ❌・赤帯・「失敗」を使わない。
  「まだお客様の発言がありません」は正常な状態であって、故障ではない。
- **エラー文言はHTTPの意味を保存する。** 「見つかりません」は404のときだけ使う。
  500に使うと、次に同じ障害が起きた人が必ず誤診する（→ 絶対にやってはいけないこと 21）。
- **副作用の記録は fire-and-forget。** 監査・計測・embedding 生成は内部で catch し、`logger.warn` に落とすだけ。
  **記録の失敗がユーザーへの応答（ステータスコード・本文）を変えてはならない。**
  ただし逆は禁止 — 記録に失敗したのに「処理が進んだ」と表示しない。
- **検索索引の同期（`faq_embeddings` / Elasticsearch）は「記録」ではない。**
  失敗すると「登録したのに答えない」というユーザーに見える機能不全になるが、現状は warn ログのみで
  **誰にも検知されない**（`faqImport.ts` / `faqCrudRoutes.ts`）。同期を新たに fire-and-forget で足さない。
  既存に足す場合は、**再試行または不整合の検知手段（件数照合）をセットで入れる。**
- **エージェントのツール戻り値は日本語・500字以内に truncate する。**
- **ログに PII・書籍内容・RAGコンテンツを出さない**（Anti-Slop と整合）。
- **判定に足りないときは、数値を一切出さない。** 差分・率・パーセント・矢印・
  「改善」「悪化」「効果あり」「効果なし」を使わず、`0` も描画しない。
  代わりに**到達条件**を出す（現在 N 件 / 必要 N 件 / 現ペースでの見込み）。
  「足りない」は「効果が無い」ではない。
- **点推定を単独で出さない。** 母数が足りている場合も、信頼区間か
  「この母数では ±X 以内の差は判別できません」を必ず併記する。
- **プラン起因の制限は 403 `plan_upgrade_required` を使い、エラー語彙で描画しない。**
  「利用上限に達した」「このプランでは使えない」は**正常系の分岐**であって故障ではない
  （→ 21、および「空状態とエラー状態で語彙を分ける」）。赤帯にしない、`0` を描画しない、
  代わりに**次の行動**（プラン変更・翌月リセット日）を出す。
  プラン制限の案内は 1 会話 1 回（→ 11）。
- **fail-safe の向きは用途ごとに逆であり、統合しない。**
  機能ゲート（`planFeatures.ts`）は「取得失敗 → 最も制限の強い段」、
  請求（`planPricing.ts`）は「未知 → `starter` 1.0」。取り違えると、DB 障害時に
  **請求が 0 円で固着する**か**プラン外機能が開く**かのどちらかが起きる（→ 37）。

## Security Middleware Order (src/index.ts)
1. requestIdMiddleware (global)
2. securityHeadersMiddleware (global)
3. express.json (global)
4. corsMiddleware (global — preflight handling)
5. rateLimiter (per-route stack)
6. authMiddleware (per-route stack)
7. tenantContextLoader (per-route stack)
8. securityPolicyEnforcer (per-route stack)

## VPSデプロイルール（厳守）

⚠️ 唯一の手順: `bash SCRIPTS/deploy-vps.sh`
- ecosystem.config.cjs の script は `dist/src/index.js`（`dist/index.js` ではない）
- PM2は `.env` を自動で読まない (dotenv/config が src/index.ts 先頭でimport済み)
- 禁止: ssh直接コマンド / VPSで git pull / 個別 pnpm build
詳細: `docs/DEPLOY_CHECKLIST.md`

## Security Scan
- デプロイ前: `bash SCRIPTS/security-scan.sh` 実行推奨
- CI: .github/workflows/security-scan.yml が main push / PR / 週次で自動実行
- High/Critical 検出時はデプロイをブロック。ポリシー: `docs/SECURITY_SCAN_POLICY.md`

## Test & Deploy Gate（必須フロー）

⚠️ 全Phaseに適用。Gate通過なしのデプロイは禁止。詳細: `docs/TEST_DEPLOY_GATE.md`

Gate順序:
- Gate 1: `pnpm verify` (typecheck + lint + test 全パス)
- Gate 1.5: `bash SCRIPTS/dead-code-check.sh` (孤立コード確認)
- Gate 2: `bash SCRIPTS/security-scan.sh` (High/Critical = 0)
- Gate 2.5: `/codex:review --base main --background` (**git push前**に実行、`--base main` 省略禁止)
- Gate 3: `pnpm build && cd admin-ui && pnpm build`
- git commit + push (Gate 1-3通過後のみ)

Codex review gate: 常時OFF。スキップOK: typo修正・ドキュメントのみ・CSSのみ・テストコードのみ

## Git Branch Rule（厳守）

⚠️ **mainへの直接コミット禁止。test-onlyでも例外なし。**

```
git checkout -b feature/<asana-id>-<short-description>
```

違反復旧: `git reset --soft HEAD~1` → feature branch作成 → 再コミット
PR: Tier B（docs / 設定 / テストのみ）は `gh pr merge <PR番号> --auto --squash --delete-branch`。
**`src/**` / `admin-ui/src/**` に触るPRは Tier S＝`high-risk` ラベルが付き auto-merge 対象外。
hkobayashi の手動 merge が必要**（`gh pr merge` は `permissions.deny` でブロックされている）。
「auto-merge待ち」と報告しない。 詳細: `docs/PR_MERGE_RULES.md`

## Auto Mode 運用ルール（Claude Code v2.1.83+）

⚠️ Auto Modeは Sonnet 4.6 ベースの分類器が各ツールコールを事前審査する研究プレビュー機能。
`--dangerously-skip-permissions` より安全だが完全ではない。以下のルールを厳守すること。

### 起動と切替

```bash
claude --enable-auto-mode    # 初回のみ
# セッション内で Shift+Tab を押してモード切替
# default → acceptEdits → plan → auto の順にサイクル
```

ステータスバーが **赤色スピナー** で表示されていればauto有効。

### 使用OK（Auto Modeで実装する）

- feature branch上での実装作業
- pnpm install / pnpm verify / pnpm test / pnpm build
- src/, app/, components/, admin-ui/, docs/, SCRIPTS/ の編集
- git add / git commit / git push（feature branchのみ）
- Asana MCP / Playwright MCP の読み取り操作

### 使用NG（必ず Shift+Tab で default に戻す）

| 操作 | 理由 |
|---|---|
| `bash SCRIPTS/deploy-vps.sh` 実行前後 | 本番デプロイは必ず人間が承認 |
| DB migration SQL実行 | 不可逆操作 |
| main branch操作 | Branch Rule厳守（Gate 2.5の前提） |
| `.env` / `.env.local` / `.env.production` 編集 | 機密情報リーク防止（denyルールでも保護） |
| 書籍PDF / Convex DB seed / シークレット系 | LLM学習防止制約と整合 |
| `/opt/rajiuce/` 配下の操作 | VPS本番領域（denyルールでも保護） |

### 既知バグの回避

- `defaultMode: "auto"` は settings.json で **効かない**（Issue #49273）
  → 毎セッション手動で Shift+Tab する
- 「pushしないで」等の自然言語境界は **context compaction後に消失**（Issue #51689）
  → ハード禁止は `permissions.deny` に書く
- 分類器がOpus 4.7を呼ぶケースあり（Issue #49837）
  → コスト・レイテンシが想定より上がる可能性

### permissions.deny で保護されている範囲（参考）

`~/.claude/settings.local.json` の `permissions.deny` で以下を多重防御:
- `.env` 系全般（`.env.example` は除外＝編集可）
- VPS SSH・rsync コマンド
- `/opt/rajiuce/**` への書き込み
- main branch への直接push
- `rm -rf /` 系の破壊的コマンド

### Gate ワークフローとの整合

- Gate 1-3（@gate-runner）はAuto Modeで快適に回せる
- Gate 2.5（Codex review）は引き続き **人間が手動実行**（Auto Mode関係なし）
- Gate 4b/6（Playwright MCP / Chrome）は通常モードで実行推奨

### トラブル時のリセット

```bash
# Auto Modeを完全停止したい場合
# セッション内で Shift+Tab を押し続けて default に戻す
# 緊急時: Ctrl+C でセッション終了、claude を default モードで再起動
```

## Settings Hygiene
- `.claude/settings.local.json` は `.gitignore` 登録済み（プロジェクトローカルルール）
- allowedTools にAPIトークン・パスワード等の認証情報を含めない
- 禁止デプロイコマンドを allowedTools に追加しない（deploy_guard.py フックが検知）

## Custom Agents (.claude/agents/)

| Agent | 用途 | 呼び出し |
|---|---|---|
| gate-runner | Gate 1〜3一括実行 + フォーマット報告 | @gate-runner |
| cleanup | dead exports削除、any型付け、as any除去 | @cleanup |
| deploy-checker | VPSデプロイ前後チェックリスト | @deploy-checker |
| test-writer | テスト作成（モック方針・配置ルール準拠） | @test-writer |

環境変数: `CLAUDE_CODE_NO_FLICKER=1` (Focus View), `MCP_CONNECTION_NONBLOCKING=true` (MCP高速化)

## MCP Integrations
- Playwright MCP (Gate 4b/6): `claude mcp add --scope project playwright npx @playwright/mcp@latest`
- Session: `/recap` (コンテキスト要約) / `/review` (コードレビュー) / `/security-review`

## OpenWolf（トークン最適化ミドルウェア）
- `.wolf/` にインデックス・学習メモリ・トークンレジャーを保持（`.gitignore` 登録済み）
- anatomy.md で不要な全文読み取りを削減、cerebrum.md でセッション間学習
- `openwolf status` で健全性確認、`openwolf scan` で構造マップ更新

## 開発プレイブック参照
詳細 (役割分担・CLIプロンプトテンプレート・セッション開始プロトコル): `docs/R2C_DEVELOPMENT_PLAYBOOK.md`

## 24h 自走中の禁止操作（Phase70-A — 必読）

24h 自走モード ON 中 (`~/.r2c-24h-mode` 存在時 または `R2C_24H_MODE=1`) は
以下の操作を **絶対に実施しない**。違反検知時は Slack #r2c に `HUMAN-REVIEW-REQUIRED`
投稿して自身を停止すること。

Out of scope 11項目: VPS 接続 / main merge / DB migration / .env 編集 / git force /
avatar-agent 操作 / Cloudflare 設定変更 / 依存メジャー bump / 法務文書編集 / 本番テナント影響 /
**deploy_guard.py・24h-mode スクリプト自己編集禁止** (deploy_guard.py が検知・ブロック)。

詳細・運用手順・トラブルシュートは **`docs/24H_AUTONOMOUS_PLAYBOOK.md`** を必ず読むこと。

ON/OFF 操作:
- ON: `bash SCRIPTS/24h-mode-on.sh` (dry-run: `--dry-run`)
- OFF: `bash SCRIPTS/24h-mode-off.sh`
- 検知 hook: `.claude/hooks/deploy_guard.py` が `R2C_24H_MODE` を読み追加ブロック実施

## 3 回ルール（UATa PR #246 教訓 — Phase70-K 追加）

**同系統のミスを 3 回繰り返したら、その判断は hkobayashi が引き取る。**

適用されるミスタイプ（例）:
1. **推測ベース書き換え** — 実機確認せずに変更 → 確認後に提案
2. **メモリ盲信** — memory 参照後に実機状態を未確認 → 対応ファイル・コマンドで確認
3. **並列化忘れ** — セッション開始時に並列可能性を未検討 → 初手でマトリクス化

資格喪失後の再開条件: ガード/監視の実装完了後。
詳細: `docs/R2C_24H_STARTUP_CHECKLIST.md §5.3`

## Claude.ai 振る舞いルール (UATa 16事例導出 2026-05-20)

出典: `docs/UATA_R2C_DIFF_ANALYSIS.md` / UATa 24h 1日実体験生記録 v1.0

### 1. Claude.ai 生成プロンプトの禁止事項
- `docker compose ... build` 直接コマンドを含めない
- VPS デプロイは `bash SCRIPTS/deploy-vps.sh` 等の wrapper script 経由のみ
- UATa 事例 #8: PR #191 で `--env-file` 抜けて本番 wallet 死亡、4-5h 復旧

### 2. Lane / CLI プロンプト発行前の実機照合必須
- memory 記載のファイル名・endpoint・import path は古い可能性あり
- 必ず CLI に「該当ファイル / grep / git log で実機照合」→ 結果貼り戻し後にプロンプト発行
- UATa 事例 #9: 鉄則 8 違反 3 連続でセッション信頼失墜

### 3. CLI 報告の「全停止」鵜呑み禁止
- 「中止推奨」「全停止」「制約あり」レポートは 4 軸再確認必須
- 4 軸: 観測 (curl/frontend/agent/backend) / 環境 (production/staging/dev) / 時間 (今日/既解消/未解消) / 影響 (当該 Lane/Phase 全体/全停止)
- UATa 事例 #15: 鵜呑みで 4 Lane 全停止指示

### 4. Opus 障害時の Sonnet 退避ルート

Sonnet 4.6 で進められる作業:
- read-only 調査
- `.claude/agents/` + `.claude/skills/` + `docs/` 更新
- pytest / E2E 追加のみの PR
- Phase 1-2 (コード把握 + test 設計)
- PR 作成 (Gate 4 一部保留可)

Sonnet 4.6 不可、Opus 復旧待ち:
- Tier S 直列
- 大規模リファクタ
- セキュリティ系本体修正
- 安全装置配線変更
- 本体最終実装

UATa 事例 #14: Opus 障害で 3 Lane 全停止 → Sonnet 退避未確立で大幅遅延

### 5. Phase 計画立案前の 5 軸事前確認
- 凍結期限 / UAT 状況 / API 障害 / 期限タスク / 過去 postmortem P1 未済
- UATa CLAUDE.md §4「Phase 計画立案 必須セクション」を R2C に移植検討

## 24h ループ安定性ガード（点火前要件 — UATa 3日運用導出）

UATa 3日自走（stop_hook 144件）で判明した停止原因への恒久対策。Lane / Team Lead 双方が遵守する。

### 1. 並列上限（要件5a — result drop 回避）
- **同時稼働 Lane は最大 3 本**（`r2c-dispatch.sh` の `MAX_SLOTS=3`）。
- **1 セッション内の並列 tool call も 3 本未満**に保つ。
- 根拠: 同時 3 本超で Claude Code の result drop / context 断絶が多発（公式 issue #39830、UATa 実測 154件）。
- Team Lead が手動で Lane を起こす場合もこの上限を超えない。

### 2. CI 待ちプロトコル（要件1 — 無限待ち禁止 / Lane 内 20分 timeout）
- Lane は CI 完了を**最大 20 分**しか待たない。超えたら人間へ通知して次へ進む（ブロックしない）。
- `gh run watch` には timeout フラグが無く、`timeout(1)` も非搭載環境があるため、**deadline ループ**で自己制御する:
  ```bash
  run_id=$(gh run list --branch "$BR" --limit 1 --json databaseId -q '.[0].databaseId')
  deadline=$(( $(date +%s) + 1200 ))   # 20分
  while :; do
    st=$(gh run view "$run_id" --json status,conclusion -q '.status+":"+(.conclusion//"")')
    case "$st" in
      completed:success) echo "CI OK"; break ;;
      completed:*)       echo "CI NG: $st"; break ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      bash SCRIPTS/notify-slack.sh "⚠️ CI 20分超過、人間確認へ: run $run_id" --color warning
      break
    fi
    sleep 30
  done
  ```
- supervisor は stuck Lane を **45分**で検出・retry する（`MAX_RUN_MINUTES=45`）。CI 待ちはそれより内側の 20分で必ず畳む。

### 3. コンテキスト断絶の復元プロトコル（要件5b）
- Lane が `previous_message_not_found` / context 断絶を検知したら、その場で粘らず:
  1. 現在の作業状態（branch / 最後に通過した Gate / 次の手順）を auto-memory（`MEMORY.md`）に必ず書く。
  2. Lane を一旦終了し、Team Lead が再 dispatch する（`r2c-dispatch.sh --task-id <id>`）。
  3. 再起動後の Lane は `MEMORY.md` から前回状態を復元してから再開する。
- 断絶したまま推測で続行しない（誤った差分の量産を防ぐ）。

## auto-memory (MEMORY.md) 運用ルール（UATa 3日運用導出）

UATa の24hループで「状態スナップショット/GID一覧/完了済み作業を memory に書いて3日で腐る」が
最大のノイズ源と判明。R2C は今日点火。以下のフィルタを先回りで適用する。

### 1. 書き込み前3問フィルタ（全Laneに適用）

MEMORY.md に書く前に必ずこの3問を通過させること:

- **Q1 コードを読めば分かるか?** → Yes なら書かない（コードが正典）
- **Q2 2週間後も正しいか?** → No なら書かない（腐る情報は毒）
- **Q3 次の自分が罠を踏まずに済むか?** → Yes なら書く（これだけが memory の存在理由）

**書いてはいけないもの（腐る）**:
- 状態スナップショット（「現在 Phase70-K が進行中」等）
- Asana GID 一覧・PR番号・Issue番号
- 完了済み作業の記録
- 一時的な障害状況・API 障害メモ

**書くべきもの（腐らない）**:
- 罠の構造（「なぜこのパスが誤検知されるか」等）
- 確認手順（実機で確認しないと分からない手順）
- ユーザー修正から得た preference（「こうではなくこうやれ」）
- 環境固有のデプロイ・接続の gotcha

### 2. ルール変更は CLAUDE.md が先（memory は経緯のみ）

ルール・禁止事項・ゲート条件を変更する場合:

1. **CLAUDE.md を先に更新する**（全 Lane が読む正典）
2. memory には「なぜ変えたか」の経緯のみ書く（差分の理由）
3. memory にルールを先書きしない（CLAUDE.md と矛盾する二重状態を作らない）

UATa 事故: memory にルール先書き → CLAUDE.md と矛盾 → Lane 間で異なる動作。

### 3. 役割分担（CLAUDE.md vs MEMORY.md）

| 内容 | 書く場所 |
|------|---------|
| 全 Lane 共通の禁止事項 | CLAUDE.md |
| Tier 分類・ゲート条件 | CLAUDE.md |
| 運用プロトコル・フロー | CLAUDE.md |
| 罠の構造・誤検知パターン | MEMORY.md |
| 実機確認しないと分からない手順 | MEMORY.md |
| ユーザー preference（修正から得たもの） | MEMORY.md |
| CLAUDE.md に書けない理由がある経緯 | MEMORY.md |

## 学習セクション (Auto-updated by Claude Code)

<!-- このセクションは Claude Code の auto-memory 機能により管理される -->
<!-- 手動編集不要。memory path: ~/.claude-r2c-config/projects/-Users-hkobayashi-projects-commerce-faq-tasks/memory/ -->

- **Memory path**: `~/.claude-r2c-config/projects/-Users-hkobayashi-projects-commerce-faq-tasks/memory/`
  - `CLAUDE_CONFIG_DIR=~/.claude-r2c-config` 環境変数でデフォルト `~/.claude/` から変更済み
- **OpenWolf 役割分離 (24h自走中)**:
  - `.wolf/cerebrum.md` / `.wolf/memory.md` = Read-Only (24h自走中)
  - `MEMORY.md` (auto-memory) = 唯一の書き込み可能領域
- **設定**: `.claude/settings.json` の `autoMemoryEnabled: true` で有効化済み（`~/.claude-r2c-config/settings.json` にも明示）
- **Lane Agent Memory**: 全 5 Lane エージェントが `memory: project` スコープで共有 MEMORY.md を参照・書き込み
- **メモリ 4 層アーキテクチャ**:
  - Layer 1: `MEMORY.md` — 書き込み可、feedback/project/user/reference 型、3 問フィルタ必須
  - Layer 2: `.wolf/anatomy.md` — Read-Only、ファイルインデックス (16.7M tok 削減)
  - Layer 3: `.wolf/buglog.json` — Read-Only、構造化バグログ 6000+ 件
  - Layer 4: `.wolf/cerebrum.md` — Read-Only (24h自走中)、key learnings / do-not-repeat
  詳細: `docs/R2C_DEVELOPMENT_PLAYBOOK.md §15.6`

## 24h ループ Lane spawn 経路の罠 6 層 (Phase 70 終結、2026-05-28)

2026-05-26〜28 の OAuth daemon 凍結事故と e2e 検証で 24h ループ自走の障害を 6 層解明。
PR #197/#217/#218/#219/#220/#221 で全カバー、e2e #6 (launchd 実起動 task 47 で 40 秒自走成功) で完全復活確定。

### 最大教訓
**launchd 実起動経由で検証しないと罠を見逃す**。interactive shell 成功 ≠ launchd 成功
(PR #220 env -i がこれで裏切った)。修正 PR の前に **launchd cron 1分毎の自然拾い** で
result file 生成を 120 秒以内に観測することを必須ゲートにすること。

### 6 PR 対応表

| 罠 | 内容 | 解消 PR | 修正概要 |
|---|---|---|---|
| 1 | OAuth daemon 凍結 | #197 | auth fail-fast 化 (`claude /login` 手動復旧、headless 不可) |
| 2 | `--prompt-file` v2.1.152 廃止 | #218 | `cat prompt \| claude --bg ...` (stdin pipe) |
| 3 | dispatch.sh `export PATH=` が stdin pipe を壊す | #219 | export PATH= 行削除 |
| 4 | lane-*.log 0byte/223byte ≠ 即死 (解釈罠) | #217 (resolver 安全装置) | `(idle — send a prompt to start)` バナーで判別 |
| 5 | cron-wrapper.sh の親 env 継承 | #220 | `env -i HOME PATH R2C_* CLAUDE_* bash ...` |
| 6 | launchd session/process group attribute | #221 | `/usr/bin/python3 -c 'os.setsid(); execvp(...)'` で session 分離 |

### OAuth 復旧手順 (罠1 発生時)

```bash
# 1. 状態確認
cat ~/.claude/daemon-auth-status.json    # {"status":"auth_required",...} なら罠1
# 2. hkobayashi 手動で /login (headless 不可)
claude /login
# 3. daemon が status.json を更新しない場合は強制再起動 (別ターミナルから)
pkill -f "claude.exe daemon"
pkill -f "claude.exe --bg-spare"
# 4. ファイル消失で valid 状態のシグナル
ls ~/.claude/daemon-auth-status.json   # No such file = OK
```

### 監視 (5 軸ヘルスチェック)
- `SCRIPTS/monitor-claude-health.sh` で 5 分毎チェック (`com.r2c.monitor.plist`)
- 軸A: OAuth fail / 軸B: claude --version 差分 / 軸C: lane-*.log 0byte 連続 / 軸D: dispatch idle / 軸E: session_id 未取得
- Slack `#rajiuce-dev` (C0AG07HFJTB) 通知、6h throttle

### ポストモーテム
- `docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md` (罠 6 層 + 切り分け手順、144 行)
- `docs/postmortem/2026-05-28-oauth-fail/MONITOR_TASK.md` (5 軸監視設計、81 行)
