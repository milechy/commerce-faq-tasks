# 旧UI(テナント向けページ)のクローズ判定基準 — Legacy UI Sunset

**Asana:** GID `1217007298213261`
**位置づけ:** チャット・ファースト管理画面 (`/copilot-preview`) を将来の既定とする前提で、**テナント向け旧UIページ (`/admin/*`) を「いつ閉じてよいか」を数値で確定させる**ための判定基準。ドキュメントのみ。実装・リダイレクトは本PRでは一切行わない。
**実測日:** 2026-07-30 / **基準コミット:** `ef9ac629` (branch `docs/legacy-ui-sunset`, base `origin/main`)
**依存:**
- 兄弟タスク「feat: エージェントツール実行の計測基盤」(`docs/AGENT_METRICS.md`) が定義する 5 メトリクス。本ドキュメント作成時点で `docs/AGENT_METRICS.md` はこのツリーに未着地のため、メトリクス名・格納先のみを前提とし、ラベル定義は兄弟タスク側を正とする (§6-2)。
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

- ツール定義: `src/api/admin/agent/toolDefinitions.ts` — `ADMIN_AGENT_TOOLS` は **45 本** (17行〜906行、`name:` 実測45件)。タスク記載の「45 tools」と一致。
- 実行系: `src/api/admin/agent/actionExecutor.ts` — 45 本すべてに `case` が存在 (154行〜1764行)。
- 旧UI案内: `actionExecutor.ts:1659–1710` の `LEGACY_UI_LINKS` — **9 キー** (`billing` / `avatar_studio` / `escalation_reply` / `session_deletion` / `analytics` / `conversion` / `chat_test` / `avatar_wizard` / `knowledge_pdf`)。`toolDefinitions.ts:839–849` の `feature` enum と 1:1 対応。

### 1.1 サマリ表

| # | ページ | route | 分類 | handoff `feature` キー |
|---|---|---|---|---|
| 1 | ダッシュボード | `/admin` | **Chat-partial** (集計値3つが欠) | なし |
| 2 | 会話履歴 | `/admin/chat-history` | **Chat-partial** | `session_deletion` |
| 3 | 対応中の会話 (エスカレーション) | `/admin/escalations` | **Chat-complete** | `escalation_reply` (履歴閲覧用に限定) |
| 4 | AIの知識データ | `/admin/knowledge/:tenantId` | **Chat-partial** (タブごとに差、§1.2) | `knowledge_pdf` のみ (「成約への貢献度」タブは**キーすら無い**) |
| 5 | 未回答質問 | `/admin/knowledge-gaps` | **Chat-complete** | なし |
| 6 | 会話分析 | `/admin/analytics` | **Chat-partial** | `analytics` |
| 7 | 成約・効果分析 | `/admin/conversion` | **Chat-partial** | `conversion` |
| 8 | お客様への声がけ設定 | `/admin/engagement` | **Chat-complete** | なし |
| 9 | アバター設定 | `/admin/avatar` (+`/wizard`, `/studio`) | **Legacy-link-only (GUI固有)** | `avatar_wizard`, `avatar_studio` |
| 10 | AIへの指示ルール | `/admin/tuning` | **Chat-complete** | なし |
| 11 | テストチャット | `/admin/chat-test` | **Legacy-link-only (GUI固有)** | `chat_test` |
| 12 | ご利用状況・お支払い | `/admin/billing` | **Legacy-link-only** | `billing` |

内訳: Chat-complete 4 / Chat-partial 5 / Legacy-link-only 3。

### 1.2 ページ別 詳細

#### 1. ダッシュボード `/admin` — Chat-partial
- サイドバー定義: `AppSidebar.tsx:52` / ルート: `App.tsx:172`
- カバーするツール: `get_weekly_briefing` (`toolDefinitions.ts:392`, 実行 `actionExecutor.ts:815`)、`get_monitoring_summary` (`:762` / `:1554`)、`get_analytics_summary` (`:865` / `:1763`)
- `get_weekly_briefing` は「直近7日の会話数・前週比・応答品質スコア・成約・答えられなかった質問(累計件数+上位3件)」を1回で返す (実装 `actionExecutor.ts:857–870`)。旧ダッシュボードの読み取り価値の大半はこれで置き換わる。
- **欠けているもの: 旧ダッシュボードの StatCard 4 枚のうち 3 枚。** `pages/admin/index.tsx:361–395` の実測で「FAQ総数」(`:361`)・「公開FAQ数」(`:368`)・「最終更新日」(`:384`) が weekly briefing に含まれていない。残る「未回答質問数」(`:376`) は briefing 側でカバー済み。
  - 特に **FAQ 総数はチャットからは取得できない**: `get_faq_list` は上限 20 件で、返す「N件」は `result.rows.length` = ページサイズであって総数ではない (`actionExecutor.ts:243`)。総数を尋ねられたときに 20 で頭打ちになるのはそれ自体が単体の不具合。
  - いずれも `get_weekly_briefing` に 3 つの集計値を足すだけで埋まる。**GUI 固有ではなく未実装** (§4 Wave 2)。
- 旧ダッシュボードの残り価値はクイックアクション (`pages/admin/index.tsx:382,415,418`) と StatCard のクリック遷移 (`:366,373,381`) で、これは「他ページへの遷移」でありページ固有機能ではない。遷移先が閉じれば同時に消える。
- テナント向けに見える追加要素: オンボーディングモーダル (`:423`, `isSuperAdmin`/`previewMode` を除外して自テナントのみ — `:164`)。チャット側の相当物は `import_industry_faq_templates` (`toolDefinitions.ts:161`) で、業種ヒアリングからのFAQたたき台投入まで被覆済み。`CVUnfiredAlert` (`:344`) のうち `/admin/analytics/cv-status` への遷移ボタンは super_admin 分岐の内側 (`components/dashboard/CVUnfiredAlert.tsx:78`) なのでテナントには出ない。
- 補足: 新UIへの着地切替は既に実装済み。`App.tsx:123–126` が localStorage オプトイン (`admin-ui/src/lib/chatFirstDefault.ts`) で `/` と `/admin` を `/copilot-preview` に差し替える。**このページに限り「クローズ」= 既定値の反転**であり、Route 削除ではない (§5)。

#### 2. 会話履歴 `/admin/chat-history` — Chat-partial
- サイドバー: `AppSidebar.tsx:58` / モバイル下部バー: `AppSidebar.tsx:497` / ルート: `App.tsx:197–198`
- カバー済み: `get_chat_sessions` (`toolDefinitions.ts:659` / `actionExecutor.ts:1399`)、`get_chat_session_messages` (`:674` / `:1421`)。一覧と本文の閲覧はチャットで完結する。
- **欠けているもの: 会話セッションの削除。** `LEGACY_UI_LINKS.session_deletion` (`actionExecutor.ts:1675–1679`) で旧UIへ受け渡している。`actionExecutor.ts:1742–1754` は短縮IDから実セッションを解決して `/admin/chat-history/:sessionId` に直接飛ばす作り込みまで入っている。
- **これは GUI 固有ではなく「未実装」**。破壊的操作のためチャット側に出していないだけで、`delete_faq` (`toolDefinitions.ts:140`) と同じ `confirmed` 二段確認パターンで実装可能。クローズ前提として先に 1 ツール作る必要がある (§4 Wave 2)。

#### 3. 対応中の会話 `/admin/escalations` — Chat-complete
- サイドバー: `AppSidebar.tsx:59` / ルート: `App.tsx:201–202`
- カバー済み: `get_escalations` (`toolDefinitions.ts:695` / `actionExecutor.ts:1453`)、`reply_to_escalation` (`:708` / `:1477`)、`resolve_escalation` (`:737` / `:1521`)。有人返信と対応完了までチャットから実行できる (PR #568, commit `5bc310ad`)。
- `LEGACY_UI_LINKS.escalation_reply` (`actionExecutor.ts:1670–1674`) は残っているが、`toolDefinitions.ts:827–829` が明示的に用途を「ユーザーが『旧画面で会話の履歴を見返したい』と言った場合のみ」に絞っている。履歴の見返し自体は `get_chat_session_messages` で代替できるため、**このキーは残存する必然性が無い**。
- 注意: reply/resolve は 2026-07-29 着地。計測の 4 週窓が最も遅く開始するページ (§4)。

#### 4. AIの知識データ `/admin/knowledge/:tenantId` — Chat-partial
- サイドバー: `AppSidebar.tsx:60` (パスは `SidebarContent` 内 166–178行 でテナントID付きに書き換え) / モバイル下部バー: `AppSidebar.tsx:498` / ルート: `App.tsx:175–181`
- このページは **5 タブ構成** (`pages/admin/knowledge/[tenantId].tsx:78–84`)。タブ配列に `isSuperAdmin` ガードは無く、**5 タブすべてがテナントに見えている**。タブ単位で被覆状況が違うため、ページ単位の分類だけでは判断を誤る:

| タブ | 実装 | チャット被覆 |
|---|---|---|
| 一覧 (`list`) | `KnowledgeListTab` (`[tenantId].tsx:8, 199`) | ○ `get_faq_list` (`toolDefinitions.ts:68`)、`add_faq` (`:89`)、`update_faq` (`:115`)、`delete_faq` (`:140`)、`suggest_faq` (`:436`)、`save_faq` (`:454`)、`import_industry_faq_templates` (`:161`) |
| テキスト入力 (`text`) | `TextInputTab` (`:9, 203`) | ○ `suggest_faq_import_from_text` (`:472`) + `commit_faq_import` (`:521`) / `discard_faq_import` (`:542`) |
| URL取得 (`scrape`) | `UrlScrapeTab` (`:10, 204`) | ○ `suggest_faq_import_from_urls` (`:496`) + `commit_faq_import` |
| PDFアップロード (`pdf`) | `PdfUploadTab` + `BookUploadsSection` (`:11, 205`) | ✕ **GUI固有**。`LEGACY_UI_LINKS.knowledge_pdf` (`actionExecutor.ts:1705–1709`) で受け渡し。`actionExecutor.ts:1700` のコメントが「ファイル選択がGUI固有の操作のためチャット化せず」と明記 |
| 成約への貢献度 (`attribution`) | `KnowledgeAttributionTab` (`:7, 206–207`) | ✕ **ツールも handoff キーも無い** |

- **「成約への貢献度」タブは第3のカテゴリ**: チャットから実行できず、`get_legacy_ui_link` で案内することすらできない (`feature` enum に対応する値が無い — `toolDefinitions.ts:839–849`)。**チャットからは存在が見えない機能**であり、`agent_legacy_handoff` にも一切現れない。つまり §2 の基準では「使われていない」と区別がつかない。`get_conversion_summary` (`:887`) は成約全体のサマリーで、ナレッジ単位の貢献度 (`/v1/admin/analytics/knowledge-attribution`, `components/knowledge/KnowledgeAttributionTab.tsx:136`) とは別物。
- 判定: **クローズ不可** (§4 「クローズ対象外」)。PDF タブが GUI 固有である限りページ全体は閉じられない。加えて attribution タブは、閉じる前に「チャット側にツールを作る」か「最低限 handoff キーを足して計測対象に載せる」かの決着が必要。**計測に現れない機能を抱えたままページを閉じると、失われたことに誰も気づかない。**

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

#### 9. アバター設定 `/admin/avatar` — Legacy-link-only (GUI固有・クローズ対象外)
- サイドバー: `AppSidebar.tsx:77` / ルート: `App.tsx:214–217` (`/admin/avatar`, `/wizard`, `/studio`, `/studio/:id`)
- チャット側にあるのは状態確認と切替の2本だけ: `get_avatar_status` (`toolDefinitions.ts:187` / `actionExecutor.ts:436`)、`activate_avatar` (`:199` / `:466`)。
- 旧UI受け渡し 2 キー: `avatar_studio` (`actionExecutor.ts:1665–1669` — 「画像候補の選択・音声クローン・性格設定・ライブテスト」)、`avatar_wizard` (`:1695–1699` — 新規作成ウィザード)。
- **これは GUI 固有として恒久的に残る想定**: 画像候補からの選択、音声クローンの試聴・採否、ライブテストはいずれも「見て・聴いて選ぶ」操作で、テキストの往復に写像できない。チャット被覆率を上げる対象ではない。GUI 側の作り込みは兄弟の GUI 移行タスクの範疇。

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

兄弟タスクが `metrics_snapshots` (`src/migrations/phase72d_metrics_snapshots.sql`: `metric_name` / `tenant_id` / `labels JSONB` / `value NUMERIC` / `snapshot_at`) に投入する 5 つだけを使う。

| metric_name | 本基準での用途 |
|---|---|
| `agent_legacy_handoff` | 逃げ道の使用量。`labels->>'feature'` が `get_legacy_ui_link` の enum と 1:1 (§6-2) |
| `agent_turn_completed` | 分母 (完了したチャットターン数) |
| `agent_tool_invoked` | チャット側で実際に代替操作が行われた量 (ツール名ラベルで絞る) |
| `agent_write_blocked` | チャット側の書き込みが通らなかった量 = 摩擦 |
| `agent_turn_hops` | 1ターンあたりのツール往復数 = 手数 |

**存在しないメトリクスは条件に使わない。** 特に「旧UIページへの直接訪問数」は本基準に**入れていない**。理由は §6-1 (admin-ui にページビュー計測が実装されていないため、書いても永久に埋まらない条件になる)。

### 2.2 母集団と窓の定義

- **週の単位**: ISO 週 (月〜日)。`snapshot_at` を週境界で bucket する。週平均ではなく **各週が個別に閾値を下回ること** を要求する (平均はスパイクを隠す)。
- **母集団 (分母)**: そのページが**実際に見えているテナント**の `agent_turn_completed` のみ。
  - `/admin/analytics`・`/admin/conversion` は growth 以上のみ可視 (`planFeatures.ts:34–35`, `AppSidebar.tsx:68–69`)。starter テナントのターンを分母に入れると比率が薄まり、使われているページが「閉じてよい」と誤判定される。`tenant_id` 列で `tenants.plan` を join して絞る。
  - 他のページは全 client_admin テナント。
- **有効テナント (active tenant)**: その週に `agent_turn_completed` が 1 件以上あるテナント。

### 2.3 判定条件

あるページ P を閉じてよいのは、**V を満たす窓において C1〜C4 のすべてが N 週連続で成立したとき**、かつそのときのみ。

#### V. 有効性ゲート (これを満たさない窓では判定を開始しない)

窓全体で `agent_turn_completed` ≥ **200**、かつ有効テナント数 ≥ **5**。

> 根拠: 閾値 2% (C1) が意味を持つには、分母が 200 以上必要 (2% = 4 件)。これ未満だと「handoff が 0 件か 1 件か」というノイズで合否が決まる。テナント数 5 は、1テナントの癖が全体を代表してしまうのを防ぐ最低線。R2C の現状規模ではページによってこのゲートを数週間満たせないことがあり得るが、**満たせないなら閉じてはいけない**というのが正しい帰結。

#### N. 連続週数

- 既定: **4 週連続**。根拠: 月次の業務リズムを 1 周期含む最小の窓。4 週未満だと「月初にしか触らない」使い方 (請求確認、月次レポート) を構造的に取りこぼす。
- **月次利用が本質のページ (`/admin/analytics`, `/admin/conversion`, `/admin/billing`) は 8 週連続**。根拠: 静かな 1 か月が偶然クローズを引き起こさないよう、月次周期を 2 周期見る。

#### C1. 逃げ道が例外になっていること (handoff 比率)

各週で
`SUM(agent_legacy_handoff WHERE labels->>'feature' = <P の feature>) / SUM(agent_turn_completed)` ≤ **2.0%**

> 根拠: 2% ≒ 50 ターンに 1 回。テナント管理者の 1 セッションは体感 10 ターン規模なので、2% は「平均して 5 セッション連続でそのページを必要としない」水準にあたる。0% を要求しないのは、モデルが端のケースで案内を出すこと自体は正常であり、0% は永久に達成されない基準になるため。
> handoff キーを持たないページ (ダッシュボード / 未回答質問 / 声がけ設定 / 指示ルール / エスカレーションのうち reply・resolve 経路) では C1 は自動的に成立する。**その場合 C1 は証拠にならないので C2b が必須** (下記)。

#### C2. チャット側が主経路になっていること (代替比)

窓全体で
`SUM(agent_tool_invoked WHERE tool ∈ <P の被覆ツール集合>) : SUM(agent_legacy_handoff WHERE feature = <P>)` ≥ **20 : 1**

> 根拠: 「逃げ道 1 回に対しチャット成功 20 回」= チャット経路が桁で主。10:1 では、そのページを毎日使うテナントにとって週 1 回の詰まりが残る計算になり弱すぎる。20:1 なら詰まりは月 1 回未満に相当する。
> C2 は「使われていないから閉じられる」を排除する条件でもある。分子が小さければ比率は満たせない。

#### C2b. handoff キーを持たないページ向けの絶対量フロア

窓の各週で
`SUM(agent_tool_invoked WHERE tool ∈ <P の被覆ツール集合>) / <その週の有効テナント数>` ≥ **1.0**

> 根拠: 「テナント 1 社あたり週 1 回以上、その操作をチャットで実際にやっている」。逃げ道メトリクスが無いページは、C1 が形式的に成立してしまうため、これが唯一の実使用証拠になる。1.0 という値は「週次の管理業務として最低限成立している」下限で、これを割るならその操作はチャットでもページでも行われていない = そもそも需要が無いか、旧UIで黙って行われている (後者は計測できない — §6-1) ため、閉じる根拠が無い。
> **例外**: `/admin/engagement` (声がけ設定) は設定して放置する性質のページで、C2b は原理的に満たせない。このページは C2b の代わりに **(i) 窓を 8 週に延長し、(ii) §5 の新規テナント限定適用のみで開始し、既存テナントには適用しない** ことを条件とする。低頻度ページを絶対量で測ろうとすると必ず不成立になるため、量ではなく影響範囲を絞ることで担保する。

#### C3. チャット側の摩擦が小さいこと

各週で
`SUM(agent_write_blocked WHERE tool ∈ <P の書き込みツール>) / SUM(agent_tool_invoked WHERE tool ∈ <P の書き込みツール>)` ≤ **5%**

ただし `agent_write_blocked` には設計上正常な失敗が混ざる。R2C のツールは `confirmed=true` を伴う二段確認が既定 (`toolDefinitions.ts` の `save_faq:454`, `save_tuning_rule:263`, `delete_faq:140` 等)。したがって:

- 兄弟タスクの `agent_write_blocked` が `reason` ラベルで「確認待ち」と「ポリシー/プラン拒否」を区別する場合 → **確認待ちを除いた比率で 5%**。
- 区別しない場合 → 5% は使えない。代替として **各週で `agent_write_blocked` の絶対値 ≤ 有効テナント数 × 1.0** (テナント 1 社あたり週 1 件まで) を用いる。

> 根拠: 5% は「20 回書けば 1 回詰まる」水準で、ここを超えるとチャット経路は体感で不安定になり、ページを閉じれば単に作業ができなくなる。プランゲート由来の拒否 (`actionExecutor.ts:1719–1727`, `planFeatures.ts`) は C3 では失敗として数えない — プラン上使えない機能はページを開いても使えないので、クローズ判定と無関係。

#### C4. 手数がページより増えていないこと

各週で
`SUM(agent_turn_hops) / SUM(agent_turn_completed)` (P の被覆ツールを含むターンに絞る) ≤ **4.0**

> 根拠: 被覆済み操作のうち最長の正常フローは 「読み取り (`get_tuning_rules`) → 提案 (`suggest_*`) → 同意後の保存 (`save_*`)」= 3 ホップ。4.0 はここに 1 回のやり直し分の余裕を持たせた値。平均が 4 を超えるならチャット経路は迷路になっており、ページを閉じるのは利用者にとって純粋な劣化になる。
> `agent_turn_hops` が histogram の `_sum` として `metrics_snapshots` に入る場合 (`metricsFlush.ts` の既存 histogram は `_sum` のみ保存する方式)、上式の分子はその `_sum`、分母は同条件の `agent_turn_completed` で平均を出す。

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
3. `src/api/admin/agent/toolDefinitions.ts:839–849` の `feature` enum から該当値を削除し、**`get_legacy_ui_link` の description (`toolDefinitions.ts:818–832`) の該当文言も削除する**。enum だけ消して description に機能名が残ると、モデルは存在しない `feature` を渡し `actionExecutor.ts:1735–1737` の「不明な案内先です」に落ちる。
4. 該当キー固有の分岐も掃除する: `analytics`/`conversion` のプランゲート (`actionExecutor.ts:1719–1727`)、`knowledge_pdf` の tenantId 必須ガード (`:1730–1732`)、`session_deletion` のセッション解決 (`:1742–1754`)。

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

### Wave 2 — チャット側に少し足せば Chat-complete になる (足してから §2 の計測を開始)

| 順 | ページ | 前提として作るもの |
|---|---|---|
| **5** | **ダッシュボード** `/admin` | `get_weekly_briefing` に集計値 3 つ (FAQ総数・公開FAQ数・最終更新日) を追加。あわせて `get_faq_list` の「N件」が上限20で頭打ちになる件 (`actionExecutor.ts:243`) を直す |
| **6** | **会話履歴** `/admin/chat-history` | セッション削除ツール (`delete_faq` と同じ `confirmed` 二段確認)。これで `session_deletion` キー (`actionExecutor.ts:1675`) が不要になる |

どちらも欠けているのは **GUI 固有ではなく未実装**の機能なので、Wave 2 は「ツールを 1 つ足す → 4 週計測 → 閉じる」で進む。

- **ダッシュボードを Wave 2 の先頭に置く理由**: 前提が既存ツールへの集計値 3 つの追加だけで最も軽く、かつ効果が最も大きい (着地画面そのものが変わる)。ただし **Route リダイレクトではなく既定値の反転** — 着地切替は既に `App.tsx:123–126` の localStorage オプトイン (`lib/chatFirstDefault.ts:9`) として実装済みで、「閉じる」= `isChatFirstDefaultEnabled()` の既定を真にすることを意味する。実行は Wave 1 の 1〜4 が閉じてクイックアクション/StatCard の遷移先が減ってから (`pages/admin/index.tsx:382,415,418` および `:366,373,381`)。
- **会話履歴**: 削除は破壊的操作なので、ツールを足す判断自体に「チャットから会話履歴を消せるようにしてよいか」というプロダクト判断が伴う。作らない結論も有りで、その場合このページは `session_deletion` を残したまま**クローズ対象外**に移る。

### クローズ対象外 — チャット被覆率を上げる対象ではない

以下は **クローズパスに乗せない**。チャット化が目的ではなく、GUI としての作り込み (兄弟の GUI 移行タスクの範疇) が正しい方向。

| ページ | 対象外の理由 |
|---|---|
| **アバター設定** `/admin/avatar` (+`/wizard`, `/studio`) | 画像候補の選択・音声クローンの試聴・性格設定・ライブテストは「見て・聴いて選ぶ」操作で、テキスト往復に写像できない (`actionExecutor.ts:1665–1669`) |
| **テストチャット** `/admin/chat-test` | ウィジェットの実挙動確認が目的で、管理者チャット内で再現しても検証にならない。加えて super_admin のテナント詳細から流入 (`TenantTestTab.tsx:24`) |
| **AIの知識データ** `/admin/knowledge/:tenantId` | 5 タブ中 3 タブ (一覧・テキスト・URL) は Chat-complete だが、**PDFアップロード**がファイル選択という GUI 固有操作 (`actionExecutor.ts:1700`)。さらに**「成約への貢献度」タブはツールも handoff キーも無く、計測に一切現れない** (§1.2)。この 2 タブの決着が付くまでページ全体は閉じられない |
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

さらに悪いケースが 1 件ある。**「チャット側にツールが無く、handoff キーも無い」機能は、`agent_tool_invoked` にも `agent_legacy_handoff` にも現れない。** 実測で該当するのは知識データページの「成約への貢献度」タブ (`pages/admin/knowledge/[tenantId].tsx:206–207`)。この種の機能は本基準上「需要ゼロ」と見分けが付かないため、**クローズ判定にかける前に、ツールを作るか最低限 handoff キーを足して計測対象に載せる必要がある**。新しいテナント向け画面を追加するときは、`get_legacy_ui_link` の `feature` enum (`toolDefinitions.ts:839–849`) にも載せることを既定にしておくと、この穴は再発しない。

穴を本当に埋めるなら、`legacy_page_view{page=...}` を同じ `metrics_snapshots` (`src/migrations/phase72d_metrics_snapshots.sql`) に入れる別タスクが必要。その計測が入った時点で、C2b を「直接訪問数 ≤ 有効テナント数 × 0.5 回/週」に置き換えるのが望ましい。

### 6-2. 兄弟タスクとの接続契約

`docs/AGENT_METRICS.md` はこのツリーに未着地 (2026-07-30 確認)。本基準が成立するために兄弟タスク側で満たされている必要があるのは以下:

1. **`agent_legacy_handoff` が `feature` ラベルを持ち、値が `get_legacy_ui_link` の enum (`toolDefinitions.ts:839–849`: `billing` / `avatar_studio` / `escalation_reply` / `session_deletion` / `analytics` / `conversion` / `chat_test` / `avatar_wizard` / `knowledge_pdf`) と 1:1 で一致すること。** ずれると C1・C2 が測れない。enum を削るとき (§3 Stage B-3) はメトリクス側の値も同時に退役する。
2. **`agent_tool_invoked` がツール名ラベルを持つこと** (C2・C2b・C3・C4 のすべてがツール集合での絞り込みを要求する)。
3. **`agent_write_blocked` が「確認待ち」と「拒否」を `reason` で区別すること** (区別されない場合の代替は §2.3 C3 に記載)。
4. **`tenant_id` が列として入ること** (`metrics_snapshots.tenant_id`)。プラン別の母集団分離 (§2.2) がこれに依存する。`metricsFlush.ts` の既存実装は `tenantId` ラベルを `labels` から外して `tenant_id` 列に移す方式なので、同じ扱いであれば要件を満たす。
5. `agent_turn_hops` が histogram の場合、`metrics_snapshots` に入るのは `_sum` (既存 `metricsFlush.ts` の方式)。C4 の平均計算はこれを前提にしている。

### 6-3. 判定に使うクエリの形

```sql
-- C1: 週別 handoff 比率 (feature = 'analytics' の例。growth+ テナントに限定)
WITH w AS (
  SELECT date_trunc('week', m.snapshot_at) AS wk,
         SUM(CASE WHEN m.metric_name = 'agent_legacy_handoff'
                   AND m.labels->>'feature' = 'analytics' THEN m.value ELSE 0 END) AS handoffs,
         SUM(CASE WHEN m.metric_name = 'agent_turn_completed' THEN m.value ELSE 0 END) AS turns
  FROM metrics_snapshots m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.snapshot_at >= NOW() - INTERVAL '8 weeks'
    AND t.plan IN ('growth', 'enterprise')   -- planFeatures.ts:34 のゲートに合わせる
  GROUP BY 1
)
SELECT wk, turns, handoffs,
       ROUND(100.0 * handoffs / NULLIF(turns, 0), 2) AS handoff_pct,
       (turns >= 200 AND 100.0 * handoffs / NULLIF(turns, 0) <= 2.0) AS week_passes
FROM w ORDER BY wk;
```

`week_passes` が窓の全週で true であることが C1 の合格条件。C2〜C4 も同じ形 (`metric_name` と `labels` のフィルタを差し替え) で書ける。

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

### 7-2. 面が区別できないことが C1 に与える影響 (重要)

`CHAT_SURFACE_DECISION.md` §3.3 の指摘どおり、`POST /v1/admin/agent/chat` の `chatSchema` (`src/api/admin/agent/agentRoutes.ts:81–89` — 本ドキュメントでの実測値。受け取るのは `message` / `sessionId` / `targetTenantId` / `history` / `stream` のみ) に面の識別子が無い。このため `agent_legacy_handoff` は次の 2 つを区別できない:

1. **全画面チャット (Surface B) 内で案内が出た** — 利用者はチャットを離れて旧UIへ行く必要があった。**これが C1 で測りたいもの。**
2. **旧UIページ上のパネル (Surface A) で案内が出た** — 利用者は既にその旧UIページの上にいる可能性が高い。これは「チャットで足りなかった」証拠ではなく、単にパネルがページを指し返しただけ。しかも旧UI案内カードは Surface B にしか実装が無い (`pages/copilot-preview/index.tsx:824–841`) ため、パネル側では素のテキストとして流れる。

**この混在のバイアスは一方向 (handoff の過大計上) なので、安全側に倒れる。** C1 が実際より高く出る = クローズが遅れるだけで、早すぎるクローズは起きない。したがって面の識別が入るまで本基準を運用してよいが、**C1 が 2.0% 付近で止まっているページについては、面の識別 (`CHAT_SURFACE_DECISION.md` 即時アクション 4: `surface: "panel" | "fullscreen"` の追加) を先に入れること**。境界付近の判定は面の内訳なしには信頼できない。

面の識別が入った後は、C1 の分子を `labels->>'surface' = 'fullscreen'` に絞り、分母も同じ面のターンに絞る。

---

## 8. まとめ (1 行で)

**テナント向け旧UIページ P は、P が見えているテナント母集団で `agent_turn_completed` が週 200 以上ある窓において、`agent_legacy_handoff{feature=P}` が毎週 2.0% 以下・チャット代替比 20:1 以上・書き込み阻止率 5% 以下・平均ホップ 4.0 以下を 4 週連続 (月次利用ページは 8 週連続) 満たしたときに限り、サイドバー撤去 → 4 週観察 → リダイレクト + 案内キー削除の順で閉じてよい。コンポーネントファイルは削除しない。**
