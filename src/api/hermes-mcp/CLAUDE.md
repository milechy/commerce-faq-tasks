# Hermes 連携と学習ループ（hermes-mcp / 同意 / learned_memory）

## スコープ
- `src/api/hermes-mcp/` — 外部 Hermes Agent VPS 向けの MCP データ提供（同意済みテナントの会話）と、
  CVR 改善提案の受け口。**Hermes 本体は別ホストにあり、このリポジトリには構成が 1 行も無い**
  （`SCRIPTS/`・`infra/`・`ENVIRONMENT.md` のいずれにも無い）。何を入れたか検証もロールバックもできない前提で触る。
- 同意判定の唯一の実装は `src/lib/hermesConsent.ts`。学習の書き込みは `src/agent/memory/`。
  点火状態の可視化は `src/api/admin/analytics/ignitionStatus.ts`。**この 4 箇所は 1 セットで動く。**
- 関連: `docs/LEARNING_LOOP_REQUIREMENTS.md` / `.claude/rules/knowledge.md`

## 目的（何のために配線しているのか）
- Hermes は「会話が溜まった後に型を抽出する」役。**母数が無い状態で発火させても出すものが無い。**
  2026-08-24 実測で実会話は 90 日 13 件・平均 1.54 通、Judge の評価下限 4 通に到達した会話は 0 件。
  機能を足す前に、**フラグと配線より先に母数と閾値を疑う**。
- 学習は「入口（会話→評価）と出口（承認→本番プロンプト）」が繋がって初めて価値を持つ。片側だけ作らない。
  Judge・提案・承認・A/B・Hermes はいずれも「完成済み」に見えて 1 箇所の配線欠落で無効化された前例がある。
- **評価層は R2C 側にある。** Hermes に eval / LLMOps は無い。強化する前に採択率
  （`tuning_rules` の `source='hermes'` × `status`）で測る。測れないものを強化しない。

## 認可・同意（最優先）
- 同意判定は必ず `resolveLearningConsentFromFeatures` / `isHermesDataConsentGranted` /
  `shareConsentSqlPredicate` を経由する。**述語を新しく書かない。**
  SQL 側と JS 側がずれ、「global ルールは読めるが export は 403」というタダ乗りが無言で成立していた（→ 禁止 47）。
- fail-safe の向き: `learn` は既定 true（外に出ない）、`share` は既定 false（外に出る）。
  DB 障害・壊れた形は必ず `{learn:true, share:false}` に倒す。**判定不能を共有側に倒さない。**
- 「出す（share）」と「読む（共有プール参照）」は 1 つの同意に統合する。別フラグにしない。
- `/v1/hermes-mcp/*` は静的キー 1 本（`HERMES_MCP_API_KEY`）と nginx の IP allowlist の2段で守られている。
  allowlist は `nginx-rajiuce.new` の `location /v1/hermes-mcp/ { allow 135.181.194.34; deny all; }` として
  api.r2c.biz / r2c.biz の**両方の server ブロック**に入っている（H-2 / PR #1085 で導入、#1114 で本番同期）。
  プレフィックス location なので、この配下にエンドポイントを足せば自動的に保護される。
  ★server ブロックを増やすときは allowlist もその中に入れること★ — 片方だけだと素通しになる。
- 未同意テナントには存在確認すら与えない（403 で統一）。テナント越境は権限エラーではなく**不存在**。
- 同意チェックは他の何よりも先に実行する。`proposals` 側の再検証（defense in depth）を外さない。

## 設計上の約束
- **提案の受け皿を増やさない。** judge 提案 / `suggested_rules` / `knowledge_gaps` / Hermes の 4 系統で打ち止め。
  Hermes 提案は `tuning_rules`（`source='hermes'` / `is_active=false` / `status='pending'`）に着地する。
  `hermes_strategy_proposals` を承認導線として育てない。**承認 API も新設しない**
  （既存の `approveTuningRule` / `rejectTuningRule` を使う）。
- `is_active` が本番に効くか否かの**唯一の真実**、`status` は承認判断の記録。
  不変条件: `status='active' ⇒ is_active=true` / `status='rejected' ⇒ is_active=false`。
  `getActiveRulesForTenant` は `is_active` しか見ない。
- **env だけで有効／無効が決まる機能を新設しない。** 段階開放は `tenants.features`、env は緊急停止用途に限る。
  点火状態が画面に出ないものは、**点火されていないことに誰も気づけない**
  （`LEARNED_MEMORY_ENABLED=true` なのに 0 件のまま、切り分けに SSH が必要だった）。
- 効果計測に新テーブル・新基盤を作らない。既存 analytics と `chat_messages.metadata` で足りる。
- 母数不足のときに `0` や矢印や「効果なし」を出さない。既存 `RateMetric`（`rate: null`）に従う。
- **気づける場所と直せる場所を分けない。** 昇格候補・提案が見える画面に、その操作を同居させる。
- 同意状態の表示は 60 秒 TTL キャッシュ（`getCachedShareConsent`）で最大 60 秒遅れる。
  **即時反映を前提にした仕様・文言を書かない。**

## 絶対にやってはいけないこと
1. **同意判定の述語を新しく書く。** SQL でも JS でも、既存の 1 実装を import する。
2. **承認を注入経路の免罪符にする。** Hermes 提案は外部・モデル由来の入力面であり、
   **人が承認した後も** L5 Input Sanitizer / L6 Prompt Firewall を通す（→ 禁止 33）。
3. **提案の専用テーブル・専用画面・専用通知先を作る**（→ 禁止 31）。
4. **`is_active` を省略して INSERT する。** スキーマ既定 `DEFAULT true` が効いて即座に本番の応答方針へ入る（→ 禁止 5）。
5. **旧 UI `/admin/tuning` の `is_active` トグルで承認を迂回できる状態を残す・増やす**（→ 禁止 45）。
6. **「学習しない」の原因をフラグと配線だけに求める。** 閾値・下限値も同格の容疑者として必ず併記する
   （`memoryDistiller` の score 80 / CV 必須、`sweepCandidates` の `DEFAULT_MIN_MESSAGE_COUNT = 4`）（→ 禁止 43）。
7. **スキーマの適用を確認せずに点火する。** マージ済み・デプロイ済みは本番で動いていることを意味しない。
   migration の自動実行も禁止（人間承認）（→ 禁止 42・8）。
8. **書くだけで読まない同意軸を増やす。** 現在 `features.learning.learn` は書き込み口
   （`tenants/routes.ts` の zod / `actionExecutor.ts`）はあるが、**実行時に読む場所が 1 つも無い**。
   「自社内学習オフ」は現状テナントに約束できていない。新しい軸を足す前にこれを解消する。
9. **Hermes から届いた文字列をそのまま本番に載せる。** `title` は `trigger_pattern` に直接入るが、
   キーワード一致に最適とは限らない（既知の限界）。承認者が編集できる導線を潰さない。
10. **テナント越境を権限エラーとして返す。** 必ず「不存在」側へ（ID の実在が漏れる）（→ 禁止 20・24）。

## テストで最低限
- **端から端まで 1 本。** 会話 → 評価/昇格 → `learned_memory` → **次の会話のプロンプトに含まれる**まで。
  単体がモジュール内で閉じていたため「機能は完成・テストは緑・配線は切れている」前例が複数ある。
- **承認が本番に効くことを固定する。** 承認 → `getActiveRulesForTenant` が返す → プロンプト文字列に含まれる。
  **ステータス列の更新だけを見ない。**
- **同意の 4 ケース。** ①新形式 ②旧フラグのみ ③壊れた形（文字列・配列・不完全）④DB 例外。
  すべてで fail-safe の向き（`share` が true にならないこと）を固定する。
- **越境。** client_admin / super_admin / previewMode の 3 ロールで他テナントに到達しないこと。
- **「無い」と「空」を別のテストで。** ①データあり ②存在するが 0 件(200) ③存在しない(404) ④他テナント(404)。
  ②と③を 1 本にまとめない。
- **母数不足で数値を出さないこと** と **フラグ OFF で従来挙動が変わらないこと** を固定する。
- **更新系は更新行数か更新後の実値をアサートする。** `mockDb.query` に渡った SQL 文字列の一致だけを見るテストは、
  恒久 no-op を緑のまま通す（前例: `invoice.payment_succeeded` が常に 0 行更新）。
- **書いた回帰テストを一度赤くしてから復元する。** 通ることだけを見たテストは条件を取り違えても緑になる。
- **書き込みは E2E で検証できない。** `e2eWriteGuard` が非 GET を 403 にする。結合テストで通すのが唯一の手段。
- **イレギュラー操作を必ず含める。** 承認連打 / 却下済みの同一 `dedup_key` 再投稿で `pending` に復活しないこと /
  昇格済み会話への再昇格で「昇格しました」と嘘をつかないこと / previewMode 中の global 承認 /
  同意トグル変更の 60 秒遅延。

## 命名・エラーハンドリング
- `dedup_key` は Hermes 側が採番し、R2C は `ON CONFLICT ... DO NOTHING` で受ける。
  **重複時に成功を装わない**（`{ duplicate: true }` を返す既存実装を変えない）。
- `scope` は `'global' | 'tenant'` の 2 値。`tenant_id` は `scope='tenant'` で必須、`'global'` では省略必須。
  どちらも 400。**この非対称を緩めない**（global に紛れ込むとテナント固有の型が全テナントへ出る）。
- エラーは `{ error: "snake_case" }` の既存形。400 / 401 / 403 / 500 を 1 つの文言に潰さない
  （設定漏れは 503 `hermes_mcp_not_configured` で fail-closed）。
- 例外は `logger.warn` に構造化して残し、握り潰さない。
  **PII・会話本文・検索語・書籍内容をログとメトリクスラベルに入れない。**
- 通知の宛先は scope で分ける（`global` → `super_admin` / `tenant` → `client_admin`）。
  リンクは**実在するルートのみ**を指す。既存の出し分けを変えない。
- コメントは日本語で **「なぜ」** を書く。意図的な逸脱は書き忘れと区別できる形で理由を残す
  （模範: `hermesConsent.ts` 冒頭のファイル名と実態のズレに関する注記）。
