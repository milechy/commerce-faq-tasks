# 実機UI監査レポート（2026-07-02）

前回の静的grep監査（`2026-06-22-orphan-integration-audit.md`）に対し、今回は本番 `admin.r2c.biz` /
`api.r2c.biz` に実際にログインし、Playwrightでブラウザ操作（クリック・タブ切替・API発行・widget埋め込み）
を行いながら検証した。テストアカウント: `admin@example.com`（super_admin、e2e専用と思われる）。

## 0. 前提: 調査開始直後に本番障害を発見・復旧済み

調査開始直後、`api.r2c.biz` のTLS証明書が **2026-06-28に失効し4日間放置**されていることを発見。
`admin.r2c.biz`（2026-06-14にCloudflare Pages移行済み）とSAN証明書を共有していたため、
Cloudflare側のHTTP-01チャレンジが届かず証明書更新が丸ごと失敗していた。この間、Admin UIの
全API取得・widget.js・avatar-agentの使用量報告が軒並み失敗していたとみられる。

**対処済み**（2026-07-02、本レポート作成と同日）: `certbot certonly --nginx --cert-name api.r2c.biz
-d api.r2c.biz --expand` で証明書を `api.r2c.biz` 単体に変更し復旧（有効期限 2026-09-30）。
詳細は auto-memory `trap_api_cert_shared_san_with_migrated_domain.md` を参照。

**再発防止**: `admin.r2c.biz` を今後このVPSに再統合する変更を行う場合、DNSがCloudflareを向いている
限り証明書のSANに含めてはいけない。また今回、Prometheus/Grafana/Slack AlertEngine（Phase24）に
証明書有効期限の監視が入っておらず4日間気づかれなかった。**証明書失効監視の追加を推奨**。

---

## 1. 【最重要・要修正】CORSプリフライトが per-tenant 許可ドメインを無視 — widgetが外部顧客サイトで機能しない疑い

### 症状
本番相当のwidget埋め込みテスト（`data-tenant`+新規発行APIキー）を実施したところ、FABボタンは
表示されるが、チャット送信・アバター起動などすべてのAPI呼び出しが **ブラウザのCORSブロックで
すべて失敗**した:

```
Access to fetch at 'https://api.r2c.biz/api/chat' from origin 'http://localhost:18080'
has been blocked by CORS policy: Response to preflight request doesn't pass access
control check: No 'Access-Control-Allow-Origin' header is present
```

`localhost`だけでなく、実在しない一般的な顧客ドメイン（`https://mycompany-shop.jp` 等、計3件）で
`OPTIONS /api/chat` プリフライトを直接検証したが、いずれも `Access-Control-Allow-Origin` ヘッダが
**一切返らない**（＝ブラウザは本リクエストを送信せずブロックする）。一方 `https://admin.r2c.biz` を
Originに指定すると正しくヘッダが返る。

### 根本原因（コード確認済み）
- `src/lib/cors.ts` の `corsMiddleware`（グローバル、`app.use()` で全ルートの最初に適用）は、
  起動時の環境変数 `ALLOWED_ORIGINS`（固定リスト）のみを見て `Access-Control-Allow-Origin` を
  設定する。かつ `OPTIONS` リクエストは即座に `res.status(204).end()` して**そこで処理終了**する。
- 一方、テナントごとの「許可ドメイン」（Admin UIの各テナント設定タブにある入力欄、DB
  `tenants.allowed_origins`）を見ているのは `src/api/middleware/originCheck.ts` の
  `originCheckMiddleware` で、これは `authMiddleware` の**後**（apiStack内、実リクエスト処理時）
  にしか実行されない。
- ブラウザのCORS仕様上、非simple request（`Content-Type: application/json` や `X-API-Key` ヘッダを
  使う `/api/chat` 等）は必ず `OPTIONS` プリフライトが先に飛ぶ。プリフライトの応答に妥当な
  `Access-Control-Allow-Origin` が無ければ、ブラウザは**実リクエスト自体を送信しない**。
  → `originCheckMiddleware` がどれだけ正しく実装されていても、プリフライト段階で
  グローバルCORSに弾かれた時点で**絶対に実行されない**。

`cors.ts` 内のコメントには「Per-tenant origin enforcement is handled later by
securityPolicyEnforcer（position 5）」とあるが、実装は `originCheckMiddleware` に名称変更されて
おり、かつ上記の構造的理由でこのコメントが意図する「テナント別ドメイン許可」は**ブラウザ経由の
呼び出しでは機能しない**。

### 影響（要人間確認）
- サーバー側 `ALLOWED_ORIGINS` に明示登録されたドメイン（`admin.r2c.biz` 等、社内ドメインのみ
  と思われる）以外からは、widgetのチャット・アバター機能が**一切動作しない**可能性が高い。
- テナント設定の「許可ドメイン（Widgetを設置するURLを1行に1つ）」欄は、入力してもブラウザ経由の
  実利用には反映されない（DBの`originCheckMiddleware`によるサーバーサイド403判定にしか効かず、
  そこに到達する前にブラウザがブロックする）。
- 唯一の可能性: 本番VPSの `ALLOWED_ORIGINS` 環境変数が実は未設定（空）で `allowedSet.size===0`
  によりワイルドカード反射になっている場合はこの問題は起きない。しかし今回の直接curl検証で
  `admin.r2c.biz` 以外の任意ドメインにヘッダが一切返らなかったことから、**空ではなく固定リストが
  設定されている**と強く推測される。**`.env` の `ALLOWED_ORIGINS` 実値の確認を推奨**（この値は
  機密ではないので確認自体は安全）。

### 推奨アクション
- **要優先確認**: VPSの `ALLOWED_ORIGINS` 実値を確認し、本当に固定リストであれば、
  グローバルCORSミドルウェアがpreflight段階でも `tenants.allowed_origins`（DB）を参照できるように
  修正するか、`ALLOWED_ORIGINS` を空にして per-tenant DB チェック（`originCheckMiddleware`）に
  一本化する設計変更が必要。
- 影響が全テナントの本番機能に及ぶため、コード変更前に実際の顧客ドメインで再現テストを行うことを
  強く推奨。

---

## 2. 新規確認: 500エラー4件（前回の静的監査には未掲載、今回のクリック操作で新規発見）

いずれも実際にタブ/ページを開いた際に発生し、`logger.warn` でサーバーログには残るがユーザーには
「失敗しました」としか出ない。

| # | エンドポイント | 発生箇所 | 原因（コード確認済み） |
|---|---|---|---|
| 1 | `GET /v1/admin/analytics/flow-transitions` | `/admin/analytics/flow`（フロー遷移分析、super_admin専用ページ） | `conversation_flow_logs` テーブルが未作成の疑い。`src/migrations/phase72c_conversation_flow_logs.sql` に「このファイルは人間が手動で実行する（自動適用禁止）」と明記されており、本番未適用の可能性が高い |
| 2 | `GET /v1/admin/tenants/:id/settings-history` | テナント詳細「設定変更履歴」タブ（super_admin専用） | 同じくPhase72-Aの手動マイグレーション `src/migrations/phase72a_tenant_settings_history.sql`（`tenant_settings_history`テーブル）が本番未適用の疑い |
| 3 | `GET /v1/admin/tenants/:id/analytics-summary` | テナント詳細「📉 アナリティクス」タブ | 未特定（`src/api/admin/tenants/analyticsSummaryRoutes.ts:57`）。要個別調査 |
| 4 | `GET /v1/admin/evaluations/stats` | テナント詳細「📊 AI改善レポート」タブ内 | **コードバグ、マイグレーション起因ではない**。`evaluationsRepository.ts` の `getDetailedStats()` が `used_principles`/`effective_principles` カラム（`conversation_evaluations`テーブル、Phase45で `JSONB DEFAULT '[]'` として定義）に対し `unnest()`（PostgreSQL配列関数）を使用しており型不一致でSQLエラー。同テーブルの `getKpiStats()`（kpi-stats エンドポイント、こちらは200で動作）はこの2カラムを参照しないため気づかれていなかった。**修正方法**: `unnest(used_principles)` → `jsonb_array_elements_text(used_principles)` 等に置換 |

**推奨アクション**:
- #1, #2: `src/migrations/phase72a_tenant_settings_history.sql` / `phase72c_conversation_flow_logs.sql` の本番適用状況を確認し、未適用なら実行（DBマイグレーションにつき人間が実行）。
- #4: コード修正で解決可能。`unnest()` → `jsonb_array_elements_text()` へのクエリ修正のみ、他エンドポイントへの影響なし。
- #3: 個別調査が必要（本監査では未着手）。

---

## 3. 前回監査（2026-06-22）の再現確認 — 実クリックで再検証

| 項目 | 前回の分類 | 今回の実クリック結果 |
|---|---|---|
| アバター設定「デフォルトに戻す」ボタン | broken-fe-call #1 | **再現・現存確認**。実際に本番アバター編集画面でクリック → `POST /v1/admin/avatar-configs/{id}/reset-to-default` が404。コードも `avatar-configs`(ハイフン) のまま未修正 |
| テナント詳細「チューニング」タブの有効化/無効化トグル | contract-mismatch #2 | コード確認のみ（`TenantTuningTab.tsx:30` の `method: "PATCH"` は現存）。テストテナントにルールが0件のため実クリック未実施 |
| ABTestTab（A/Bテスト） | orphaned-endpoint #3 | **再現確認**。タブ切替時に `/v1/admin/variants` 系のAPI呼び出しが一切発生せず（発火したのは無関係の通知ポーリングのみ）。MOCK表示のまま |
| ObjectionPatternsTab（反論パターン） | half-wired-feature #1 | **再現確認**。タブ切替時にAPI呼び出しゼロ |
| AIReportTab の判定ルール一覧 | broken-fe-call #2 | **再現確認**。実際に `GET /v1/admin/tuning?tenantId=...&source=judge&status=suggested` が404で発火 |
| BulkActionBar（ナレッジ一括削除） | orphaned-component #8 | **再現確認**。`admin-ui/src/` 全域で自ファイル以外からのimportが依然ゼロ |
| `/admin/knowledge/books` | （前回未掲載） | **誤検知として除外**。`books.tsx`はPhase52e統合済みの意図的リダイレクトで正常動作 |

---

## 4. 全体クロール結果（22ルート）

super_adminで到達可能な全トップレベルルートを巡回。上記の `/admin/analytics/flow` 以外は
console error・4xx/5xx とも検出なし（証明書復旧後）。

---

## サマリ表（優先度順）

| 優先度 | 件名 | 影響範囲 |
|---|---|---|
| 🔴 最優先 | CORSプリフライトが per-tenant 許可ドメインを無視 | 全テナントのwidget外部埋め込み（要ALLOWED_ORIGINS実値確認） |
| 🟠 高 | Phase72マイグレーション2件が本番未適用の疑い（flow-transitions / settings-history 500） | super_admin専用機能のみ、実害は限定的 |
| 🟠 高 | evaluations/stats の型不一致バグ（AI改善レポートタブ） | 全テナントのAI改善レポート「詳細統計」が常に空 |
| 🟡 中 | avatar reset-to-default 404（前回から未修正） | デフォルトアバター編集時のみ |
| 🟡 中 | tuning判定ルール一覧404（前回から未修正） | AI改善レポートタブの判定ルール表示 |
| 🟢 低 | ABTestTab / ObjectionPatternsTab がMOCK表示のまま（前回から未修正） | super_admin限定 |
| 🟢 低 | analytics-summary 500（原因未特定） | テナント詳細アナリティクスタブ |
