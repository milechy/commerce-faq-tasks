# 管理API（agent / chat-history）

## スコープ
- `agent/` — 管理AIエージェント。`POST /v1/admin/agent/chat` が唯一の入口。**ツール本数は増え続けるのでここに書かない**（必要なら `grep -c "^\s*name: '" agent/toolDefinitions.ts` で都度実測する。過去に「45本」と書いた行が半年 stale だった）。
- `chat-history/` — 会話ログの一覧・本文・削除・成果記録・エスカレーション。
- 決定の履歴: `docs/CHAT_SURFACE_DECISION.md` / `docs/LEGACY_UI_SUNSET.md` / `docs/COPILOT_UI_PARITY.md` / `docs/AGENT_METRICS.md` / `docs/CHAT_HISTORY_CATEGORY_REQUIREMENTS.md`

## 目的（何のためにツールを足しているのか）
- 目標は「**テナント向け旧UIページを閉じられる状態にすること**」。旧UIを無くすことでも、機能パリティを埋めること自体でもない。
- **旧UIへの `get_legacy_ui_link` は移行途中の一時状態であり、恒久的な設計解にしない。** 恒久的に旧UIへ残すのはテストチャットだけ（実物のウィジェットで試すのが目的なので、管理チャット内で再現しても検証にならない）。
- **ツールも handoff キーも無い機能を作らない。** その状態は店主にとって「機能が無い」と等価で、しかも `agent_legacy_handoff` に現れないため需要を観測できない（`docs/LEGACY_UI_SUNSET.md` §1.2-4 の前例）。実装しないと決めた機能にも必ずどちらかを与える。

## 認可（最優先）
- `tenantId` は **JWT の `app_metadata` のみ**を信頼する。`user_metadata` とトップレベル claim は特権判定に使わない（クライアント編集可能）。
- `targetTenantId` は `isSuperAdmin` のときだけ効く。client_admin が送っても無視される（サーバが主役）。
- **previewMode 中の super_admin に `{kind:"global"}` スコープを使わない。** ロールは super_admin のままなので、そのまま流用すると所有権チェックが外れる。チャット経路は常に実効テナントスコープ。
- テナント越境は **権限エラーではなく「不存在」** として返す（存在の推測を許さない）。

## SQL の扱い（実害のある落とし穴）
- **`chatHistoryRepository.getSessions()` は引数を一切検証していない。** `period` と `sort_order` は SQL に**文字列補間**される。検証は呼び出し側（`chat-history/routes.ts` の allowlist）が全て担っている。
  → **新しい呼び出し元（特に LLM 由来の引数）は必ず同じ allowlist で再検証する。** 不正値はエラーにせず `undefined` にフォールバック。
- `search` はパラメータ化されているが `%` `_` が**エスケープされていない**。LLM 経由で渡すならエスケープする（規約は `resolveSessionByShortId` の実装が正）。
- **セッション特定は必ず `resolveSessionByShortId()` 経由。** 生SQLの `session_id LIKE` を書かない（tenant_id条件・ワイルドカードエスケープ・衝突時の候補提示を内包）。
- **セッション削除は必ず `deleteSessionRepository.deleteSession()` 経由。** `reason` 5–500文字必須 / `audit_logs` 同一TX / `FOR UPDATE` / `lock_timeout 3s` を内包する。削除SQLを新規に書かない。`reason` をモデルに生成させない（監査証跡が無価値になる）。

## ツールを追加・変更するときの必須手順
0. **表現形式を先に決める**（`docs/COPILOT_UI_PARITY.md` §3 の T1 状態カード / T2 選択一覧 / T3 候補カード / T4 要約+可視化）。「ツールを足すか handoff を足すか」をその場で決めない
1. `toolDefinitions.ts` に定義（**同じ関心事で別名ツールを増やさない**。既存ツールの `parameters` 拡張を第一候補にする）
2. `actionExecutor.ts` に `case` を追加（**自前でSQLを書かない**。既存の repository / util を import するのが確立パターン）
3. **`confirmPolicy.ts` に登録**（`WRITE_TOOL_RISK_TIERS` の low/medium/high、または `NON_WRITE_TOOLS`）。漏らすと `confirmPolicy.test.ts` の網羅性テストが落ちる（意図的な設計）
4. フロントの日本語ラベル（`admin-ui/.../copilot-preview/index.tsx` の `REAL_TOOL_LABEL`）を追加。書き込みなら `REAL_WRITE_TOOLS` にも
5. `card` を返すなら**3層すべて**（下記）
6. `docs/COPILOT_UI_PARITY.md` §12 の対応台帳に該当行があれば、`pending` を `tool:<name>` / `handoff:<key>` に更新する（`legacyUiParity.test.ts` が参照の実在は検査するが、更新忘れそのものは検出できない）

## 構造化カード（card）の3層同期
`cardPayloadSync.test.ts` が機械的に検査している。**どれか1層でも漏れると、型は通るのに画面に何も描画されない。**
1. サーバ `actionExecutor.ts` の `*CardPayload`（`kind` は snake_case・シングルクォート）
2. transport `admin-ui/src/lib/useAgentChatTransport.ts` の `*AgentActionCard`（snake_case・ダブルクォート）
3. UI の変換分岐 `copilot-preview/index.tsx` の `a.card?.kind === "..."`

## 検索索引（ES / pgvector）の同期
**「索引の同期は記録ではない」— 失敗すると「登録したのに答えない」というユーザーに見える機能不全になる。**
- 書き込む唯一の実装は `lib/knowledge/faqIndexSync.ts`。**ESドキュメントIDは `faqEsDocId()` のみ**（文字列を組み立てない。過去に2方式が並行していた）。
- FAQ を書き込むツールは必ず同期を呼ぶ。**一括操作は件数分の同期を忘れやすい。**
- **`is_excluded_from_search` / `is_published` を引き継がずに更新しない。** 意図的な検索除外が更新のたびに解除される事故が実際に起きている。
- fire-and-forget だが `logger.error`（warn より上げる）で残す。黙って握り潰さない。

## 壊してはいけない契約
- **ブロック判定文字列**: `確認が必要です` / `確認をスキップできません`。フロントは `確認が必要`、計測は `確認が必要です` で**判定が非対称**なので、文言を変えると UI のチップ出し分けと計測が同時に壊れる。
- **`card` は `text` の置き換えではなく追加。** card 非対応クライアント（パネル）でも自然文だけで意味が通ること。
- **ツール結果は `truncate`（500字）で一律に切られる。** 閲覧系で緩める場合も**書き込み系の結果長を変えない**。打ち切るなら「全N件中M件」を必ず残し、黙って切らない。
- **計測は `agentRoutes.ts` にのみ書く**（45個の case に散らさない）。**fire-and-forget** で、計測の失敗が応答のステータス・本文を変えてはならない。
- **`LEGACY_UI_FEATURES` の値を安易に増減しない。** 削ると `agent_legacy_handoff` が黙って `unknown` に丸まり、旧UIクローズ判定の分子が壊れる。**実装が追いついても4週の計測窓が経過するまで削除しない**（`session_deletion` の前例）。
- `MAX_TOOL_HOPS = 4`。1ターンで「一覧→絞り込み→本文→要約」を全部やらせる設計にしない。
- **既存の単件ツールに配列を受け取らせて一括化しない。** `WRITE_TOOL_RISK_TIERS` が「1件の削除」として付けた `high` が実態を表さなくなる。リスク階層表は「レビュー可能な形で残す」ことが目的なので、嘘になった時点で価値を失う。一括は独立したツールにする。
- **同じ数値を2本目のクエリで集計しない。** 特に請求金額。チャットと請求書が食い違えばクレーム直結で信頼を一撃で失う。共有関数が無ければ**既存ハンドラからクエリを抽出して1本にしてから**両者が使う。
- **金額・件数を LLM の生成文に通さない。** カードはサーバ集計値の直描画。集計時点（as-of）を必ず併記する（週次まとめカードの作法）。

## テナント設定を書き込むときの落とし穴
- 検証は既存の zod スキーマ / 判定関数を **import して共有する**（`allowedOriginsSchema`・`isValidOriginPattern`）。正規表現を手書きしない。`PATCH /v1/admin/my-tenant` が既に `allowed_origins` / `faq_question_hint` / `faq_answer_hint` を同一インスタンスで処理している。
- **`allowed_origins` は空配列＝全オリジン許可（fail-open、`middleware/originCheck.ts`）。** 全消しは「止まる」のではなく「保護が黙って外れる」＝停止より悪い無音の劣化。止まるのは逆に「1件だけ登録して値が実際の掲載URLと違う」場合。
- **ワイルドカードの非対称に注意。** バックエンドは `https://*.example.com` の形を通すが、client_admin 向けUI は一律拒否する。**チャットは緩い方（バックエンド）ではなく厳しい方（UI）に揃える。** `https://*` が1件入るだけで全テナントの CORS に影響する。
- 請求の読み取りは `resolveTenantId()` が super_admin なら `?tenantId` で他テナントを見られる。**チャット経路は実効テナント固定にし、`targetTenantId` を集計クエリへ素通ししない。**

## エスカレーション（有人対応）の契約
- **`getMessages()` は「セッション不在」と「本文0件」を区別する。** 不在は `null`、在るが0件は `[]`。
  呼び出し元は `chat-history/routes.ts` と `agent/actionExecutor.ts` の2箇所で、**両方を同時に直す**
  （片方だけだと旧UIとチャットUIで挙動が割れる）。テナント越境は必ず「不存在」側に倒す。
  区別を捨てていたため、対応中の会話253件すべてが404になり「故障に見えるので返信されない」状態が続いた。
- **`getMessages()` に3本目のクエリを足さない。** 所有権確認と本文取得で既に2回叩いている。
  存在情報は取得済みで、捨てているだけ。
- **`POST .../reply` は `chat_sessions` の存在しか確認しない。** 本文0件のセッションにも返信できるのは
  **仕様**（顧客が発話前に有人相談を求めるケースがある）。「本文が無いから返信させない」制限を足さない。
- **`escalateSession()` はセッションが無ければ作る。** この挙動を塞ぐ前に、空エスカレーションの発生源
  （ウィジェットの `escalate-btn` は未発話でも押せる／E2E／bot）を実データで確認する。
  推測で塞ぐと正当な顧客を切り捨てる。
- 会話本文の取得は**必ず `resolveSessionByShortId()` / `getMessages()` 経由**。生SQLの
  `session_id LIKE` を書かない。

## テストで最低限
- **allowlist 回帰** — allowlist 外の `period` / `sort_order` が SQL の文字列補間に到達しないことを固定する。
- **`confirmPolicy.test.ts` の網羅性** — 全ツールがどちらかの表に属すること。
- **プロンプト注入** — 顧客が書いた文字列（`get_chat_session_messages` の結果）に指示文が混ざっていても、**ユーザーの明示同意なしに書き込み・削除が実行されない**こと。削除ツールがある以上これは必須。
- **確認ゲート** — `confirmed` なしの書き込みはブロックされ **DBが無変更**。同一ターンの `suggest_* → save_*` 連鎖もブロック。
- **境界値** — `limit`/`offset` の 0・上限・負値・NaN。`getSessions` の `limit` には下限クランプが無い。
- **一括操作** — 提示した件数と実際に変更された件数が一致する。対象0件で成功を装わない。絞り込みを変えた後に**古い対象集合で実行されない**。
- **索引同期** — FAQ書き込み系すべてで同期が呼ばれる（一括は件数分）。ES が落ちていても DB 書き込みは成功し、失敗は `logger.error` に残る。
- **カードの3層同期** — `cardPayloadSync.test.ts` が新規カードで green。
- テストは既存の `*.test.ts` に追記する。**挙動を変えたテストを削除して回避しない。**

## 命名・エラーハンドリング
- ツール名は snake_case。`get_*`(読み取り) / `suggest_*`(下書き・非永続) / `save_*`・`add_*`・`update_*`・`delete_*`(コンテンツの書き込み) / `set_*`(単一の設定値・フラグの切替。`WRITE_TOOL_RISK_TIERS` の `low` に対応することが多い)。**動詞を新しく増やさない。**
- card の `kind` は snake_case（`legacy_link`）。**UI側は camelCase** で非対称だが、統一のために両側を触らない。
- ツールの結果文字列は**そのままユーザーに見える**前提で書く。スタック・SQL・内部IDを含めない。失敗時も「次に何をすればよいか」を含める。
- 例外は握って文字列で返すのが既存規約（`logger.warn` + ユーザー向け文言）。ただし**失敗を黙って成功にしない**（削除の lock_timeout 超過、出力の打ち切り）。
- PII（顧客名・電話番号・会話本文・検索語）をメトリクスラベルやログに入れない。
