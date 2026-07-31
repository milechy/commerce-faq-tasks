# 旧UI(テナント向けページ)のクローズ判定基準 — Legacy UI Sunset

**Asana:** GID `1217007298213261`
**位置づけ:** チャット・ファースト管理画面 (`/copilot-preview`) を将来の既定とする前提で、**テナント向け旧UIページ (`/admin/*`) を「いつ閉じてよいか」を数値で確定させる**ための判定基準。ドキュメントのみ。実装・リダイレクトは本PRでは一切行わない。
**実測日:** 2026-07-30 / **基準コミット:** `ef9ac629` (branch `docs/legacy-ui-sunset`, base `origin/main`)
**依存:**
- 兄弟タスク「feat: エージェントツール実行の計測基盤」(`docs/AGENT_METRICS.md`, PR #571 / branch `feat/agent-metrics`) が定義する 5 メトリクス。ラベル・型は同ドキュメントを正とし、本基準は確定済みの定義に対して書いてある (§2.1 / §6-2)。`origin/main` 着地時に §2.1 の表と突き合わせること。
- `docs/CHAT_SURFACE_DECISION.md` (#573)。同ドキュメントは Surface A (旧UI上のチャットパネル) の畳み方を本ドキュメントと対で扱うことを前提にしている。その接続は §7。

---

## 0. スコープ

### 0.1 対象 (クローズ候補)

`admin-ui/src/components/AppSidebar.tsx` の `MAIN_SECTIONS` (49–86行) のうち、**`superAdminOnly` が付いていない項目** = テナント (client_admin) から見えるページのみ。計 12 ページ。

### 0.2 対象外 (クローズ検討の対象にしない)

**super_admin 専用ページはクローズ候補に一切含めない。** `/copilot-preview` はテナント専用UIであり、super_admin 向けの機能をここに寄せるのは誤り (PR #507 で誤って追加された super_admin ツール 11 本を撤去した経緯がある)。したがって本ドキュメントの目標は「**テナント向け旧UIページを閉じる**」であって「**旧UIを無くす**」ではない。旧UIは super_admin の運用面として残り続ける。

明示的に対象外:

| ページ | route | 定義箇所 |
|---|---|---|
| AI学習・貢献分析 | `/admin/knowledge-analytics` | `AppSidebar.tsx:62` (`superAdminOnly`) |
| フロー遷移分析 | `/admin/analytics/flow` | `AppSidebar.tsx:71` (`superAdminOnly`) |
| テナント管理 / 一覧・詳細(約14タブ) | `/admin/tenants`, `/admin/tenants/:id` | `AppSidebar.tsx:92` (`SUPER_ADMIN_SECTION`) |
| お客様の声 (フィードバック) | `/admin/feedback` | `AppSidebar.tsx:93` |
| 代行作業管理 | `/admin/options` | `AppSidebar.tsx:94` |
| システム稼働状況 | `/admin/monitoring` | `AppSidebar.tsx:95` |
| CV発火状況 | `/admin/analytics/cv-status` | `App.tsx:235` (`SuperAdminRoute`) |
| デフォルトアバター管理 | `/admin/avatar-defaults` | `App.tsx:220` (`SuperAdminRoute`) |

---

## 1. 候補ページ インベントリ (実測)

**参照した実装 (2026-07-30 実測):**

- ツール定義: `src/api/admin/agent/toolDefinitions.ts` — `ADMIN_AGENT_TOOLS` は本文書作成時点の45本から増え続けている（会話の履歴カテゴリ拡張で4本、その後のPRでも追加あり。**`name:` の実測件数を都度 `grep -c "^\s*name: '" toolDefinitions.ts` で確認すること**。以下の行番号・件数は本文書の実測時点のスナップショットであり、この文書自体が更新頻度に追いつけていない前提で読むこと）。
- 実行系: `src/api/admin/agent/actionExecutor.ts` — ツール定義と同数の `case` が存在するはず(乖離があれば `confirmPolicy.test.ts` が検出する)。
- 旧UI案内: `actionExecutor.ts` の `LEGACY_UI_LINKS`（行番号は移動しやすいため `grep -n "LEGACY_UI_LINKS" actionExecutor.ts` で確認）— **10 キー** (`billing` / `avatar_studio` / `escalation_reply` / `session_deletion` / `analytics` / `conversion` / `chat_test` / `avatar_wizard` / `knowledge_pdf` / `knowledge_attribution`)。`get_legacy_ui_link` の `feature` enum と 1:1 対応（§1.2-4 で `knowledge_attribution` を追加、以前の版は9キーだった）。

> **`feature` の 9 値の所在について**: `origin/main` (`ef9ac629`) 時点では `toolDefinitions.ts:839–849` の enum リテラルに直接書かれている。**PR #571 着地後は `LEGACY_UI_FEATURES` (`toolDefinitions.ts:26`) が唯一の値の所在**になり、enum は `enum: LEGACY_UI_FEATURES` (`:860`) として参照するだけになる。以下、本ドキュメントで「`feature` enum」と書いている箇所は**値の集合**を指しており、着地後は `LEGACY_UI_FEATURES` を読むこと (行番号は §3 Stage B に最新のものを記載)。

### 1.1 サマリ表

| # | ページ | route | 分類 | handoff `feature` キー |
|---|---|---|---|---|
| 1 | ダッシュボード | `/admin` | **Chat-partial** (集計値3つが欠) | なし |
| 2 | 会話履歴 | `/admin/chat-history` | **Chat-complete**（2026-07-31追記: `delete_chat_session` 実装により削除も被覆） | `session_deletion`（残存。§1.2-2 参照） |
| 3 | 対応中の会話 (エスカレーション) | `/admin/escalations` | **Chat-complete** | `escalation_reply` (履歴閲覧用に限定) |
| 4 | AIの知識データ | `/admin/knowledge/:tenantId` | **Chat-partial** (タブごとに差、§1.2。2026-07-31: PDFタブをテナント可視面から除外、「成約への貢献度」もhandoffキー追加で解消。両方とも§1.2-4) | `knowledge_pdf` / `knowledge_attribution` (2026-07-31 両方解消済み、§1.2-4) |
| 5 | 未回答質問 | `/admin/knowledge-gaps` | **Chat-complete** | なし |
| 6 | 会話分析 | `/admin/analytics` | **Chat-partial** | `analytics` |
| 7 | 成約・効果分析 | `/admin/conversion` | **Chat-partial** | `conversion` |
| 8 | お客様への声がけ設定 | `/admin/engagement` | **Chat-complete** | なし |
| 9 | アバター設定 | `/admin/avatar` (+`/wizard`, `/studio`) | **Chat-partial** (2026-07-31 に分類変更。旧: Legacy-link-only) | `avatar_wizard`, `avatar_studio` |
| 10 | AIへの指示ルール | `/admin/tuning` | **Chat-complete** | なし |
| 11 | テストチャット | `/admin/chat-test` | **Legacy-link-only (GUI固有)** | `chat_test` |
| 12 | ご利用状況・お支払い | `/admin/billing` | **Legacy-link-only** | `billing` |

内訳（2026-07-31更新）: Chat-complete 5 / Chat-partial 4 / Legacy-link-only 3。

### 1.2 ページ別 詳細

#### 1. ダッシュボード `/admin` — Chat-partial
- サイドバー定義: `AppSidebar.tsx:52` / ルート: `App.tsx:172`
- カバーするツール: `get_weekly_briefing` (`toolDefinitions.ts:392`, 実行 `actionExecutor.ts:815`)、`get_monitoring_summary` (`:762` / `:1554`)、`get_analytics_summary` (`:865` / `:1763`)
- `get_weekly_briefing` は「直近7日の会話数・前週比・応答品質スコア・成約・FAQ総数/公開数/最終更新日・答えられなかった質問(累計件数+上位3件)」を1回で返す (実装 `actionExecutor.ts` の `case 'get_weekly_briefing'`)。旧ダッシュボードの読み取り価値の大半はこれで置き換わる。
- **解消済み: 旧ダッシュボードの StatCard 4 枚のうち残り 3 枚。** `pages/admin/index.tsx:361–395` の実測で挙がっていた「FAQ総数」(`:361`)・「公開FAQ数」(`:368`)・「最終更新日」(`:384`) は `get_weekly_briefing` に集計値を追加して埋めた。残る「未回答質問数」(`:376`) は元から briefing 側でカバー済み。
  - あわせて **FAQ 総数がチャットから取得できない不具合も解消**: `get_faq_list` は表示上限20件のままだが、`COUNT(*)::int` による総数を別途取得して「FAQ 一覧（全N件中M件を表示）」の形で返すようになった（表示件数が上限に達していても総数は正しく分かる）。
- 旧ダッシュボードの残り価値はクイックアクション (`pages/admin/index.tsx:382,415,418`) と StatCard のクリック遷移 (`:366,373,381`) で、これは「他ページへの遷移」でありページ固有機能ではない。遷移先が閉じれば同時に消える。
- テナント向けに見える追加要素: オンボーディングモーダル (`:423`, `isSuperAdmin`/`previewMode` を除外して自テナントのみ — `:164`)。チャット側の相当物は `import_industry_faq_templates` (`toolDefinitions.ts:161`) で、業種ヒアリングからのFAQたたき台投入まで被覆済み。`CVUnfiredAlert` (`:344`) のうち `/admin/analytics/cv-status` への遷移ボタンは super_admin 分岐の内側 (`components/dashboard/CVUnfiredAlert.tsx:78`) なのでテナントには出ない。
- 補足: 新UIへの着地切替は既に実装済み。`App.tsx:123–126` が localStorage オプトイン (`admin-ui/src/lib/chatFirstDefault.ts`) で `/` と `/admin` を `/copilot-preview` に差し替える。**このページに限り「クローズ」= 既定値の反転**であり、Route 削除ではない (§5)。

#### 2. 会話履歴 `/admin/chat-history` — Chat-complete（2026-07-31更新。旧記述はChat-partial）
- サイドバー: `AppSidebar.tsx:58` / モバイル下部バー: `AppSidebar.tsx:497` / ルート: `App.tsx:197–198`
- カバー済み: `get_chat_sessions`、`get_chat_session_messages`（一覧・本文の閲覧）に加え、`get_conversation_evaluation`（Judge評価）、`get_session_outcome` / `record_session_outcome`（成果記録の閲覧・記録）、**`delete_chat_session`**（削除。`deleteSessionRepository.deleteSession()` を経由し、reason必須・audit_logs記録・所有権チェック付き）を実装した。会話の履歴カテゴリの主要操作はチャットで完結する。
- **`LEGACY_UI_LINKS.session_deletion`（`actionExecutor.ts` の `get_legacy_ui_link` 案内キー）はあえて残してある。** `delete_chat_session` の実装により旧UIへ誘導する必然性は無くなったが、キーを enum (`LEGACY_UI_FEATURES`) から削除すると `agent_legacy_handoff` の該当ラベルが `unknown` へ丸まり、削除機能の移行がユーザーに実際に使われているかを計測できなくなる（`docs/AGENT_METRICS.md`）。**計測窓（4週）が経過し、`session_deletion` への handoff が実際に減っていることを確認してから撤去する。** 撤去手順: `toolDefinitions.ts` の `LEGACY_UI_FEATURES` と `actionExecutor.ts` の `LEGACY_UI_LINKS` から `session_deletion` を削除し、本ドキュメントの handoff `feature` キー列を更新する。
- クローズの残る条件は無し（Chat-complete）。

#### 3. 対応中の会話 `/admin/escalations` — Chat-complete
- サイドバー: `AppSidebar.tsx:59` / ルート: `App.tsx:201–202`
- カバー済み: `get_escalations` (`toolDefinitions.ts:695` / `actionExecutor.ts:1453`)、`reply_to_escalation` (`:708` / `:1477`)、`resolve_escalation` (`:737` / `:1521`)。有人返信と対応完了までチャットから実行できる (PR #568, commit `5bc310ad`)。
- `LEGACY_UI_LINKS.escalation_reply` (`actionExecutor.ts:1670–1674`) は残っているが、`toolDefinitions.ts:827–829` が明示的に用途を「ユーザーが『旧画面で会話の履歴を見返したい』と言った場合のみ」に絞っている。履歴の見返し自体は `get_chat_session_messages` で代替できるため、**このキーは残存する必然性が無い**。
- 注意: reply/resolve は 2026-07-29 着地。計測の 4 週窓が最も遅く開始するページ (§4)。

#### 4. AIの知識データ `/admin/knowledge/:tenantId` — Chat-partial
- サイドバー: `AppSidebar.tsx:60` (パスは `SidebarContent` 内 166–178行 でテナントID付きに書き換え) / モバイル下部バー: `AppSidebar.tsx:498` / ルート: `App.tsx:175–181`
- このページは **5 タブ構成** (`pages/admin/knowledge/[tenantId].tsx` のタブ配列)。タブ単位で被覆状況が違うため、ページ単位の分類だけでは判断を誤る:
- **2026-07-31 (GID 1217040818410419)**: 「書籍/PDFはR2C運用限定」の方針決定を受け、PDFタブを `user?.role === "super_admin"` の生ロール判定でタブ配列から除外した(previewMode中は `isSuperAdmin` がclient_admin相当に落ちるため、そちらは使っていない — `useAuth.tsx:213–214`)。`?tab=pdf` への直リンクも list へフォールバックする。バックエンド(`bookPdfRoutes.ts` の投入系2エンドポイント)にも同判定で403ガードを追加済み。UIから消しただけで終わらせていない。

| タブ | 実装 | チャット被覆 |
|---|---|---|
| 一覧 (`list`) | `KnowledgeListTab` (`[tenantId].tsx:8, 199`) | ○ `get_faq_list` (`toolDefinitions.ts:68`)、`add_faq` (`:89`)、`update_faq` (`:115`)、`delete_faq` (`:140`)、`suggest_faq` (`:436`)、`save_faq` (`:454`)、`import_industry_faq_templates` (`:161`) |
| テキスト入力 (`text`) | `TextInputTab` (`:9, 203`) | ○ `suggest_faq_import_from_text` (`:472`) + `commit_faq_import` (`:521`) / `discard_faq_import` (`:542`) |
| URL取得 (`scrape`) | `UrlScrapeTab` (`:10, 204`) | ○ `suggest_faq_import_from_urls` (`:496`) + `commit_faq_import` |
| PDFアップロード (`pdf`) | `PdfUploadTab` + `BookUploadsSection` (`:11, 205`) | **済 (2026-07-31)** テナント可視面から除外済み。R2C運用限定になったため、そもそも「テナントのチャット被覆」の対象から外れた(super_adminの運用面としては旧UI/新UI(`/copilot-preview`)双方に残る)。`LEGACY_UI_LINKS.knowledge_pdf` のキー・enumは計測トリップワイヤーのため削除せず維持(説明文のみ更新) |
| 成約への貢献度 (`attribution`) | `KnowledgeAttributionTab` (`:7, 206–207`) | ○ **解消済み**。`LEGACY_UI_LINKS.knowledge_attribution` (`actionExecutor.ts`) で受け渡し (GID `1217040615948155`, 2026-07-31) |

- **「成約への貢献度」タブは解消済み**: 2026-07-31 まではチャットから実行できず、`get_legacy_ui_link` で案内することすらできなかった (`feature` の値集合に対応するものが無い状態)。**チャットからは存在が見えない機能**で `agent_legacy_handoff` にも一切現れず、§2 の基準では「使われていない」と区別がつかなかった。`get_conversion_summary` (`:887`) は成約全体のサマリーで、ナレッジ単位の貢献度 (`/v1/admin/analytics/knowledge-attribution`, `components/knowledge/KnowledgeAttributionTab.tsx:136`) とは別物であることも変わらない。
- **採用した方式と決定理由(handoffキー追加、ツール追加はしない)**: `LEGACY_UI_FEATURES` (`toolDefinitions.ts:26`) に `knowledge_attribution` を1語追加するだけで、`LEGACY_HANDOFF_FEATURES` (`agentRoutes.ts:32`、`LEGACY_UI_FEATURES` から import して導出) と `get_legacy_ui_link` の JSON Schema enum (`toolDefinitions.ts:860`、同じく `LEGACY_UI_FEATURES` を参照) の両方が自動的に追従する。閉鎖判定に必要なのは「計測に載ること」であって「機能をチャットから実行可能にすること」ではないため、新規ツール追加(専用の実行ロジック・テスト・システムプロンプト記述などタッチポイントが5倍になる)は過剰だった。プラン制限ゲート(`planLimitNotice()` 等)も付けていない — R2Cは従量課金であり、貢献度タブ自体もテナントに可視でプランゲートされていないため、`analytics` / `conversion` の既存ゲートを模倣する理由がない。
- 判定: **両方の障害が解消済み**(2026-07-31、GID `1217040818410419` + `1217040615948155`)。PDF タブはテナント可視面から除外、attribution タブはhandoffキー追加で計測対象化。§4 「クローズ対象外」表のこのページの記述は要見直し(本コンフリクト解決の場では未着手。別途 §4 を更新すること)。

#### 5. 未回答質問 `/admin/knowledge-gaps` — Chat-complete
- サイドバー: `AppSidebar.tsx:61` / ルート: `App.tsx:208`
- カバー済み: `get_knowledge_gaps` (`toolDefinitions.ts:405` / `actionExecutor.ts:880`)、`dismiss_knowledge_gap` (`:420` / `:900`)。ギャップから FAQ を作る「ワンクリック改善」に相当する動作は `suggest_faq` → `save_faq` で完結する。
- handoff `feature` キーは存在しない = チャット側に逃げ道が用意されていない = 設計上すでにチャットで閉じている扱い。
- 旧UIへの流入は `pages/admin/index.tsx:382` の1本だけ。

#### 6. 会話分析 `/admin/analytics` — Chat-partial
- サイドバー: `AppSidebar.tsx:68` (`requiresPlan: "analytics"`) / モバイル下部バー: `AppSidebar.tsx:499` / ルート: `App.tsx:233`
- カバー済み (数値サマリー): `get_analytics_summary` (`toolDefinitions.ts:865` / `actionExecutor.ts:1763`)。会話数・前期間比・満足度スコア・1会話あたりメッセージ数・知識ギャップ件数・感情内訳。
- **欠けているもの: グラフの推移表示と、個別の低評価セッションのドリルダウン。** `toolDefinitions.ts:869–870` および `LEGACY_UI_LINKS.analytics` (`actionExecutor.ts:1680–1684`)。
- グラフは視覚表現そのものが価値であり **GUI 固有寄り**。低評価セッションのドリルダウンは `get_chat_session_messages` の延長で作れる (=未実装) が、「どのセッションが低評価か」を返すツールは無い。
- プラン制限: growth 以上のみ可視 (`admin-ui/src/lib/planFeatures.ts:34`)。`actionExecutor.ts:1719–1727` は super_admin もバイパスさせない。**判定基準の母集団に starter テナントを入れてはならない** (§2.2)。

#### 7. 成約・効果分析 `/admin/conversion` — Chat-partial
- サイドバー: `AppSidebar.tsx:69` (`requiresPlan: "conversion"`) / ルート: `App.tsx:241`
- カバー済み: `get_conversion_summary` (`toolDefinitions.ts:887` / `actionExecutor.ts:1764`)。会話数・結果記録率・成約率推移・効いたセールステクニック・離脱ステージ。
- **欠けているもの: ABテスト結果と詳細グラフ** (`toolDefinitions.ts:892`, `LEGACY_UI_LINKS.conversion` = `actionExecutor.ts:1685–1689`)。ABテストは比較表・有意差の見せ方が本質で **GUI 固有寄り**。
- プラン制限: growth 以上 (`planFeatures.ts:35`)。

#### 8. お客様への声がけ設定 `/admin/engagement` — Chat-complete
- サイドバー: `AppSidebar.tsx:70` / ルート: `App.tsx:238`
- カバー済み (CRUD 全部): `suggest_engagement_rule` (`toolDefinitions.ts:556` / `actionExecutor.ts:1193`)、`save_engagement_rule` (`:574` / `:1225`)、`get_engagement_rules` (`:601` / `:1268`)、`update_engagement_rule` (`:614` / `:1294`)、`delete_engagement_rule` (`:643` / `:1367`)。トリガー4種 (`scroll_depth` / `idle_time` / `exit_intent` / `page_url_match`) すべてチャットから設定できる (`toolDefinitions.ts:582–589`)。
- handoff `feature` キーなし。
- 性質上「一度設定したら触らない」低頻度ページ。後述 C2b の絶対量フロアが原理的に満たせないため、専用の扱いが必要 (§2.3)。

#### 9. アバター設定 `/admin/avatar` — Chat-partial (Wave 3・2026-07-31 に分類変更)
- サイドバー: `AppSidebar.tsx:77` / ルート: `App.tsx:214–217` (`/admin/avatar`, `/wizard`, `/studio`, `/studio/:id`)
- チャット側にあるのは状態確認と切替の2本だけ: `get_avatar_status` (`toolDefinitions.ts:187` / `actionExecutor.ts:436`)、`activate_avatar` (`:199` / `:466`)。
- 旧UI受け渡し 2 キー: `avatar_studio` (`actionExecutor.ts:1665–1669` — 「画像候補の選択・音声クローン・性格設定・ライブテスト」)、`avatar_wizard` (`:1695–1699` — 新規作成ウィザード)。
- **2026-07-31 に「GUI 固有として恒久的に残る」判断を撤回した**（決定者: hkobayashi。要件定義: `docs/AVATAR_CHAT_MIGRATION.md`）。面の外に残すのは**ライブテストのみ**とし、画像候補の採否・音声の試聴採否は会話内カードとして持ち込む。旧判断は「見て・聴いて選ぶ操作はテキストに写像できない」だったが、写像すべきは操作の様式ではなく意思決定であり、同じ理由で対象外としていた知識データPDFが #585 で会話内完結へ移った先例がある。
- **判定時の固有条件（`AVATAR_CHAT_MIGRATION.md` §5 で導出）**:
  - 母集団は `avatar` プラン保有テナント（Growth+）に限定する。このページはプランゲート無しで全 client_admin に可視（`AppSidebar.tsx:77`）で、かつ未契約テナントも意図的にフローへ入れる方針のため、絞らないと比率が薄まる。
  - **C1 の分子は `feature ∈ {avatar_wizard, avatar_studio}` のみ**。ライブテストへの `chat_test` handoff はフローの正常な一部（離脱1回を許容する決定）であり、分子に含めると恒久的に閉じられない。
  - 低頻度ページのため、handoff が 0 に近づくと C2 が自明に成立する。`/admin/engagement` と同じ例外（8週窓・新規テナント限定）に加え、**ファネル完了率**（未作成テナントがチャット経由で有効化まで到達した割合）を実使用証拠として要求する。

#### 10. AIへの指示ルール `/admin/tuning` — Chat-complete
- サイドバー: `AppSidebar.tsx:78` / モバイル下部バー: `AppSidebar.tsx:500` / ルート: `App.tsx:205`
- カバー済み (8本、候補ページ中で最も手厚い): `suggest_tuning_rule` (`toolDefinitions.ts:245` / `actionExecutor.ts:541`)、`save_tuning_rule` (`:263` / `:582`)、`get_tuning_rules` (`:293` / `:615`)、`update_tuning_rule` (`:306` / `:636`)、`delete_tuning_rule` (`:325` / `:673`)、`generate_tuning_rule_test_responses` (`:341` / `:698`)、`approve_tuning_rule_response` (`:356` / `:732`)、`remove_approved_response` (`:375` / `:772`)
- 有効/無効の切替、テスト応答の3パターン生成、採用済み返答の追加・取消まで揃っている。handoff `feature` キーなし。
- `/copilot-preview` には「指示ルール」専用タブが既にある (`pages/copilot-preview/index.tsx:235`, 入力プレースホルダは `:637`)。

#### 11. テストチャット `/admin/chat-test` — Legacy-link-only (GUI固有・クローズ対象外)
- サイドバー: `AppSidebar.tsx:79` / ルート: `App.tsx:194` / 受け渡しキー: `chat_test` (`actionExecutor.ts:1690–1694`)
- **GUI 固有**: 目的が「設定した内容を実際のウィジェットで試す」ことなので、管理者向けチャットの中で再現しても検証にならない (アバター描画・音声・声がけの発火を実物で見る必要がある)。`App.tsx:103` は逆に、このページでは AI チャット FAB を隠している (`location.pathname !== "/admin/chat-test"`)。
- **加えて super_admin 運用が依存している**: `components/admin/TenantTestTab.tsx:24` (テナント詳細の「テスト」タブ) が `/admin/chat-test?tenant=<id>` に遷移し、`pages/admin/knowledge/[tenantId].tsx:95–96` も `?scope=global` / `?tenantId=` 付きで参照する。テナント向けにリダイレクトすると super_admin の動作確認フローを壊す。二重の理由でクローズ対象外。

#### 12. ご利用状況・お支払い `/admin/billing` — Legacy-link-only
- サイドバー: `AppSidebar.tsx:83` / ルート: `App.tsx:191` (`AdminRoute` = super/client 両方)。`AppSidebar.tsx:80–82` のコメントどおり、以前は super_admin セクションに置かれていて client_admin から辿れなかったものを復元した経緯がある。
- チャット側ツールは無い。受け渡しキー `billing` (`actionExecutor.ts:1660–1664`) の説明は「請求書の再送・金額調整・無料期間設定・一時停止/再開」——**これらは実装上も super_admin 限定**: テナントフィルター (`pages/admin/billing/index.tsx:544`) と「⚙️ 請求管理」ボタン群 (金額調整・無料期間設定等、`:623`) はいずれも `isSuperAdmin` ガードの内側にある。つまり `LEGACY_UI_LINKS.billing` の案内文が挙げる操作は、テナントがそのページに行っても実行できない。
- **これは案内文の不整合として単体で直す価値がある** (本タスクの範囲外): テナントに `billing` を案内すると「できると言われた操作が画面に無い」状態になる。
- テナントに残る価値は「自分の利用量と請求額を見る」閲覧のみで、これはチャット化可能 (未実装)。ただし金額の提示は誤りが直接クレームになるため、閲覧ツールを作るとしても数値の出所を単一にする設計が前提。
- 判断: **当面クローズ対象外**。請求は「金額を画面で確認したい」という利用者側の要求が強く、テキスト応答で置き換える便益が薄い。

---

## 2. クローズ判定基準 (数値)

### 2.1 使えるメトリクス

兄弟タスク (`docs/AGENT_METRICS.md`, PR #571 / branch `feat/agent-metrics`) が `metrics_snapshots` (`src/migrations/phase72d_metrics_snapshots.sql`: `metric_name` / `tenant_id` / `labels JSONB` / `value NUMERIC` / `snapshot_at`) に投入する 5 つだけを使う。ラベルは同ドキュメントで確定済みの値を正とする:

| metric_name | `labels` | `value` | 本基準での用途 |
|---|---|---|---|
| `agent_legacy_handoff` | `{ feature }` | 常に 1 | 逃げ道の使用量。`feature` は `get_legacy_ui_link` の enum 9 値 + `"unknown"` に丸められる (語彙が閉じている) |
| `agent_turn_completed` | `{ answered_from }` | 常に 1 | 分母 (**完了した**チャットターン数) |
| `agent_tool_invoked` | `{ tool, outcome }` | 常に 1 | チャット側で代替操作が実際に走った量。`tool` は `ADMIN_AGENT_TOOLS` の生の名前、`outcome ∈ {ok, blocked, error}` |
| `agent_write_blocked` | `{ tool, reason }` | 常に 1 | `reason ∈ {unconfirmed, chain}` のみ。**プラン/ポリシー拒否は含まれない** (§2.3 C3) |
| `agent_turn_hops` | `{ hit_limit }` | **そのターンのホップ数** | 手数。1 完了ターンにつき 1 行 |

**重要な型の前提** (`metricsFlush.ts` の既存 Phase72-D KPI 行とは別物): これらはリクエストパスがイベント単位で直接 append する生の行で、prom-client の counter delta も histogram `_sum` も経由しない。したがって

- 上記 4 つは `COUNT(*)` と `SUM(value)` が等価。
- **`agent_turn_hops` の平均は `AVG(value)` で出す。`agent_turn_completed` で割ってはいけない** (1 ターン 1 行で、value がそのターン自身のホップ数)。

**存在しないメトリクスは条件に使わない。** 特に「旧UIページへの直接訪問数」は本基準に**入れていない**。理由は §6-1 (admin-ui にページビュー計測が実装されていないため、書いても永久に埋まらない条件になる)。

### 2.2 母集団と窓の定義

- **週の単位**: ISO 週 (月〜日)。`snapshot_at` を週境界で bucket する。週平均ではなく **各週が個別に閾値を下回ること** を要求する (平均はスパイクを隠す)。
- **母集団 (分母)**: そのページが**実際に見えているテナント**の `agent_turn_completed` のみ。
  - `/admin/analytics`・`/admin/conversion` は growth 以上のみ可視 (`planFeatures.ts:34–35`, `AppSidebar.tsx:68–69`)。starter テナントのターンを分母に入れると比率が薄まり、使われているページが「閉じてよい」と誤判定される。`tenant_id` 列で `tenants.plan` を join して絞る。
  - 他のページは全 client_admin テナント。
  - **`tenant_id` が NULL の行は必ず除外する。** NULL は「プレビュー先テナントを持たない super_admin」= テナントのトラフィックではない。`tenants` への内部結合を使えば自動的に落ちるが、プラン制限が無いページで結合を省略するときは明示的に `tenant_id IS NOT NULL` を書くこと。
- **有効テナント (active tenant)**: その週に `agent_turn_completed` が 1 件以上あるテナント。
- **分母は「完了ターン」だけ**: 500 や SSE の `event: error` で終わったターンは `agent_turn_completed` も `agent_legacy_handoff` も発火しない。つまり**壊れて落ちたターンは分子にも分母にも現れない**ため、恒常的に失敗する経路があっても C1 は上がらない。この死角は C3 (`outcome="error"`) が受け持つ。

### 2.3 判定条件

あるページ P を閉じてよいのは、**V を満たす窓において C1〜C4 のすべてが N 週連続で成立したとき**、かつそのときのみ。C1・C2・C2b・C3 は P 別に測る条件、**C4 は全ページ共通のゲート**である (理由は C4 参照)。

#### V. 有効性ゲート (これを満たさない窓では判定を開始しない)

窓全体で `agent_turn_completed` ≥ **200**、かつ有効テナント数 ≥ **5**。

> 根拠: 閾値 2% (C1) が意味を持つには、分母が 200 以上必要 (2% = 4 件)。これ未満だと「handoff が 0 件か 1 件か」というノイズで合否が決まる。テナント数 5 は、1テナントの癖が全体を代表してしまうのを防ぐ最低線。R2C の現状規模ではページによってこのゲートを数週間満たせないことがあり得るが、**満たせないなら閉じてはいけない**というのが正しい帰結。

#### N. 連続週数

- 既定: **4 週連続**。根拠: 月次の業務リズムを 1 周期含む最小の窓。4 週未満だと「月初にしか触らない」使い方 (請求確認、月次レポート) を構造的に取りこぼす。
- **月次利用が本質のページ (`/admin/analytics`, `/admin/conversion`, `/admin/billing`) は 8 週連続**。根拠: 静かな 1 か月が偶然クローズを引き起こさないよう、月次周期を 2 周期見る。

#### C1. 逃げ道が例外になっていること (完了ターンあたりの handoff 件数)

各週で
`COUNT(agent_legacy_handoff WHERE labels->>'feature' = <P の feature>) / COUNT(agent_turn_completed)` ≤ **2.0%**

> 根拠: 2% ≒ 50 ターンに 1 回。テナント管理者の 1 セッションは体感 10 ターン規模なので、2% は「平均して 5 セッション連続でそのページを必要としない」水準にあたる。0% を要求しないのは、モデルが端のケースで案内を出すこと自体は正常であり、0% は永久に達成されない基準になるため。
> **これは「handoff したターンの割合」ではなく「完了ターンあたりの handoff 件数」である。** メトリクス行にターン/セッション識別子が無いため、1 ターン中に `get_legacy_ui_link` が 2 回呼ばれれば 2 行入り、重複を除去できない。原理上この値は 1.0 (=100%) を超え得る。2% という閾値の水準では実害は無いが、判定を「割合」と誤読すると 2 回案内が出たターンを二重に数えていることに気づけない。
> handoff キーを持たないページ (ダッシュボード / 未回答質問 / 声がけ設定 / 指示ルール / エスカレーションのうち reply・resolve 経路) では C1 は自動的に成立する。**その場合 C1 は証拠にならないので C2b が必須** (下記)。

**あわせて `feature = "unknown"` を監視する。** enum 外の値はすべて `"unknown"` に丸められるので、この件数が恒常的に立つのは「モデルが案内したい機能が `feature` enum に無い」= §6-1 で挙げた**計測に現れない機能が実在する**シグナルになる。`unknown` が週あたり有効テナント数を超えて出ているうちは、どのページについてもクローズ判定を開始しない (何が漏れているか分からないまま閉じることになるため)。

#### C2. チャット側が主経路になっていること (代替比)

窓全体で
`COUNT(agent_tool_invoked WHERE labels->>'tool' ∈ <P の被覆ツール集合> AND labels->>'outcome' = 'ok') : COUNT(agent_legacy_handoff WHERE feature = <P>)` ≥ **20 : 1**

> 根拠: 「逃げ道 1 回に対しチャット成功 20 回」= チャット経路が桁で主。10:1 では、そのページを毎日使うテナントにとって週 1 回の詰まりが残る計算になり弱すぎる。20:1 なら詰まりは月 1 回未満に相当する。
> C2 は「使われていないから閉じられる」を排除する条件でもある。分子が小さければ比率は満たせない。
> 分子を `outcome = 'ok'` に絞るのは、`blocked`/`error` を成功として数えないため。ただし **`outcome = 'ok'` は「成功」より広い**: プラン拒否・テナント未特定・越境拒否はいずれも `agent_write_blocked` を出さず `outcome = "ok"` として記録されるため、分子を膨らませ得る。プラン制限のあるページ (`/admin/analytics`, `/admin/conversion`) については §2.2 の母集団制限 (growth+ のみ) がこの膨張をそのまま除去するので、実務上は問題にならない。母集団制限が効かないページで代替比が閾値ぎりぎりの場合は、`outcome` だけを根拠に判断しないこと。

#### C2b. handoff キーを持たないページ向けの絶対量フロア

窓の各週で
`COUNT(agent_tool_invoked WHERE labels->>'tool' ∈ <P の被覆ツール集合> AND labels->>'outcome' = 'ok') / <その週の有効テナント数>` ≥ **1.0**

> 根拠: 「テナント 1 社あたり週 1 回以上、その操作をチャットで実際にやっている」。逃げ道メトリクスが無いページは、C1 が形式的に成立してしまうため、これが唯一の実使用証拠になる。1.0 という値は「週次の管理業務として最低限成立している」下限で、これを割るならその操作はチャットでもページでも行われていない = そもそも需要が無いか、旧UIで黙って行われている (後者は計測できない — §6-1) ため、閉じる根拠が無い。
> **例外**: `/admin/engagement` (声がけ設定) は設定して放置する性質のページで、C2b は原理的に満たせない。このページは C2b の代わりに **(i) 窓を 8 週に延長し、(ii) §5 の新規テナント限定適用のみで開始し、既存テナントには適用しない** ことを条件とする。低頻度ページを絶対量で測ろうとすると必ず不成立になるため、量ではなく影響範囲を絞ることで担保する。

#### C3. チャット側の摩擦が小さいこと

**`agent_write_blocked` は摩擦の指標として使えない。** `reason` は `unconfirmed` (確認待ち) と `chain` (同一ターン内の `suggest_* → save_*` 連鎖の阻止) の 2 値しかなく、どちらも**設計どおりに動いている証拠**である。R2C のツールは `confirmed=true` を伴う二段確認が既定 (`toolDefinitions.ts` の `save_faq:454`, `save_tuning_rule:263`, `delete_faq:140` 等) なので、`unconfirmed` はほぼすべての書き込みで 1 回出る。両者を除くと `agent_write_blocked` には何も残らない。

したがって摩擦は `agent_tool_invoked` の `outcome` で測る。各週で:

**C3-a (失敗率)** `COUNT(agent_tool_invoked WHERE tool ∈ <P の書き込みツール> AND outcome = 'error') / COUNT(agent_tool_invoked WHERE tool ∈ <P の書き込みツール>)` ≤ **5%**

**C3-b (連鎖阻止)** `COUNT(agent_write_blocked WHERE tool ∈ <P の書き込みツール> AND reason = 'chain') / <その週の有効テナント数>` ≤ **0.5**

> 根拠 (C3-a): 5% は「20 回書けば 1 回落ちる」水準。ここを超えるとチャット経路は体感で不安定になり、ページを閉じれば単に作業ができなくなる。`error` は `blocked` と区別されているので、確認ゲートによる正常な差し戻しは混ざらない。
> 根拠 (C3-b): `chain` は「モデルが人間のターンを挟まずに書き込もうとして止められた」ケースで、確認 UX とモデルの振る舞いが噛み合っていないことを意味する。テナント 1 社あたり週 0.5 件 = 2 週に 1 回までを許容とする。これが多いページは、ページを閉じると「同意したはずなのに保存されない」体験が主経路になる。
>
> **プランゲート由来の拒否は C3 では測れない (かつ測る必要がない)。** `actionExecutor.ts:1719–1727` や `planFeatures.ts` による拒否は `agent_write_blocked` を出さず `outcome = "ok"` として記録される。ただしプラン上使えない機能は**旧UIページを開いても使えない** (`/admin/analytics`・`/admin/conversion` はそもそもサイドバーに出ない、`activate_avatar` の権能付与は super_admin でもバイパス不可) ため、「チャットが旧UIより劣る」証拠にはならない。クローズ判定と無関係なので、この死角は埋めなくてよい。

#### C4. チャットが迷路になっていないこと (**ページ別ではなく全体の門番**)

**C4 は P ごとに絞れない。** `agent_turn_hops` の `labels` は `{ hit_limit }` だけでツールラベルを持たず、行にターン/セッション識別子も無いため、**あるターンがどのツールを呼んだかを結び付ける手段が無い**。したがって C4 は「そのページの操作が何ホップか」ではなく「**チャット全体が収束しているか**」を見る全ページ共通のゲートとして運用する。

各週、テナント母集団全体で:

**C4-a (平均ホップ)** `AVG(value)` on `agent_turn_hops` ≤ **4.0**
**C4-b (収束しないターン)** `COUNT(agent_turn_hops WHERE labels->>'hit_limit' = 'true') / COUNT(agent_turn_hops)` ≤ **2%**

> 根拠 (C4-a): 被覆済み操作のうち最長の正常フローは 「読み取り (`get_tuning_rules`) → 提案 (`suggest_*`) → 同意後の保存 (`save_*`)」= 3 ホップ。4.0 はここに 1 回のやり直し分の余裕を持たせた値。全体平均が 4 を超えているなら、チャットはどのページの代替としても信頼できない。
> **`agent_turn_hops` は 1 完了ターンにつき 1 行・`value` がそのターンのホップ数**なので、平均は `AVG(value)`。`agent_turn_completed` で割ると二重に割ることになる。
> 根拠 (C4-b): `hit_limit = true` は `MAX_TOOL_HOPS` を使い切っても収束しなかったターン = 利用者から見れば「AI が答えを出せずに終わった」ターン。平均が 4 以下でも、こういうターンが 2% を超えて混ざっているなら完遂できていない裾がある。平均だけでは見えないので独立した条件にする。
> **全体ゲートである以上、C4 は「このページは閉じてよい」の証拠にはならない。** 効くのは逆向き — C4 が落ちている週はどのページのクローズも進めない、という拒否権としてだけ使う。ページ別の手数を測りたいなら `agent_turn_hops` に `tool` 相当のラベル (またはターン識別子) を足す必要があり、それは兄弟タスク側の変更になる。**現状の設計判断としては足さなくてよい** — ページ別の手数は C2 の代替比と C3-a の失敗率で十分に代理できており、ターン識別子の追加は行数とプライバシー面のコストが大きい。

### 2.4 中止条件 (観察期のトリップワイヤ)

§3 Stage A (サイドバーからの撤去) 後の 4 週観察期中、**いずれかの週で C1 が 2.0% を再び上回ったら、その時点でクローズを中止し `MAIN_SECTIONS` のエントリを戻す**。サイドバーから消しても URL とチャットの案内は生きているので、この観察期は「導線を細くしたときに需要が表に出てくるか」を測る唯一の機会になる。

---

## 3. クローズの実行手順 (ページを「閉じる」= 削除しない)

### Stage 0. 判定の記録

§2 のクエリ結果 (週別の C1〜C4 の実値、V ゲートの充足) を **PR 本文に数値で貼る**。基準を満たしたという主張だけの PR はレビュー不能。

### Stage A. 導線を細くする (この PR ではリダイレクトしない)

1. `admin-ui/src/components/AppSidebar.tsx` の `MAIN_SECTIONS` (49–86行) から該当エントリを削除。
2. **`BOTTOM_NAV` (`AppSidebar.tsx:495–501`) も同時に更新する。** `MAIN_SECTIONS` だけ消してもモバイル下部バーには残る。該当するのは `/admin` (ホーム)・`/admin/chat-history`・`/admin/knowledge`・`/admin/analytics`・`/admin/tuning` の 5 本。

この時点で **ページは URL で到達可能なまま**、`get_legacy_ui_link` の案内も生きている。→ **4 週の観察期** (§2.4)。

### Stage B. リダイレクトと案内キーの削除 (同一 PR / 同一デプロイで行う)

1. `admin-ui/src/App.tsx` の該当 `Route` の `element` を `<Navigate to="/copilot-preview" replace />` に差し替える。
   - **`Route` 自体を削除してはいけない。** `App.tsx:251` の catch-all (`path="*"` → `/admin`) に落ちるため、削除すると `/copilot-preview` ではなく旧ダッシュボードに着地する。明示的な `Navigate` が必要。前例は `App.tsx:229–230` (`/admin/evaluations` → `/admin/chat-history`)。
2. `src/api/admin/agent/actionExecutor.ts:1659–1710` の `LEGACY_UI_LINKS` から該当キーを削除。
3. **`src/api/admin/agent/toolDefinitions.ts:26` の `LEGACY_UI_FEATURES` から該当値を削除する。** これがモデル向け enum とメトリクスのラベル語彙の**単一の編集点**。あわせて **`get_legacy_ui_link` の description (`toolDefinitions.ts:818–832`) の該当文言も削除する** — 定数だけ消して description に機能名が残ると、モデルは存在しない `feature` を渡し `actionExecutor.ts:1735–1737` の「不明な案内先です」に落ちる。
4. 該当キー固有の分岐も掃除する: `analytics`/`conversion` のプランゲート (`actionExecutor.ts:1719–1727`)、`knowledge_pdf` の tenantId 必須ガード (`:1730–1732`)、`session_deletion` のセッション解決 (`:1742–1754`)。

> **削除箇所は 2 つ**: ①`LEGACY_UI_FEATURES` (`toolDefinitions.ts:26`) と ②`LEGACY_UI_LINKS` (`actionExecutor.ts:1659–1710`)。
>
> かつて 3 箇所目だったメトリクス側のホワイトリスト `LEGACY_HANDOFF_FEATURES` は、**PR #571 (commit `d1af8eb7`) で ① からの導出に変わったため削除対象ではなくなった** (`agentRoutes.ts:29` が `new Set<string>(LEGACY_UI_FEATURES)` の 1 行)。`get_legacy_ui_link` の enum も `enum: LEGACY_UI_FEATURES` (`toolDefinitions.ts:860`) を参照する。つまり **① から値を消すと、モデルがその feature を渡せなくなるのと同時に、万一渡っても計測側が `"unknown"` へ丸める** — §2.4 / §6-2-1 のトリップワイヤが構造的に作動する。
> 再インライン化に対しては `agentRoutes.test.ts:2694–2698` が enum と定数の**参照同一性** (`toBe`) を検査しており、`[...LEGACY_UI_FEATURES]` のような無害に見える写しでも失敗する。
>
> **② の消し忘れは危険側に倒れない。** ① から消えた値が ② に残っても、モデルはもうその `feature` を渡せないので ② のエントリは単なる dead code になる (誤計測にはならない)。逆に **② を先に消して ① を残すと、モデルが渡せる値の案内先が消えて `actionExecutor.ts:1735–1737` の「不明な案内先です」に落ちる**ので、順序は必ず ② → ① ではなく**同一コミットで両方**にすること。

**なぜ 4 箇所目を探さなくてよいか:** 導出後に値を列挙しているのは ① と ② だけである。手順として「N 箇所を漏れなく消す」に依存していた部分は ① への一本化で解消済みで、残る ② の失敗は上記のとおり安全側に倒れる。

**なぜ 1 と 2–3 を分けられないか:** リダイレクトを先に出すと、`get_legacy_ui_link` が「URL: /admin/analytics」と案内した先が `/copilot-preview` に戻される。案内カード (`pages/copilot-preview/index.tsx:170` の `parseLegacyUiLink` で解析、`:823–840` で描画) は会話を失わないため `target="_blank"` 固定 (`:826–833`) なので、症状は同一タブ内のループではなく **「別タブに真新しいセッションのチャットがもう 1 枚開く」** という形になる。ループより分かりにくいだけで壊れ方は同じ。逆に enum を先に削ると、まだ必要な逃げ道を先に塞ぐことになる。よってこの 2 つは不可分。
タスク指示の順序 (リダイレクト → サイドバー → リンク削除) に対し、本手順は **サイドバー撤去を先頭に繰り上げている**。理由はこのループ回避で、「案内キーの削除はページが閉じた後」という制約は維持している。

### Stage B と同時に必須: 流入リンクの掃除 (実測)

リダイレクトを入れると、残った内部遷移が黙って発火して「押したのに違う画面が出る」状態になる。2026-07-30 実測で残っている遷移:

| 遷移元 | 遷移先 | 備考 |
|---|---|---|
| `pages/admin/index.tsx:382` | `/admin/knowledge-gaps` | テナント向け |
| `pages/admin/index.tsx:415` | `/admin/chat-test` | テナント向け (chat-test はクローズ対象外) |
| `pages/admin/index.tsx:418` | `/admin/analytics` | テナント向け |
| `pages/admin/knowledge/[tenantId].tsx:95–96` | `/admin/chat-test?scope=global` / `?tenantId=` | クエリ付き |
| `components/admin/TenantTestTab.tsx:24` | `/admin/chat-test?tenant=<id>` | **super_admin** テナント詳細 |
| `components/dashboard/CVUnfiredAlert.tsx:78` | `/admin/analytics/cv-status` | **super_admin** 専用ページ (対象外) |
| `pages/admin/tenants/AvatarTab.tsx:264` | `/admin/avatar/studio?tenant=<id>` | **super_admin** (対象外) |

super_admin 側からの流入があるページ (`/admin/chat-test`) は、テナント向けにリダイレクトすると super_admin の運用を壊す。ロールで分岐させるかクローズを諦めるかの判断が必要 (本ドキュメントでは後者 — §1.2 の 11)。

### コンポーネントファイルは削除しない

`pages/admin/<page>/index.tsx` は残す。理由:

- **可逆性**: 判定を誤っていた場合の復帰が「Route 1 行 + サイドバー 1 行の revert」で済む。ファイルを削除すると import・型・テストまで巻き戻す作業になり、実質的に不可逆になる。
- **閾値は誤りうる**: §2 の数値は R2C の現在のテナント数を前提にした推定で、V ゲートは最低限の保険にすぎない。母集団が小さいほど誤判定の確率は高い。「基準を測り間違えていた」ときに 1 コミットで戻せることが、この基準を実際に運用可能にする前提条件。
- **super_admin 経路**: 同じコンポーネントを super_admin 側の画面が参照している場合がある (`/admin/chat-test` が典型)。削除の影響範囲は route より広い。

削除の判断は、クローズ後 **6 か月** そのページへの復帰が発生しなかったことを確認してから、別タスクで行う。

---

## 4. 推奨クローズ順序

### Wave 1 — Chat-complete かつ影響範囲が小さい (この順に着手)

| 順 | ページ | 理由 | 制約 |
|---|---|---|---|
| **1** | **未回答質問** `/admin/knowledge-gaps` | Chat-complete。handoff キーが無い = 設計上すでにチャットで閉じている。機能が一覧 + dismiss + FAQ化 のみで最小。流入リンクは `pages/admin/index.tsx:382` の 1 本だけ | C2b が要る (handoff キー無し) |
| **2** | **AIへの指示ルール** `/admin/tuning` | Chat-complete で被覆が最も厚い (8 ツール、テスト応答生成・採用まで)。`/copilot-preview` に専用タブが既にある (`index.tsx:235`) | `BOTTOM_NAV:500` も撤去。既存テナントの筋肉記憶が強いページなので §5 の新規テナント限定を適用 |
| **3** | **対応中の会話** `/admin/escalations` | reply/resolve が入り Chat-complete になった (PR #568)。`escalation_reply` キーは「履歴の見返し」用途に絞られており、`get_chat_session_messages` で代替可能 | **計測開始が最も遅い** (2026-07-29 着地 → 最短でも 2026-08-27 以降に 4 週窓が閉じる) |
| **4** | **お客様への声がけ設定** `/admin/engagement` | Chat-complete (CRUD 5 ツール、トリガー 4 種すべて) | 低頻度ページのため C2b 適用外。§2.3 の例外扱い = 8 週窓 + 新規テナント限定のみ |
| **5** | **会話履歴** `/admin/chat-history` | 2026-07-31、`delete_chat_session` の実装により Chat-complete 化。閲覧(一覧・本文・Judge評価・成果記録)に加え削除・成果記録の書き込みまで被覆 | **計測窓は 2026-07-31 起算**（最も遅く開始する Wave 1 ページ）。`session_deletion` handoff の減少を確認してから `LEGACY_UI_FEATURES` / `LEGACY_UI_LINKS` の該当キーを撤去し、本表を更新すること |

### Wave 2 — チャット側に少し足せば Chat-complete になる (足してから §2 の計測を開始)

| 順 | ページ | 前提として作るもの |
|---|---|---|
| **6** | **ダッシュボード** `/admin` | `get_weekly_briefing` に集計値 3 つ (FAQ総数・公開FAQ数・最終更新日) を追加。あわせて `get_faq_list` の「N件」が上限20で頭打ちになる件 (`actionExecutor.ts:243`) を直す |

欠けているのは **GUI 固有ではなく未実装**の機能なので、Wave 2 は「ツールを 1 つ足す → 4 週計測 → 閉じる」で進む。

- **ダッシュボードを Wave 2 の先頭に置く理由**: 前提が既存ツールへの集計値 3 つの追加だけで最も軽く、かつ効果が最も大きい (着地画面そのものが変わる)。ただし **Route リダイレクトではなく既定値の反転** — 着地切替は既に `App.tsx:123–126` の localStorage オプトイン (`lib/chatFirstDefault.ts:9`) として実装済みで、「閉じる」= `isChatFirstDefaultEnabled()` の既定を真にすることを意味する。実行は Wave 1 の 1〜5 が閉じてクイックアクション/StatCard の遷移先が減ってから (`pages/admin/index.tsx:382,415,418` および `:366,373,381`)。

### Wave 3 — チャット側の実装を伴う (要件定義済み・実装後に計測開始)

| 順 | ページ | 前提として作るもの |
|---|---|---|
| **7** | **アバター設定** `/admin/avatar` (+`/wizard`, `/studio`) | 層A（一覧・無効化・性格/口調の更新・既定に戻す）と層B（画像候補カード・音声試聴カード・音声素材の添付）。ライブテストのみ `chat_test` へ受け渡す。詳細・制約・受け入れ条件は `docs/AVATAR_CHAT_MIGRATION.md` |

Wave 2 が「ツールを1つ足す→4週計測→閉じる」で進むのに対し、Wave 3 は UI 実装を伴うため別 Wave に置く。判定は §1.2-9 の固有条件（Growth+ 母集団・C1 の分子限定・8週窓 + ファネル完了率）に従う。

### クローズ対象外 — チャット被覆率を上げる対象ではない

以下は **クローズパスに乗せない**。チャット化が目的ではなく、GUI としての作り込み (兄弟の GUI 移行タスクの範疇) が正しい方向。

| ページ | 対象外の理由 |
|---|---|
| **テストチャット** `/admin/chat-test` | ウィジェットの実挙動確認が目的で、管理者チャット内で再現しても検証にならない。加えて super_admin のテナント詳細から流入 (`TenantTestTab.tsx:24`) |
| **AIの知識データ** `/admin/knowledge/:tenantId` | **要再評価 (2026-07-31)**。従来の対象外理由(PDFアップロードのGUI固有操作、貢献度タブの計測不能)は両方解消済み — PDFはR2C運用限定としてテナント可視面から除外(GID `1217040818410419`)、貢献度は handoff キー追加(`knowledge_attribution`)で計測対象化(GID `1217040615948155`)。5 タブ中4タブがChat-complete相当(残るPDFはR2C運用限定によりテナントのチャット被覆対象外)。**このページを本表から外し、§2.3 の V ゲート判定(次回 2026-08-27、Asana `1217008521775249`)にかけるべきか要判断** |
| **会話分析** `/admin/analytics` / **成約・効果分析** `/admin/conversion` | 数値サマリーは既にチャット側 (`get_analytics_summary` / `get_conversion_summary`)。残るのはグラフ推移・低評価セッションのドリルダウン・ABテスト結果で、グラフと比較表は視覚表現そのものが価値 |
| **ご利用状況・お支払い** `/admin/billing` | 案内文が指す操作 (請求書再送・金額調整・無料期間・一時停止/再開) は実質 super_admin の運用操作。テナント側の「金額を画面で確認したい」要求をテキストで置き換える便益が薄い |

「対象外」は永久ではなく、**その機能を測る対象が handoff 率ではない**という意味。GUI 移行が進んで残存機能が消えたページは、その時点で Wave 2 に降りてくる。

---

## 5. 移行期の公平性

既存の利用者は旧UIの操作を覚えている。**クローズは短期的には彼らにとって純損失**であり、「新UIの方が良い」という主張は移行コストを払い終えた後にしか成立しない。したがって適用範囲を分ける。

### 5.1 新規テナント限定で先行するページ

対象: **`/admin/tuning`**、**`/admin/engagement`**、**`/admin`(既定着地の反転)**、および Wave 2 の **`/admin/chat-history`**

理由: いずれも「一覧・表を眺めて一括で直す」使い方が旧UIで成立しているページ。チャットは 1 件ずつの対話に向くため、既存テナントの作業手順と正面衝突する。新規テナントは旧UIの手順を持っていないので、最初からチャットで覚えれば衝突が起きない。

適用: リダイレクトの分岐条件を **テナント作成日 ≥ クローズ PR のデプロイ日** とする。既存テナントには **8 週後**に同じリダイレクトを適用し、その間に (i) 一度だけ閉じられる告知バナー、(ii) チャットからの旧UI案内 (`get_legacy_ui_link`) の維持、を確保する。8 週の根拠は §2.3 の N と同じ月次周期 2 周分 — 月初にしかログインしないテナントに 2 回は告知が届く。

### 5.2 一律適用でよいページ

対象: **`/admin/knowledge-gaps`**、**`/admin/escalations`**

理由: どちらも「来たものに 1 件ずつ対応する」ワークフローで、チャットの形と一致している。未回答質問は旧UIでも「1 クリックで FAQ 化」だけの画面で、チャットの `suggest_faq` → `save_faq` の方が手数が少ない。エスカレーションも 1 会話ずつの返信で、一覧を眺める価値が小さい。既存テナントにとっても劣化にならないため、作成日で分岐する複雑さを持ち込む必要がない。

### 5.3 実装上の前提 (現状では作成日で分岐できない)

`tenants.created_at` は DB に存在する (`src/api/admin/tenants/routes.ts:249` の super_admin 一覧が使用) が、**テナント自身のクライアントには届いていない**:

- `GET /v1/admin/my-tenant` の SELECT (`src/api/admin/tenants/routes.ts:150–158`) に `created_at` が入っていない。
- `admin-ui/src/auth/useAuth.tsx` は `tenantId` / `tenantName` / `tenantPlan` だけを公開している (`:9–10, 33`, プラン取得は `:151–178`)。

したがって §5.1 の分岐には、**`my-tenant` の SELECT への `created_at` 追加と `useAuth` への公開が前提**になる (小さいが必須の先行作業)。
なお `my-tenant` は既に `onboarding_completed_at` を返しているので、作成日を通すまでの暫定シグナルとしては使える (「オンボーディング完了が新UI導入後なら新規扱い」)。ただし本来は作成日で判定すべきで、暫定に留めること。

### 5.4 逆方向の導線は既にある

旧UI → 新UI の常設リンクは `AppSidebar.tsx:289–317` (「AIチャットに戻る」、`isClientAdmin` 限定) で入っている。新UI → 旧UI は `get_legacy_ui_link` が担う。**クローズはこの後者を 1 本ずつ畳む作業**であり、畳んだ分だけ利用者の退路が減る。だから §2.4 の中止条件と §3 のファイル保持が必要になる。

---

## 6. 本基準で測れないもの / 前提

### 6-1. 旧UIページの直接訪問数は計測されていない

2026-07-30 実測: `admin-ui/src` にページビュー計測の実装は無い (`page_view` / `pageview` / `track(` 相当 0 件)。したがってタスクが例示した「直接テナント訪問が週 K 回未満」条件は **意図的に本基準から外した**。存在しない計測に基づく条件を書くと、閾値が永久に埋まらないまま残り、この基準そのものが「時間が経てば閉じる」と同じ空文になる。

この穴の影響を明記しておく: **handoff キーを持たないページ (未回答質問・指示ルール・声がけ設定・ダッシュボード) について、旧UIで黙って使われ続けている量は本基準では検出できない。** C2b (§2.3) と §5 の新規テナント限定適用は、この穴を前提に置いた埋め合わせである。

さらに悪いケースが 1 件あった。**「チャット側にツールが無く、handoff キーも無い」機能は、`agent_tool_invoked` にも `agent_legacy_handoff` にも現れない。** 該当していたのは知識データページの「成約への貢献度」タブ (`pages/admin/knowledge/[tenantId].tsx:206–207`) で、この種の機能は本基準上「需要ゼロ」と「計測不能」の区別が付かなかった。**2026-07-31、`LEGACY_UI_FEATURES` (`toolDefinitions.ts:26`) に `knowledge_attribution` を追加して解消済み** (GID `1217040615948155`, §1.2-4)。新しいテナント向け画面を追加するときは、`get_legacy_ui_link` の `feature` の値集合 (`LEGACY_UI_FEATURES`) にも載せることを既定にしておくと、この穴は再発しない。

穴を本当に埋めるなら、`legacy_page_view{page=...}` を同じ `metrics_snapshots` (`src/migrations/phase72d_metrics_snapshots.sql`) に入れる別タスクが必要。その計測が入った時点で、C2b を「直接訪問数 ≤ 有効テナント数 × 0.5 回/週」に置き換えるのが望ましい。

### 6-2. 兄弟タスクとの接続契約 (確定済み)

`docs/AGENT_METRICS.md` は PR #571 (branch `feat/agent-metrics`) で確定。**ラベル・型は同ドキュメントを正とする**。本基準はそこで確定した内容 (§2.1 の表) に対して書かれている。`origin/main` へ着地したら §2.1 の表と齟齬が無いか一度突き合わせること。

本基準が依存する契約:

1. **`agent_legacy_handoff.labels.feature` が `get_legacy_ui_link` の値集合 (`LEGACY_UI_FEATURES`: `billing` / `avatar_studio` / `escalation_reply` / `session_deletion` / `analytics` / `conversion` / `chat_test` / `avatar_wizard` / `knowledge_pdf` / `knowledge_attribution`) と一致し、enum 外は `"unknown"` に丸められること** (確定済み)。enum を削るとき (§3 Stage B-3) は、削った機能の handoff が以後 `"unknown"` に流れ込むことになる。**クローズ完了後は `unknown` の増分をそのページの残存需要として読める**ので、§2.4 の中止条件を Stage B 後も 4 週延長して監視する価値がある。
2. **`agent_tool_invoked.labels.tool` がツール名、`.outcome ∈ {ok, blocked, error}`** (確定済み)。C2・C2b・C3・C4 のすべてがこれで絞る。キー名は `tool` (`tool_name` ではない)。
3. **`agent_write_blocked.labels.reason ∈ {unconfirmed, chain}` のみ** (確定済み)。プラン/ポリシー拒否は含まれない。§2.3 C3 はこの前提で組み直してある。**この 2 値に第 3 の値を足す必要は無い** — 理由は C3 の最後の段落 (プラン壁はチャットと旧UIで対称なので、クローズ判定の材料にならない)。
4. **`tenant_id` は列 (nullable)**。NULL = プレビュー先を持たない super_admin なので §2.2 のとおり除外する。
5. **`agent_turn_hops` は 1 完了ターン 1 行・`value` = そのターンのホップ数・`labels.hit_limit` は JSON boolean** (確定済み)。C4-a は `AVG(value)`、C4-b は `hit_limit` を使う。既存 Phase72-D KPI 行の counter delta / histogram `_sum` の意味論は**適用されない**。
6. **行にターン/セッション識別子は無い** (確定済み)。このため C1 は「割合」ではなく「完了ターンあたりの件数」であり、失敗して落ちたターンは分子・分母のどちらにも現れない (§2.2 の最後)。

### 6-3. 判定に使うクエリの形

```sql
-- C1 + V: 週別の handoff/完了ターン と有効性ゲート
-- (feature = 'analytics' の例。可視テナント = growth+ に限定)
WITH w AS (
  SELECT date_trunc('week', m.snapshot_at) AS wk,
         COUNT(*) FILTER (
           WHERE m.metric_name = 'agent_legacy_handoff'
             AND m.labels->>'feature' = 'analytics'
         ) AS handoffs,
         COUNT(*) FILTER (WHERE m.metric_name = 'agent_turn_completed') AS turns,
         COUNT(DISTINCT m.tenant_id) FILTER (
           WHERE m.metric_name = 'agent_turn_completed'
         ) AS active_tenants,
         -- enum 外の案内要求。恒常的に立つなら計測外の機能が実在する (§6-1)
         COUNT(*) FILTER (
           WHERE m.metric_name = 'agent_legacy_handoff'
             AND m.labels->>'feature' = 'unknown'
         ) AS unknown_handoffs
  FROM metrics_snapshots m
  JOIN tenants t ON t.id = m.tenant_id   -- tenant_id IS NULL (super_admin) はこれで落ちる
  WHERE m.snapshot_at >= NOW() - INTERVAL '8 weeks'
    AND t.plan IN ('growth', 'enterprise')   -- planFeatures.ts:34 のゲートに合わせる
  GROUP BY 1
)
SELECT wk, turns, active_tenants, handoffs, unknown_handoffs,
       ROUND(100.0 * handoffs / NULLIF(turns, 0), 2) AS handoff_per_100_turns,
       (turns >= 200 AND active_tenants >= 5) AS v_gate_ok,
       (100.0 * handoffs / NULLIF(turns, 0) <= 2.0) AS c1_ok
FROM w ORDER BY wk;
```

```sql
-- C4-a / C4-b: 手数。value がそのターンのホップ数なので AVG(value)
SELECT date_trunc('week', snapshot_at) AS wk,
       ROUND(AVG(value), 2) AS mean_hops,
       ROUND(100.0 * COUNT(*) FILTER (WHERE labels->>'hit_limit' = 'true')
             / NULLIF(COUNT(*), 0), 2) AS hit_limit_pct
FROM metrics_snapshots
WHERE metric_name = 'agent_turn_hops'
  AND tenant_id IS NOT NULL
  AND snapshot_at >= NOW() - INTERVAL '8 weeks'
GROUP BY 1 ORDER BY 1;
```

窓の**全週**で `v_gate_ok` と各条件が true であることが合格条件。C2 / C2b / C3 も同じ形 (`metric_name` と `labels->>'tool'` / `->>'outcome'` のフィルタを差し替え) で書ける。

---

## 7. Surface A (旧UI上のチャットパネル) との関係

`docs/CHAT_SURFACE_DECISION.md` (#573) は選択肢 (c)「パネルは橋。旧UIページ閉鎖に合わせて畳む」を推奨し、同 §4(c)-4 でパネル削除条件を「`showAIChat` が真になり得る旧UIパスが 0 になった時」(`App.tsx:103`) と定義し、その条件を本ドキュメント側に書き込むこと (即時アクション 5) を求めている。それに対する回答:

### 7-1. その削除条件は、本ドキュメントの推奨のもとでは永久に成立しない

§4 のとおり、テナント向け旧UIページのうち **5 ページ (アバター設定 / テストチャット / AIの知識データ / 会話分析・成約効果分析 / ご利用状況・お支払い) は恒久的にクローズ対象外**である。理由は「チャット被覆が未達」ではなく「その機能が GUI 固有である」ため。したがって `showAIChat` が真になり得る旧UIパスは 0 にならず、`App.tsx:103` の条件に基づく削除は発火しない。

**したがってパネルの終期は「旧UIパスが 0 になった時」ではなく、「パネルの守備範囲がクローズ対象外ページだけになった時」と定義し直す必要がある。** その時点でのパネルは「旧UIの全ページに浮くもの」ではなく「GUI 固有ページに残る補助窓」であり、削除ではなく **可視条件の縮小** が正しい着地になる:

```
// 到達点のイメージ (実装は本タスクの範囲外)
showAIChat = isClientAdmin && <クローズ対象外ページのみ>
```

機能凍結 (同 §4(c)-1) と A 固有 2 機能 (相談窓口ループ・`answered_from` ラベル) の B への移植 (同 §4(c)-3) は、この縮小の前提条件としてそのまま有効。凍結の終期に上限が付くという (c) の利点も維持される — 上限は「Wave 1 + Wave 2 の 6 ページが閉じた時点」で確定する。

#### 7-1-a. 前提条件の充足状況: A 固有 2 機能の移植は完了済み (2026-07-30)

上記の前提条件のうち **移植 (同 §4(c)-3) は済んでいる**。Asana GID `1217008702879233` / PR「パネル固有の2機能を全画面UIへ移植する」で以下を実施した。

| 前提条件 | 状態 | 実装 |
|---|---|---|
| 相談窓口ループ (担当者からのお返事 → 解決しました / まだ解決しません) を B へ | **済** | `pages/copilot-preview/index.tsx` がフックを共有 (`lib/feedbackReplies.ts` — 移植に合わせて `components/AdminAgent/useFeedbackReplies.ts` から移動)。描画は同ファイルの `FeedbackReplyNotice` / `ResolutionPrompt` |
| `answered_from` の出典ラベルを B へ | **済** | 同ファイルの `ANSWERED_FROM_LABEL` (3値の語彙・文言はパネルと同一) |
| パネルの機能凍結の明文化 | **済** | `components/AdminAgent/AdminAgentPanel.tsx` および `useAdminAgent.ts` 冒頭のコメント |

したがって **パネルに固有で B に無い機能はもう無い**。§7-1 の「可視条件の縮小」を実行する際、機能欠落を理由にブロックされる要素は残っていない (縮小そのものの実装は引き続き別タスク)。

なお **本節が満たしたのは「パネル側の前提条件」だけ** であり、§2.3 の数値基準・§3 の実行手順は一切変更していない。それらはテナント向け旧UIページに対する基準であって、パネル自体の基準ではない (§0.1)。

### 7-2. 面が区別できないことが C1 に与える影響 (重要)

`CHAT_SURFACE_DECISION.md` §3.3 の指摘どおり、`POST /v1/admin/agent/chat` の `chatSchema` (`src/api/admin/agent/agentRoutes.ts:81–89` — 本ドキュメントでの実測値。受け取るのは `message` / `sessionId` / `targetTenantId` / `history` / `stream` のみ) に面の識別子が無い。このため `agent_legacy_handoff` は次の 2 つを区別できない:

1. **全画面チャット (Surface B) 内で案内が出た** — 利用者はチャットを離れて旧UIへ行く必要があった。**これが C1 で測りたいもの。**
2. **旧UIページ上のパネル (Surface A) で案内が出た** — 利用者は既にその旧UIページの上にいる可能性が高い。これは「チャットで足りなかった」証拠ではなく、単にパネルがページを指し返しただけ。しかも旧UI案内カードは Surface B にしか実装が無い (`pages/copilot-preview/index.tsx:824–841`) ため、パネル側では素のテキストとして流れる。

**この混在のバイアスは一方向 (handoff の過大計上) なので、安全側に倒れる。** C1 が実際より高く出る = クローズが遅れるだけで、早すぎるクローズは起きない。したがって面の識別が入るまで本基準を運用してよいが、**C1 が 2.0% 付近で止まっているページについては、面の識別 (`CHAT_SURFACE_DECISION.md` 即時アクション 4: `surface: "panel" | "fullscreen"` の追加) を先に入れること**。境界付近の判定は面の内訳なしには信頼できない。

面の識別が入った後は、C1 の分子を `labels->>'surface' = 'fullscreen'` に絞り、分母も同じ面のターンに絞る。

---

## 8. まとめ (1 行で)

**テナント向け旧UIページ P は、P が見えているテナント母集団 (`tenant_id` NULL 除外) で完了ターンが週 200 以上・有効テナント 5 社以上ある窓において、完了ターンあたりの `agent_legacy_handoff{feature=P}` が毎週 2.0% 以下・チャット代替比 20:1 以上・書き込みツールの `outcome="error"` 率 5% 以下 (加えて全体ゲートとして平均ホップ 4.0 以下・`hit_limit` 率 2% 以下) を 4 週連続 (月次利用ページは 8 週連続) 満たしたときに限り、サイドバー撤去 → 4 週観察 → リダイレクト + 案内キー削除の順で閉じてよい。コンポーネントファイルは削除しない。**
