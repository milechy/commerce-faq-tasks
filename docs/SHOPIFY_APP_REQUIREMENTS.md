# R2C Shopify アプリ 要件定義

**位置づけ:** 実装ではなく、実装前に固定すべき目的・スコープ・制約・受け入れ条件。
`docs/WORDPRESS_PLUGIN_REQUIREMENTS.md` と同じ章立て・同じ扱い。

**版:** v1.0（初版）
**作成:** 2026-09-05
**前提調査:** Shopify 公式ドキュメント（shopify.dev）・changelog・App Store 掲載規約の実地調査（WebSearch 17件 + WebFetch 19件）。
グローバル競合 18 アプリの App Store 掲載・料金・ポジショニングの実地調査。R2C 実コード（`CLAUDE.md` / `docs/WORDPRESS_PLUGIN_REQUIREMENTS.md`）の読み取り。
**未実施:** shopify.dev の一次ドキュメントでの再確認が必要な項目が複数残る（§10）。本書は「調査済みの範囲での初版」であり、
WordPress 版が v4.1 に至った過程と同様、着手前に §10 を必ず潰すこと。

---

## 0. 決定事項（本セッションで確定）

| # | 決定 | 理由 |
|---|---|---|
| **D1** | **v1 の主武器はテキストチャット接客（FAQ/RAG）。アバターは v2 以降** | Shopify Inbox に純正 AI 販売員が無料標準搭載された（Spring '26、カタログ・在庫・購買履歴連携込み）。まずテキストで差別化点（指示ルール運用 UI・学習ループ・Layer 0〜3 の「売る接客」統合）を磨き実績を作ってから、市場調査で確認した唯一の空白ポジション（リアルタイム音声/映像アバター接客）に進む。開発負荷の観点からも v1 は絞る |
| **D2** | **ターゲット市場は日本の Shopify ストアオーナー優先** | 既存 R2C 本体と同じ日本語 UI・日本語サポート・既存営業チャネルをそのまま流用できる。App Store 掲載自体はグローバル既定だが、集客導線は国内中心とする |
| **D3** | **課金は Shopify Billing（usage-based billing, App Events API）に完全準拠する。既存 Stripe 課金パイプラインとは別建ての新レールとして実装** | Shopify の App Store は原則アプリ内課金を自社の Billing 経由で行うことを前提にしている。会話単位/分単位という R2C の課金思想はメーター定義でそのまま表現できる。既存の `usage_logs` / `stripeSync.ts` 系（直接契約テナント向け）とは独立させ、Shopify 経由テナントは Shopify Billing のみを真実とする |
| **D4** | **v1 のナレッジ投入は手動 FAQ 入力のみ（既存 CopilotUI を流用）。商品データ自動同期は v1.1 以降** | WordPress 版 D3 と同型判断。同期ロジック（差分検知・Admin API ポーリング/Webhook 設計）の新規実装を先送りし、最短で実績作りに進む |
| **D5** | **ウィジェット表示面はテナントが選択できる UI を提供する（商品ページ/カート/配送ポリシーページ等のチェックボックス）** | `CLAUDE.md` 禁止58「面を全ページに出さない」を維持しつつ、既存 TriggerEngine の4種（`page_url_match` / `exit_intent` / `idle_time` / `scroll_depth`）の組み合わせを Theme App Extension の設定画面に持たせる |
| **D6** | **既存 R2C マルチテナント基盤に完全統合する（同一プロダクトの新規取得チャネルとして扱う）** | `tenants` / FAQ / `tuning_rules` / 学習ループを共通化し開発コストを抑える。課金情報のみ流入元を示す列で分離し、Shopify 経由テナントを識別する（WordPress 版 D11 と同型） |
| **D7** | **v1 → v2（アバター投入）の成功基準は既存 Layer 0 基準を流用する（実テナント 10 社・月 500 会話・4 往復以上 20%）** | `CLAUDE.md` 禁止57（層の順序ゲートを飛ばして着手しない）に準拠。Shopify 専用の基準を別途設計するコストをかけない |
| **D8** | **ストアフロント注入は Theme App Extensions（App Embed Block）一択。ScriptTag API は使用しない** | ScriptTag は 2026-10-01 からエラー化、2027-03-01 に完全停止（Shopify changelog で確認済み）。新規アプリで ScriptTag を選ぶ余地は実質ない。WordPress 版の静的フォールバック（`data-tenant` 属性方式）に相当する経路は Shopify 側には作らない |
| **D9** | **管理画面は Shopify Admin 埋め込み（App Bridge, Token Exchange）の薄い設定画面を新設する。ロジック・プロンプト・指示ルールは既存 R2C API（CopilotUI 経由）に委譲する** | Public app の掲載には埋め込みアプリ（App Bridge）が事実上必須。WordPress 版の「管理画面は R2C 側に完全に閉じる」設計はそのままは持ち込めず、Shopify Admin 内に接続・状態確認・遠隔操作用の最小限の画面を持つ必要がある |
| **D10** | **v1 はチェックアウト画面への露出をスコープ外とする（Checkout UI Extensions は v2 以降で検討）** | checkout.liquid 廃止によりチェックアウト面は Checkout UI Extensions 経由でしか触れず、Plus 限定機能もある。Layer 0 の「痛みのある面」検証は商品ページ/カート/配送ポリシーで十分に行える |
| **D11** | **専用リポジトリは新設せず、本体リポジトリ内に `shopify-app/` を新設して `admin-ui/` と同型（独立 `package.json`・独立デプロイ）で配置する（U-2 解消、2026-09-05）** | Shopify App Store には WordPress.org の GPL/ソース公開義務に相当する要件が**無い**ことを確認済み（Shopify アプリはマーチャントのサーバにコードが渡らない SaaS 型のため）。バックエンドロジックは既に D6 で `src/` 内（`register*Routes` パターン）に置くと決めており、Shopify 固有の新規デプロイ物は「Shopify CLI アプリプロジェクト（埋め込み管理画面 + Theme App Extension）」のみ。本体リポジトリは pnpm workspace 化されておらず `admin-ui/` が独立 `package.json`・独立デプロイ（Cloudflare Pages）で共存する前例が既にあり、`shopify-app/` も同型で収まる |
| **D12** | **Shopify 経由テナントは月払いのみ提供する。年払い（2ヶ月無料）は提供しない** | Shopify Billing は `interval` が `ANNUAL` / `EVERY_30_DAYS` の二択で、**従量課金（usage line item）は `EVERY_30_DAYS` にしか組み合わせられない**（確認済み）。R2C 全体の年払い方針（`CLAUDE.md`）を無理に近似せず、Shopify 経由と直接契約とで提供条件が異なることをそのまま受け入れる |
| **D13** | **プランは JPY 建てで明示的に作成する**（Shopify のデフォルトである USD 建てのまま従量課金を発行しない） | プランを USD 建てで作成すると、merchant currency（JPY）建ての従量課金が **USD 建てで返ってくる**ことが確認されている。R2C の「公開価格＝実際の請求額」方針（禁止54）を満たすには JPY 建てでのプラン作成が必須 |
| **D14** | **アプリ名は `R2C – AI Sales Concierge`。掲載カテゴリは `Store management > Support > Chat`（U-1 解消、2026-09-05）** | Shopify のアプリ名規約は「ブランド名始まり・30文字以内」（確認済み、"QTeck – Announcement Bar" 型）。WordPress 版の名称（約47文字）はそのままでは長すぎるため短縮。「AI Sales Concierge」で Shopify Inbox との差別化軸（学習ループ・チャネル横断による「売る接客」）を名前に込める。URL スラッグはアプリ名から**自動生成**されるため WordPress 版 D4 のような別途スラッグ決定は不要。カテゴリは競合（Shopify Inbox・Rep AI・Chatty 等）の実掲載先が `Store management > Support > Chat` であることを確認し、発見性を優先してこれに合わせる。「R2C」名義の既存アプリとの衝突は調査範囲で確認されず |
| **D15** | **GDPR 3 Webhook の削除フローを破壊力に応じて分ける（U-8 解消、2026-09-05）**: `customers/data_request` は自動応答（削除を伴わない）。`customers/redact` は単一顧客の PII をテナント+顧客 ID スコープで自動削除し監査ログに記録する。**`shop/redact` はテナント全データの不可逆削除に相当するため、受信時は「削除保留」としてマークするのみに留め、実際の削除は人間の承認操作を経て実行する** | `CLAUDE.md` 禁止8「不可逆操作は人間承認」を適用。`customers/redact` はスコープが単一顧客に限定され誤爆の影響が小さいため自動実行で足りるが、`shop/redact` はテナント丸ごとの削除であり誤動作時の被害が甚大。Shopify が求める対応期限（30日）内に人間の承認を得れば足りるため、承認までの猶予はある。**保留件数・期限を監視し、承認が無いまま期限に近づいたらアラートを出す**（禁止50「監視対象が0件のときに異常なしと報告しない」と同型の設計とし、「保留0件」を放置せず可視化する） |
| **D16** | **削除保留中（`shop/redact` 受信後・人間承認前）に同一ストアが再インストールした場合は、保留を解除して既存テナントを復元する。人間承認後（削除実行後）の再インストールは新規テナントとして扱う**（2026-09-05、レビューで発見した抜け穴を解消） | 保留中はデータが物理的に消えていないため復元は安全（D15 の設計上自明）。WordPress 版 I-3/I-4（アンインストール→再インストールで二重テナントを作らない）と同型の考え方を、Shopify の「削除保留」概念に合わせて具体化した |
| **D17** | **App Store 掲載はグローバル公開のまま維持し、日本以外のマーチャントには Shopify 側の通貨換算表示（USD 等）をそのまま受け入れる**（2026-09-05、D2/D13 の緊張を解消） | D2 で「集客導線は国内中心」と決めているため、海外マーチャントへの影響は限定的。地域限定公開の技術的可否も未確認のまま構造的制約を先取りするより、実害が出た時点で対処する方が v1 の速度を優先できる。「公開価格＝実際の請求額」方針（禁止54）は日本テナントに対しては引き続き成立する |
| **D18** | **ウィジェット表示面（商品ページ/カート/配送ポリシー等）選択の真実は、埋め込み管理画面（App Bridge）側に置く。** Theme Editor の App Embed Block 側は ON/OFF と表示位置（オフセット）のみを持ち、面の詳細選択は持たない（2026-09-05、D9/D5 の未規定部分を解消） | D9「設定の真実は R2C 側 DB」の原則をそのまま面選択にも適用する。Theme Editor（テーマ単位の設定）に真実を置くと、テーマ切替で設定が引き継がれず D9 と矛盾する |
| **D19** | **Shopify Billing の課金承認（アクティブな subscription）が無い、または失効した状態では、テキストチャット機能を稼働させない。** 新規の停止ロジックは作らず、既存 `src/lib/billing/suspensionGate.ts`（未払い/解約テナントを active/grace/restricted/suspended の4段階で止める既存ゲート）に Shopify Billing の subscription 状態を接続する（2026-09-05、実装制約の調査中に発見した抜け穴を解消） | `CLAUDE.md` 禁止10「費用が発生する操作を、計上しないまま／課金が成立しないまま開放しない」を適用。**Shopify はインストール＝課金承認ではない**（マーチャントが課金画面で明示的に承認するまで `AppSubscription` は `PENDING` のまま）。ここを見落とすと、インストールだけして課金を承認しないマーチャントの会話コストを R2C が無償で負担し続ける穴になる。`suspensionGate.ts` は既にこの種の「支払いが止まっても提供が止まらない」問題を解決するために作られた仕組みであり、Shopify 版でも新設せずこれに接続する |

---

## 1. 目的

R2C の AI 接客チャットを、**Shopify ストア運営者が管理画面から数クリックで導入できる**ようにする。
現状の導入経路（テナント登録 → API キー発行 → HTML 貼り付け）は Shopify のテーマ編集を要し、
かつ Shopify の技術的制約（ScriptTag 廃止）によりそのままでは持ち込めない。

**成功の定義（v1.0）:**

1. Shopify App Store に公開掲載されている
2. ストアの Theme Editor から App Embed Block を有効化するだけで、テーマコードを一切編集せずにチャットが稼働する
3. アプリインストールから稼働までの所要時間が **10 分以内**（Shopify は OAuth 承認フローを挟むため WordPress 版の 5 分より長めに見積もる）
4. 「Shopify Inbox の無料 AI 販売員と何が違うか」を導入時の1画面で明示できている（§2.1 の実存的な問い）

---

## 2. Shopify App Store 適合マトリクス

**本章が本要件で最も重要。** ここを外すと審査で落ちるか、掲載後に機能停止に追い込まれる。
一次資料は付録参照。**★印は「要確認」＝ shopify.dev の一次ドキュメントで着手前に再確認すべき項目。**

| # | 要件 | R2C の現状 | 判定 | 対応 |
|---|---|---|---|---|
| 1 | Public app は事実上すべて埋め込みアプリ（App Bridge 必須、2024-03-13以降） | 未着手 | 要対応 | 最新 App Bridge を使い、Token Exchange（セッショントークン→アクセストークン交換）で認証する（FR-01） |
| 2★ | Polaris の適用範囲（全面強制か、オンボーディング等の一部か） | 未確認 | 要確認 | 着手前に shopify.dev で確定させる。**最低限、オンボーディング/接続導線は Polaris 準拠にする**方針で見積もる |
| 3 | **ストアフロント注入は Theme App Extensions（App Embed Block）が唯一の現行手段**。ScriptTag は 2026-10-01 エラー化 → 2027-03-01 完全停止 | 未着手 | 要対応 | v1 から Theme App Extension を実装。ScriptTag 経路は作らない（D8） |
| 4 | Online Store 2.0 非対応（レガシー）テーマへの対応 | — | 対応不要 | v1 スコープ外と明示する。対応優先度を上げない |
| 5 | チェックアウトは checkout.liquid 廃止済み、Checkout UI Extensions のみが拡張点 | — | 対応不要 | v1 スコープ外（D10） |
| 6 | **課金は Shopify App Pricing / usage-based billing（App Events API）が標準** | 未着手 | 要対応 | 会話単位課金をメーター定義で表現する（§5、D3） |
| 7 | レベニューシェアは生涯累計 $1,000,000 まで 0%、以降 15%（年次リセットは撤廃済み） | — | 確認済み | 当面の事業規模では実質無視できる。将来の値付けシミュレーションにのみ影響 |
| 8 | **GDPR 必須 Webhook**（`customers/data_request` / `customers/redact` / `shop/redact`）は現在も必須 | 未着手 | 要対応 | `shopify.app.toml` の `compliance_topics` で宣言、HMAC 検証必須、`shop/redact` はアンインストール 48 時間後着信、30 日以内に対応する（FR-14〜16） |
| 9★ | 2026-01-01 で静的トークン/レガシー private app 完全廃止、2026-04-01 から Public app は有効期限付き offline access token 必須という情報あり | 未確認 | 要確認 | 着手前に shopify.dev の一次情報で日付・要否を再確認する |
| 10 | **Built for Shopify バッジ**: Performance（ストア速度低下 10 ポイント以内）/ Design（Polaris 準拠）/ Integration（最新 API・App Bridge）の3軸、年次再審査 | — | 任意だが推奨 | 競合の多くがバッジ有無を明示していないため、早期取得できれば App Store 掲載露出で優位に立てる（戦略メモ §後述） |
| 11 | **EU AI Act 第50条（2026-08-02 施行）**: AI と直接対話するシステムは対話開始前に「AI であること」を明示する義務 | R2C 全体方針に既に含まれる | OK | Shopify 版ウィジェットにも同一適用。追加設計は不要（既存の開示 UI パターンを流用） |
| 12★ | 独自 Stripe 課金を Shopify App 内で前面に出すことの審査可否 | 未確認 | D3 で解消済み | Shopify Billing に完全準拠する方針を確定させたため、この論点自体を回避する |
| 13 | Shopify Sidekick はマーチャント向け内部業務 AI であり、ストアフロントで買い物客とチャットする機能ではないと公式に明言されている | — | 確認済み | サードパーティの顧客対面 AI 接客に対する Shopify 純正の直接的な代替ロードマップは確認できず（継続監視は要る） |

### 2.1 存在論的な問い（検証済み・2026-09-05）

Shopify Inbox の無料 AI 販売員（Spring '26）は、カタログ/在庫/購入履歴連携込みで **全プラン無料・日本語含む20言語対応** である。
**「R2C は Shopify Inbox と何が違うのか」を U-6 として WebSearch/WebFetch で実地検証した（一次情報: eesel AI, ReplAi, Shopify公式ほか。§10 参照）。**

| 差別化仮説 | 判定 | 根拠 |
|---|---|---|
| ① 指示ルール編集/承認 UI | **部分的に持つ（基礎レベル）。R2C の構造化ガバナンス（方針/文体分離・Judge提案→承認フロー）は無い** | Shopify Inbox は「Instant Answers」「Quick Replies」中心。トーン・スタイルの基礎的な制御は謳われるが承認フローの証拠なし |
| ② Judge 学習ループ | **持たない（最も明確な差）** | 複数出典で「過去のやり取りから学習しない」「毎回人間が見る必要がある」と明言 |
| ③ 複数チャネル横断展開 | **持たない（最も明確な差）** | Shopify + Facebook Messenger のみ。WhatsApp・Instagram DM・自社サイト・WordPress 非対応 |
| ④ FAQ+売る接客の統合設計 | **部分的に持つ（商品推薦・チャット内購入）。多段階の商談進行制御（clarify→propose→recommend→close）は無い** | 「assisted, not autonomous」「minimal task execution beyond templated replies」 |
| ⑤ アバター接客への拡張 | **持たない** | 言及・機能とも確認できず |

**結論: 差別化は成立するが、「FAQ に答えられる」という土俵だけでは拮抗する。** 単純な一問一答を前面に出すと無料の
Shopify Inbox と同一視されるリスクが高い。**v1 の App Store 掲載文言・オンボーディング画面は②学習ループと
③チャネル横断を軸に据える。** 候補文言:

- 「Shopify Inbox は覚えない店員、R2C は会話のたびに賢くなる店員」（学習ループ）
- 「Shopify Inbox はストアの中だけ、R2C は自社サイト・将来のアバターまで同じ『売れる店員』を連れて行ける」（チャネル横断）

U-6 は解消済みとして扱う。ただし競合（Gorgias/Tidio）が Shopify Inbox 無料化にどう価格改定で反応したかは未確認のまま
（優先度低、必要なら別タスク）。

---

## 3. アーキテクチャ

```
Shopify ストア
├── Shopify Admin（埋め込みアプリ、App Bridge）
│   └── R2C 設定画面 ── REST/GraphQL ──> api.r2c.biz/v1/public/shopify/*   [新規実装]
│                                         （OAuth・プロビジョニング・設定同期・Billing連携）
│
└── ストアフロント（Theme App Extension / App Embed Block）
    └── App Embed Block が widget script を注入
                                  ↑ 既存の動的配信ルートを Shopify 向けに拡張
                                    src/api/widget/routes.ts
```

**プラグイン（アプリ）は可能な限り薄いラッパーに徹する。** ウィジェットの実装・プラン判定・ブランディングは
既存どおりサービス側（R2C API）に置く。ただし D9 のとおり、**接続・状態確認・遠隔操作の画面だけは
Shopify Admin 内に埋め込む必要があり**、WordPress 版より薄さの度合いは一段階下がる。

### 3.1 既存の配布経路との関係

`CLAUDE.md` 禁止38 のとおり、ウィジェット配布は既に複数経路がある。Shopify 版は**新しい第4の経路**として
Theme App Extension 専用の注入方式を追加するが、**既存の①動的版・②静的版・③フォールバックのいずれとも独立**させ、
Shopify ストアが誤って②（`data-tenant` 静的版、プラン判定を経由しない fail-open 経路）を使う余地を作らない。

| 経路 | 内容 | Shopify 版での扱い |
|---|---|---|
| ①`GET /widget/:tenantSlug.js` | テナント設定を注入する動的版 | **Theme App Extension が読み込む対象として流用**（設定注入ロジックは共通化） |
| ②`public/widget.js` + `data-tenant` | プラン判定を経由しない静的版（fail-open） | **使わない**。Shopify 側の設定入力経路をこの静的版に誤って繋がないこと |
| ③ `db === null` 時に①が②へリダイレクト | 既知の穴 | 制御不能。DB 障害時の挙動として受容し、受け入れ条件には含めない（WordPress 版と同じ扱い） |

### 3.2 リポジトリ配置（D11・確定）

```
commerce-faq-tasks/            ← 本体リポジトリ（新設リポジトリなし）
├── src/                       ← 既存バックエンド。/v1/public/shopify/* をここに追加（D6）
├── admin-ui/                  ← 既存管理画面（Cloudflare Pages デプロイ）
└── shopify-app/               ← 新設。Shopify CLI アプリプロジェクト（独立 package.json）
    ├── shopify.app.toml
    ├── app/                   ← 埋め込み管理画面（Remix/App Bridge、Shopify Admin 内で表示）
    └── extensions/
        └── r2c-widget/        ← Theme App Extension（App Embed Block）
```

- `shopify-app/` は `admin-ui/` と同じ扱い（独立 `node_modules`・独立ビルド・独立デプロイ）。
  root の `pnpm verify`（Gate 1）の対象には含めない。デプロイは `shopify app deploy`（Shopify CLI）で、
  `SCRIPTS/deploy-vps.sh` とは完全に別系統とする。
- `shopify-app/app/`（埋め込み管理画面）から `src/` の型・スキーマを直接 import しない
  （デプロイ物が分かれる以上、型は API 契約（Zod スキーマ等）越しに合わせる。共有したい場合は
  `src/api/widget/` 相当の契約ファイルを参照する形に留め、ビルド時 import 依存を作らない）。
- Gate 構成への組み込み（新しい Gate を足すか、既存 Gate 3 相当に含めるか）は実装着手時に
  `docs/TEST_DEPLOY_GATE.md` 側で検討する（本書のスコープ外）。

---

## 4. 機能要件

### 4.1 接続・プロビジョニング

| ID | 要件 | 根拠 |
|---|---|---|
| **FR-01** | OAuth 2.0 + Token Exchange でインストールを完了する。埋め込みアプリとして App Bridge のセッショントークンからアクセストークンを取得する | Shopify App Store 要件 |
| **FR-02** | インストール完了時、`shop` ドメインを唯一のテナント識別子としてテナントを自動作成する（既存テナントとの重複時は WordPress 版 D-1 と同型の突合を行う） | D6 |
| **FR-03** | 既に R2C アカウントを持つテナントのため、**既存テナントへの接続要求として扱う経路**を用意する（新規重複作成を防ぐ） | 実務・WordPress版X-3と同型 |
| **FR-04** | アンインストール時は `app/uninstalled` Webhook を受け、ウィジェットの新規表示を止める。**テナントと会話データは即座に削除しない**（GDPR redact webhook 到着まで保持する） | データ保全・コンプライアンス |
| **FR-04a** | `shop/redact` による削除保留中（人間承認前）に同一ストアが再インストールした場合、削除保留を解除して既存テナントを復元する。承認後（削除実行後）の再インストールは新規テナントとして扱う（D16） | データ保全・コンプライアンス |

### 4.2 ウィジェット出力・面の選択

| ID | 要件 |
|---|---|
| **FR-05** | Theme App Extension（App Embed Block）としてウィジェットを実装し、Theme Editor から有効化できるようにする |
| **FR-06** | **表示面をテナントが選択できる UI を埋め込み管理画面（App Bridge）に提供する**（商品ページ/カート/配送ポリシーページ等のチェックボックス。既存 TriggerEngine の4トリガー種別にマッピング）。**真実は R2C 側 DB であり、Theme Editor の App Embed Block 側には面の詳細選択を持たせない**（D5・D18） |
| **FR-07** | 表示位置（オフセット等）は既存 `public/widget.js` の値域（0〜320px）に従う |
| **FR-08** | 設定変更の反映タイミング（キャッシュ有無・遅延）を UI に明示する |

### 4.3 管理画面 UX（Shopify Admin 埋め込み）

| ID | 要件 |
|---|---|
| **FR-09** | 埋め込み設定画面に接続状態（テナント ID・現在のプラン・稼働可否）を表示する。**設定の真実は R2C 側 DB**とし、WordPress 版 D9 と同じ思想を踏襲する |
| **FR-10** | 未接続/未設定時のみ、Shopify Admin 内の通知領域に案内を出す。過度な通知でストアオーナーの操作を妨げない |
| **FR-11** | エラー時は解決方法を伴うメッセージを出す（`CLAUDE.md` の「エラーハンドリング」節と同一方針） |
| **FR-12** | 接続完了後、「次にやること」（FAQ を CopilotUI で登録する等）と R2C App（CopilotUI）への導線を出す。WordPress 版 D10 と同じく、**Shopify Admin 内で FAQ 登録・有人対応・課金操作を再実装しない** |

### 4.4 コンプライアンス

| ID | 要件 |
|---|---|
| **FR-13** | AI との対話であることを、対話開始前に明示する（EU AI Act 第50条対応。既存 R2C 全体方針を流用） |
| **FR-14** | GDPR 必須 Webhook（`customers/data_request` / `customers/redact` / `shop/redact`）を実装し、`shopify.app.toml` の `compliance_topics` で宣言する |
| **FR-15** | 全 Webhook 受信で HMAC 検証を行う |
| **FR-16** | `shop/redact` 受信後、テナントを「削除保留」状態にマークし、Super Admin 画面に保留一覧・期限（受信日+30日）を表示する。実際の削除は人間の承認操作を経て実行する（D15）。承認が無いまま期限に近づいたらアラートを出す |
| **FR-16a** | `customers/redact` 受信後、当該顧客の PII を対象テナントの会話履歴等から自動削除し、監査ログ（`agentAuditLog.ts` 相当）に記録する（D15） |
| **FR-16b** | `customers/data_request` 受信後、保持しているデータの一覧を Shopify の求める形式で自動応答する（削除は伴わない）（D15） |

---

## 5. サーバー側の新規実装

### 5.1 新設エンドポイント（案）

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/v1/public/shopify/install` | OAuth 開始 |
| `GET` | `/v1/public/shopify/callback` | OAuth コールバック、テナント作成/紐付け |
| `POST` | `/v1/public/shopify/webhooks/app-uninstalled` | アンインストール処理 |
| `POST` | `/v1/public/shopify/webhooks/customers-data-request` | GDPR: データ開示要求 |
| `POST` | `/v1/public/shopify/webhooks/customers-redact` | GDPR: 顧客データ削除 |
| `POST` | `/v1/public/shopify/webhooks/shop-redact` | GDPR: ストアデータ削除 |
| `GET/PATCH` | `/v1/public/shopify/settings` | 表示面・オフセット等の設定同期（WordPress 版の `/v1/public/wp/settings` と同型） |

既存 WordPress 版と同じく、**`register*Routes(app, db)` の形で `src/index.ts` の登録列に並べる**（`CLAUDE.md` の実装置き場所規約）。

### 5.2 Shopify Billing 連携（U-5 解消・2026-09-05）

**確定事項（D12・D13）**

| # | 決定 | 理由 |
|---|---|---|
| **D12** | **Shopify 経由テナントは月払いのみ提供する。年払い（2ヶ月無料）は提供しない** | Shopify Billing は `interval` が `ANNUAL` / `EVERY_30_DAYS` の二択で、**従量課金（usage line item）は `EVERY_30_DAYS` にしか組み合わせられない**（確認済み）。R2C 全体の年払い方針（`CLAUDE.md`）を無理に近似せず、Shopify 経由と直接契約とで提供条件が異なることをそのまま受け入れる |
| **D13** | **プランは JPY 建てで明示的に作成する**（Shopify のデフォルトである USD 建てのまま従量課金を発行しない） | プランを USD 建てで作成すると、merchant currency（JPY）建ての従量課金が **USD 建てで返ってくる**ことが確認されている。R2C の「公開価格＝実際の請求額」方針（禁止54）を満たすには JPY 建てでのプラン作成が必須 |

**設計**

Shopify App Pricing は 2026 年時点で **1アプリ最大8公開プラン・1プラン最大5メーター・1メーター最大6段階の tier** をサポートする（確認済み、R2C の4プランは余裕で収まる）。

| R2C プラン | Shopify 側の表現 |
|---|---|
| Starter（純従量 ¥20/会話） | 固定額 ¥0 + `conversation` メーターの単純従量。JPY 建て、`interval: EVERY_30_DAYS` |
| Standard（¥9,800/月） | 固定額 ¥9,800（一定会話数を内包）+ 超過分を `conversation` メーターで従量。JPY 建て、`EVERY_30_DAYS` |
| Growth（¥29,800/月） | 同上の会話数枠を拡大した版。アバター投入後は `avatar_minutes` メーターを同一プランに追加（1プラン5メーターの上限内） |
| Enterprise（個別） | **Shopify Billing 内で公開プランとして扱うか、Shopify 外で直接契約するかは未確定（U-10 として新規計上）** |

- 会話単位課金・分単位課金は **App Events API**（旧 App Usage Record API から移行済みの現行推奨方式）のメーター定義で報告する。event_handle は Partner Dashboard で定義したメーターの handle と一致させる
- 既存 `usage_logs` テーブルへの記録は継続する（原価可視化のため）が、**請求の起点は Shopify 側のメーター報告**とし、既存 Stripe 課金レール（`stripeSync.ts` / `computeExpectedBilling`）とは独立させる（D3 の再確認）
- 冪等キー設計は既存の `request_id` / 実行系冪等キーの規約（`CLAUDE.md` 命名節）を踏襲する。App Events API のイベントは**恒久的に冪等性が保護される**ことを確認済み
- **★運用上の注意**: App Events API は同期的な課金エラーを返さない（常に202を返し、検証失敗は Partner Dashboard の Logs でのみ確認できる）。**計上の失敗が沈黙する構造**（`CLAUDE.md` 禁止41〜43 と同型のリスク）のため、既存の原価集計（`tenantEconomics.ts`）側で「Shopify 経由テナントの usage_logs 件数と Shopify 側報告件数の突合」を監視項目に加える必要がある（実装時に設計）
- 請求書は R2C 単独では発行されず、**Shopify 本体の請求（Settings > Billing）に他アプリと合算表示される**。「公開価格＝実際の請求額」という透明性の訴求自体は成立するが、独立した請求書体験にはならない点をオンボーディングで明示する

### 5.3 テナント流入元の識別（2026-09-05 実装時に訂正）

**訂正**: 当初「`tenants` に新規列 `inflow_source` を追加する」としていたが、実装着手時（Asanaタスク01）の
実機確認で、テナント流入元を識別する列は既に `tenants.provisioning_source`（`src/migrations/phase79_tenants_provisioning_source.sql`、
CHECK制約 `manual`/`wordpress_plugin`、`wpProvisionRoutes.ts`のINSERT・`actionExecutor.ts`の分岐・`routes.ts`のSELECTで参照済み）
として実運用されていることが判明した。CLAUDE.md禁止6（同じ関心事を2列に複製したまま片方だけ直さない）に従い、
**新規列は作らず、既存 `provisioning_source` のCHECK制約に `'shopify_app'` を追加する**形で実装した
（PR 1228）。以降このドキュメント内の「流入元列」「inflow_source」の記述はすべて `provisioning_source` を指す。

---

## 6. 非機能要件

| ID | 要件 |
|---|---|
| **NFR-01** | Theme App Extension は Online Store 2.0 テーマのみ対応。レガシーテーマは非対応と明示する |
| **NFR-02** | Built for Shopify の Performance 基準（ストア速度低下 10 ポイント以内）を満たす実装にする |
| **NFR-03** | R2C API 到達不能時もストアフロントが無傷であること（保存済み設定のみに依存し、リクエスト時に問い合わせない。WordPress 版 NFR-06 と同型） |
| **NFR-04** | 国際化: UI 文字列は日本語を主とし、英語（App Store 掲載要件のため最低限）を用意する |
| **NFR-05** | フロントへの追加負荷: App Embed Block が出力するのは widget script 1本のみ |

---

## 7. 受け入れ条件

WordPress 版 §7 と同じ粒度・同じ区分（A〜F）で、Shopify 開発ストアを使って確認する。
**「実装した」ではなく「この手順で確認した」で判定する。** 実装上の制約は §11、テスト観点は §12。

### A. Shopify App Store 適合（1つでも欠けると審査に通らない、または掲載後に機能停止させられる）

| # | 条件 | 確認方法 |
|---|---|---|
| A-1 | Theme Editor から App Embed Block を有効化するだけでチャットが表示される（テーマコード編集不要） | 開発ストアで通しで実施 |
| A-2 | App Bridge + Token Exchange で認証が完結し、レガシーな OAuth リダイレクト方式を使っていない | コードを grep し、`shopify.dev` の現行方式と一致することを確認（U-4 解消後に最終確認） |
| A-3 | ストアフロント注入に ScriptTag API を一切使用していない | `ScriptTag` で全コードを grep し 0 件（D8） |
| A-4 | GDPR 必須 Webhook（`customers/data_request` / `customers/redact` / `shop/redact`）が実装され、`shopify.app.toml` の `compliance_topics` で宣言されている | 設定ファイルと実装を突き合わせる |
| A-5 | 独自 Stripe 決済 UI をアプリ内（埋め込み管理画面・チャット内）に一切表示していない | 画面を目視。課金導線は Shopify Billing の標準 UI のみであること |
| A-6 | アプリ名が30文字以内・ブランド名始まりである | `R2C – AI Sales Concierge`（24文字）を確認（D14） |
| A-7 | AI との対話であることが対話開始前に明示されている | ウィジェット初回表示のスクリーンショットで確認（EU AI Act 第50条） |
| A-8 | Shopify の商標をアプリアイコン・バナー・スクリーンショットで互換性表示以上に使っていない | 掲載素材を目視 |

### B. 機能（利用者から見た成立条件）

| # | 条件 | 確認方法 |
|---|---|---|
| B-1 | インストールから稼働まで10分以内で完了する | 開発ストアで通しで計測（§1 の成功の定義） |
| B-2 | 表示面の選択（商品ページ/カート/配送ポリシー等）が埋め込み管理画面での操作どおりにストアフロントへ反映される | 各面を個別に ON/OFF して確認（D5・D18） |
| B-3 | **埋め込み管理画面と CopilotUI の両方を開いたとき、どちらから見ても同じ最新値が表示される** | 片方で変更後、もう片方を開いて stale 表示が無いことを確認（D9・D18、WordPress 版 B-6 と同型） |
| B-4 | テーマを切り替えて App Embed Block が無効化された場合、埋め込み管理画面側で「ウィジェットが表示されていません」と検知・案内が出る | テーマ切替後に埋め込み管理画面を開く（§12.3 I-1） |
| B-5 | アンインストール後、フロントに R2C の通信が残らない。ただしテナントと会話データは即座に削除されない | ページソースとネットワークログを確認 |
| B-6 | 削除保留中（`shop/redact` 受信後・人間承認前）に同一ストアを再インストールすると、新規テナントを作らず既存テナントが復元される | X-1 の状態から再インストールして確認（D16） |
| B-7 | Super Admin 画面で Shopify 経由テナントが流入元（`shopify_app`）として識別できる | 一覧を確認 |

### C. セキュリティ

| # | 条件 | 確認方法 |
|---|---|---|
| C-1 | HMAC 検証に失敗した Webhook リクエストは 401 で拒否される | 署名を改ざんしたリクエストを送る |
| C-2 | OAuth の `state` パラメータが検証され、不一致・再利用を拒否する | state を差し替えて callback を叩く |
| C-3 | 発行されたアクセストークンで `/v1/admin/*`（管理 API）を叩けない | そのトークンで管理エンドポイントを叩き 401/403 になること |
| C-4 | レートリミッタが認証前は IP キー、認証後はテナントキーの2段になっている（単一バケットでない） | 1テナントの過負荷が他テナントを巻き添えにしないことを確認（禁止28） |
| C-5 | Shopify の webhook secret と既存 `WIDGET_JWT_SECRET` / `SUPABASE_JWT_SECRET` が別鍵である | 環境変数・署名検証コードを確認（禁止27） |

### D. 課金・原価

| # | 条件 | 確認方法 |
|---|---|---|
| D-1 | **Shopify Billing の課金承認（`AppSubscription` が `ACTIVE`）が無い状態では、テキストチャット機能が動かない** | インストール直後・課金未承認の状態でチャットを呼び出し、`suspensionGate.ts` 相当の停止状態になることを確認（D19） |
| D-2 | 会話単位/分単位のメーター報告（App Events API）が実際の請求に反映される | 開発ストア/テストモードで確認 |
| D-3 | プランが JPY 建てで作成され、日本のマーチャントに ¥ 表示される | Partner Dashboard の実際の画面で確認（D13） |
| D-4 | `usage_logs` への記録件数と Shopify 側のメーター報告件数が突合できる | §5.2 の監視項目を実際に動かして差分が検出できることを確認 |
| D-5 | `shop/redact` の削除保留件数・期限が Super Admin 監視画面に表示され、**0 件のときに「異常なし」と表示しない** | 保留 0 件の状態で画面を開く（禁止50） |

### E. コンプライアンス

| # | 条件 | 確認方法 |
|---|---|---|
| E-1 | `shop/redact` は人間の承認操作を経て初めて実データが削除される（自動削除されない） | 承認前後の DB 状態を比較（D15） |
| E-2 | `customers/redact` は対象顧客の PII のみを自動削除し、監査ログに記録が残る | 他顧客のデータに影響しないことを確認 |
| E-3 | `customers/data_request` は削除を伴わず、保持データの一覧を返す | レスポンス内容を確認 |
| E-4 | 承認が無いまま削除保留の期限（受信日+30日）に近づいたらアラートが発火する | 期限を短縮したテスト環境で発火を確認 |

### F. 回帰（既存を壊していないこと）

| # | 条件 | 確認方法 |
|---|---|---|
| F-1 | WordPress 版・直接契約テナントの動作に影響が無い | 既存テストスイートが全て通ること |
| F-2 | R2C API 停止中でもストアフロントが正常に表示される（保存済み設定のみに依存） | API を落とした状態でフロントを開く（NFR-03） |
| F-3 | CI と同じ範囲でテストが通る | 部分実行で判定せずフルスイートを回す |

---

## 8. スコープ外（v1.1 以降）

| 項目 | 備考 |
|---|---|
| 商品データ（説明文・配送ポリシー等）の自動同期 | Admin API からの取り込み・差分同期が必要（D4） |
| Checkout UI Extensions によるチェックアウト面露出 | Plus 限定機能の扱いが未確定（D10） |
| アバター接客（Layer 1 相当） | D1・D7 の成功基準達成後 |
| 複数 Shopify ストアの組織単位統合（Plus Organization） | v1 は shop domain 単位のテナントのみ |
| Shopify Flow / Functions との連携 | 現時点で具体ユースケース未検討 |

---

## 9. 戦略メモ（要件定義に先立つ市場調査の要約）

詳細な競合一覧・出典は本セッションの調査結果を参照（別途アーカイブ推奨）。要点のみ:

1. **Shopify Inbox の無料 AI 販売員が最大の変数。** テキストのみで戦う場合、差別化点を明確に言語化できないまま
   App Store に出すと「無料の Shopify 純正機能で足りる」と判断されるリスクが高い（§2.1）。
2. **リアルタイム音声/映像 AI アバター接客は、公開価格を持つ Shopify 向け競合が調査範囲で発見できなかった**（唯一近い
   「Daylily」は App Store から非公開）。これは D1 で v2 以降に位置づけたアバター投入の戦略的根拠になる。
3. **競合の価格体系は総じて不透明・複雑**（二重課金・価格断崖・営業経由の非公開見積り）。R2C の公開価格・
   会話単位課金（既存方針）をそのまま貫くことが、レビュー・評判形成における差別化になりうる。
4. **市場は「サポートコスト削減」と「商品発見/売上向上」に二極化**しており、両者を統合する「買う気にさせる店員」
   （Layer 0〜3）は市場の空白に近い。
5. **Built for Shopify バッジの審査軸は Performance/Design/Integration のみで AI 品質は問われない。** 早期取得が
   App Store 掲載露出の実利につながる可能性がある。

---

## 10. 着手前に潰すべき未決定事項

WordPress 版と異なり、本書は初版のため未決定が多く残る。実装着手前に以下を確定させること。

| # | 論点 | 確認方法/決め方 |
|---|---|---|
| ~~U-1~~ | ~~アプリ名・slug・App Store 掲載カテゴリ~~ | **解消済み（2026-09-05）**。D14 参照 |
| ~~U-2~~ | ~~リポジトリ配置~~ | **解消済み（2026-09-05）**。本体リポジトリ内 `shopify-app/` に配置。§3.2・D11 参照 |
| U-3 | Polaris の適用範囲の正確な境界（§2 の2★） | shopify.dev 一次ドキュメントで確認 |
| U-4 | 2026-04-01 の offline token 必須化の要否・日付（§2 の9★） | shopify.dev 一次ドキュメントで確認 |
| ~~U-5~~ | ~~Shopify App Pricing の UI と R2C 独自プラン体系の対応関係~~ | **解消済み（2026-09-05）**。D12・D13・§5.2 参照 |
| ~~U-6~~ | ~~「Shopify Inbox と何が違うか」の検証（§2.1）~~ | **解消済み（2026-09-05）**。学習ループ・チャネル横断が最も明確な差別化根拠と判定。§2.1 参照 |
| U-7 | Daylily（アバター系競合）が App Store から非公開になった理由 | 可能であれば Wayback Machine 等でレビュー内容を確認し、需要不在か規約違反かを見極める（D1 の前提検証） |
| ~~U-8~~ | ~~GDPR `shop/redact` 受信後の削除フロー~~ | **解消済み（2026-09-05）**。D15・FR-16/16a/16b 参照 |
| U-9 | 開発ストア（Shopify Partner Dashboard）のセットアップ | 実装着手前に用意 |
| U-10 | **Enterprise（個別見積り）プランを Shopify Billing 内で扱うか、Shopify 外で直接契約するか**（§5.2 D12/D13 の派生課題） | Shopify App Pricing に一度 opt-in すると Billing API 経由の自由な個別課金作成ができなくなる可能性が示唆する記述があるが未確証。Partner Dashboard の実際の設定画面で検証してから決める |
| ~~U-11~~ | ~~§11（実装上の制約）・§12（テスト観点）・受け入れ条件が WordPress 版に比べ手薄なまま~~ | **大部分解消済み（2026-09-05）**。§7・§11・§12 参照。**残るのは UI 面の責任分担（旧 WordPress 版 §13 相当、埋め込み管理画面/CopilotUI/Super Admin の3面の役割表）のみ**（U-13 として計上） |
| U-12 | **大量の未承認インストール（開発ストアからのスパム/検証目的の連続インストール）がテナントとして DB に蓄積する運用上の問題**。D19 により Shopify Billing 未承認テナントはコストを発生させないため WordPress 版 `free_ad` 自動増殖ほどの原価リスクは無いが、ゴミテナントの放置は運用上望ましくない（2026-09-05、§11.1 の調査中に発見） | 優先度低。放置テナントのクリーンアップ方針（未承認のまま N 日経過で自動アーカイブする等）は実装時に検討する |
| U-13 | **UI 面の責任分担**（埋め込み管理画面/CopilotUI/Super Admin の3面がそれぞれ何を担うかの一覧表。WordPress 版 §13.1 相当） | 実装着手時に作成する。D9・D18・FR-09〜FR-12 に責務は分散して書かれているが、一覧化はされていない |

---

## 11. 実装上の制約

### 11.1 既存コードへの統合方針 — 新規ファイルを安易に作らない

`CLAUDE.md` の明文規定をそのまま適用する: 新規ファイルを作ってよいのはテスト可能な純関数として切り出す場合のみ。
本件でやることの大半は、**WordPress 版で新設したコードも含め既に実在する**。以下は実コードで確認した対応表
（`registerWpProvisionRoutes` / `registerWpSettingsRoutes` / `ALLOWED_HEADERS` / `createNotification` /
`suspensionGate.ts` / `fx.ts` の実在をこのセッションで grep 確認済み）。

| やること | 置き場所（既存） | 作ってはいけないもの |
|---|---|---|
| OAuth・プロビジョニング・Webhook 受信 | `src/api/widget/` 配下に `registerShopifyRoutes(app, db)` を新設（既存 `registerWpProvisionRoutes` / `registerWidgetRoutes` と同じ `export function register*Routes(app: Express, db: Pool \| null): void` の形）。`src/index.ts` の既存登録列に `if (db) registerShopifyRoutes(app, db)` で並べる | 新しい Express app・新しいサーバプロセス |
| USD/JPY 通貨換算（D17: 海外マーチャントの表示） | 既存 `src/lib/billing/fx.ts`（**リポジトリ内で唯一の換算元**、レート根拠がコメントで明記済み） | 第2の換算処理（`fx.ts` のコメント自体が「2本目を作る前に集約した」経緯を明記しており、同じ轍を踏まない） |
| Shopify Billing 未承認/失効時の機能停止（D19） | 既存 `src/lib/billing/suspensionGate.ts`（未払い/解約テナントを active/grace/restricted/suspended の4段階で止める既存ゲート）に Shopify の `AppSubscription` 状態を接続する | 新しい停止ロジックの再実装 |
| 原価集計・アラート | 既存 `src/lib/billing/tenantEconomics.ts` | 新しい計測基盤 |
| プラン判定 | 注入済み `db` に `queryTenantPlan` + `planHasFeature`（`src/lib/billing/planFeatures.ts`） | `tenantHasFeature`（内部で `getPool()` を呼びテストのモック Pool と食い違う） |
| Origin 検証 | 既存 `src/api/middleware/originCheck.ts` | `src/middleware/` にある別のミドルウェア群（`inputSanitizer` / `promptFirewall` 等）と混同しない |
| CORS の許可ヘッダ | 既存 `src/lib/cors.ts` の `ALLOWED_HEADERS`（単一情報源） | 第2の許可リスト |
| テナント・運用者への通知 | 既存 `src/lib/notifications.ts` の `createNotification` | 新しい通知テーブル |
| 監査ログ（`customers/redact` の削除記録等） | 既存 `src/api/admin/agent/agentAuditLog.ts` 相当の仕組み | 新しい監査テーブル |
| 削除保留期限（受信日+30日）の計算 | `src/lib/date/weekRange.ts` に倣い **process TZ に依存しない**実装（`timestamptz` との比較は `AT TIME ZONE` を片側だけ書かない、禁止16） | サーバ TZ 依存の日付演算 |
| テナント流入元の識別列 | **既存 `tenants.provisioning_source`（`manual`/`wordpress_plugin`）のCHECK制約に`'shopify_app'`を追加する**（新規列は作らない。§5.3の訂正参照、2026-09-05実装時に確認・訂正済み） | 新規列 `inflow_source` の追加。別テーブルでの流入元管理 |
| DB migration | 機能ディレクトリ内 `migration_<機能>.sql`（`src/lib/billing/` 配下の既存ファイル群と同じ形。`ADD COLUMN IF NOT EXISTS` + `COMMENT ON COLUMN`） | 場当たり的な置き場所。**適用は人間承認**（禁止8） |
| Shopify CLI アプリプロジェクト本体（埋め込み管理画面 + Theme App Extension） | **新設が前提**（`shopify-app/`、D11）。これは「既存を再実装している」のではなく、Shopify プラットフォームが要求する新種のデプロイ物であり、新設して良いものと明確に区別する | `src/` 側にフロントエンドを混在させる |

### 11.2 命名・形式の既存パターン

| 対象 | 既存パターン |
|---|---|
| ルート登録関数 | `export function registerXxxRoutes(app: Express, db: Pool \| null): void`（`registerWidgetRoutes` / `registerWpSettingsRoutes` / `registerWpProvisionRoutes` で確認済み） |
| エラー応答 | `res.status(4xx).json({ error: "snake_case_code", message: "日本語の文" })` |
| バリデーション失敗 | `res.status(400).json({ error: "invalid_request", details: parsed.error.issues })`（Zod） |
| migration | 機能ディレクトリ内 `migration_<機能>.sql`。`ADD COLUMN IF NOT EXISTS` + `COMMENT ON COLUMN` で意味を明記 |
| 日付・期限計算 | `src/lib/date/weekRange.ts` に倣い process TZ に依存しない実装 |
| テスト | 実装の隣に `*.test.ts`（`wpProvisionRoutes.test.ts` / `wpProvisionRepository.test.ts` / `wpProvisionToken.test.ts` / `wpSiteUrl.test.ts` / `wpSiteVerifier.test.ts` の実在パターンに倣い、Shopify 版も `shopifyRoutes.test.ts` / `shopifyProvisionRepository.test.ts` 等に分割する） |
| Webhook の HMAC 検証 | 3種の GDPR Webhook + `app/uninstalled` で共通のヘルパ関数に切り出し、各ハンドラで個別実装しない（重複防止） |
| Shopify Admin GraphQL API 呼び出し | 型を先に確認してから構築する（`graphql_schema` 相当の確認 → クエリ構築 → 検証 → 実行の順）。フィールド名を推測で書かない |

### 11.3 やってはいけないこと

`CLAUDE.md`「絶対にやってはいけないこと」のうち、本件で**実際に踏みうるもの**だけを抜き出した。

| # | 禁止事項 | 本件での現れ方 |
|---|---|---|
| 1 | `tenantId` を client 由来から取る | OAuth コールバックの応答を除き、`shop` ドメインを `req.body` から信用しない。セッショントークン検証済み・HMAC 検証済み Webhook 由来の `shop` のみを真とする |
| 6 | 同じ関心事を2ファイルに複製したまま片方だけ直す | `fx.ts` / `suspensionGate.ts` / `notifications.ts` / `originCheck.ts` を書き起こさない（§11.1） |
| 8 | DB migration を自動実行する | `tenants` への列追加は人間承認。デプロイ手順に混ぜない |
| **10 / 39** | **費用が発生する操作を、課金が成立しないまま開放する** | D19：Shopify Billing の承認（`AppSubscription ACTIVE`）が無い状態でチャット機能を稼働させない |
| 14 | 機能ゲートを UI 側だけに置く | 埋め込み管理画面で隠すだけでなく、サーバ側（`suspensionGate.ts` 経由）で拒否する |
| 16 | `AT TIME ZONE` を片側だけ書く | `shop/redact` の30日猶予・アラート発火のタイミング計算で厳守 |
| 20 | 「存在しない」と「空」を同じ値で表現する | プロビジョニング状態は `pending` / `verified` / `expired` / `not_found` を区別（WordPress 版 X-2 と同型）。削除保留も「保留 0 件」と「対象外テナント」を区別する |
| 21 | HTTP ステータスの意味を潰して1つの文言にまとめる | 403（課金未承認）/ 404（トークン不明）/ 409（同一ドメインに既存テナント）/ 429（レート制限）を同じ文言にしない |
| 22 | クライアントが送るヘッダを許可リストに足さずに増やす | Shopify 固有ヘッダを新たに要求するなら `ALLOWED_HEADERS` に必ず追加する |
| 25 | セッション/キャッシュ/Map をテナント非スコープでキー付けする | OAuth の `state`、Webhook の冪等キーは必ず `shop` を含めてキー付けする |
| 26 | 認証を fail-open にする | HMAC 検証失敗は必ず401で拒否。Webhook secret 未設定は fail-closed（起動時に落ちる） |
| 27 | 公開配布物と管理 API で同じ署名鍵を使う | Shopify の webhook secret と既存 `WIDGET_JWT_SECRET` / `SUPABASE_JWT_SECRET` を混在させない |
| 28 | レートリミッタを認証前・全テナント単一バケットで運用する | 認証前は IP キー（`X-Real-IP`）、認証後はテナントキーの2段にする |
| 38 | ウィジェットの配布経路が複数あり、キャッシュされる事実を無視する | §3.1 のとおり Theme App Extension 経由のみを使い、ScriptTag・静的版（`data-tenant`）を混在させない |
| 41 | 環境変数だけで有効／無効が決まる機能を新設する | Shopify 連携の有効化も `tenants.features` ベースで判定する |
| 44 | 押せるのに何も起きない UI を置く | 埋め込み管理画面の全項目に適用。未接続時に押せる状態で並べない |
| 50 | 監視の対象が0件のときに「異常なし」と報告する | `shop/redact` 保留0件を「正常」と表示しない（D15、§7 D-5） |

---

## 12. テスト観点

### 12.1 正常系

| # | 観点 |
|---|---|
| N-1 | OAuth インストール → 接続 → Theme Editor でブロック有効化 → チャット表示、の一連の通し |
| N-2 | 既に R2C アカウントを持つマーチャントが接続する場合、新規テナントを作らず既存テナントへの接続要求として扱われる |
| N-3 | 表示面選択（商品ページ/カート/配送ポリシー）の設定が埋め込み管理画面から保存され、ストアフロントの表示に反映される |
| N-4 | Shopify Billing のメーター報告（App Events API）が実際の請求に反映される（開発ストア/テストモード） |
| N-5 | GDPR Webhook 3種それぞれが正しく処理される（`customers/data_request` → 自動応答、`customers/redact` → 自動削除+監査ログ、`shop/redact` → 削除保留マーク） |
| N-6 | アンインストール後、ウィジェットの新規表示が止まり、データは即座に削除されない |
| N-7 | 削除保留中の再インストールで既存テナントが復元される（D16） |
| N-8 | Super Admin 画面で Shopify 経由テナントが流入元として識別できる |
| N-9 | 埋め込み管理画面と CopilotUI で設定値が一致し、どちらから見ても最新値が表示される（D9・D18） |
| N-10 | 人間承認により `shop/redact` の削除が実際に実行される |
| N-11 | Shopify Billing の課金承認後、チャット機能が正常に稼働する（D19 の逆方向を確認） |

### 12.2 異常系・境界値

| # | 観点 | 期待 |
|---|---|---|
| X-1 | HMAC 検証に失敗した Webhook | 401 で拒否。ペイロードを処理しない |
| X-2 | OAuth の `state` 不一致・期限切れ | 認証を拒否し、解決方法を伴うエラーを出す |
| X-3 | 同一 `shop` ドメインへの重複プロビジョニング要求 | 新規テナントを作らず、既存テナントへの接続要求として扱う |
| X-4 | Shopify Billing 未承認のままチャット機能を呼び出す | `suspensionGate.ts` 相当で機能停止し、マーチャントに「課金の承認が必要です」と案内する（D19） |
| X-5 | App Events API のメーター報告が202を返したが、後で Partner Dashboard の Logs で検証失敗と判明した場合 | `usage_logs` との突合で差分が検出できる（§5.2 の監視） |
| X-6 | `shop/redact` の承認期限（受信日+30日）の境界 | 29日目は警告のみ、30日目でアラート、31日目（超過）は重大アラートに切り替える |
| X-7 | 削除保留中に同一テナントへ `customers/redact` が届く | 顧客単位の削除を先に処理し、`shop/redact` の保留状態と矛盾しない |
| X-8 | Shopify Billing の `cappedAmount`（30日サイクルの請求上限）到達 | Shopify 側は自動で機能を止めない前提のため、アプリ側で上限接近を検知し案内する |
| X-9 | R2C API 停止中に埋め込み管理画面を開く | フロントは無傷（NFR-03）。管理画面は「今は接続できません」と伝え、設定入力自体は失われない |
| X-10 | 表示位置オフセットの境界値 `-1` / `0` / `320` / `321` / `99999` / 文字列 | 0〜320 に丸める（既存 `public/widget.js` の値域と一致） |
| X-11 | `db === null`（DB 障害時）に OAuth コールバック・Webhook を受信する | 503 で明確に断る。フロントには影響させない |
| X-12 | マーチャントが Shopify 自体のプラン（Basic/Grow/Advanced 等）をダウングレードする | R2C のプラン・機能可否には影響しないことを確認する（Shopify 自体のプランと R2C のプランは独立） |
| X-13 | プランを JPY 建てで作成したが、マーチャントのストア通貨が JPY 以外だった場合 | D17 のとおり Shopify 側の換算表示（USD 等）になることを実機で確認する |
| X-14 | Webhook が同一イベントで複数回届く（Shopify のリトライ） | 冪等キー（`shop` + `event_id` 等）で二重処理しない |

### 12.3 ユーザーがやりそうなイレギュラーな操作

**ここが本要件で最も事故が出やすい領域。** マーチャントは「テーマを変える」「アプリを消して入れ直す」「スタッフを複数抱える」を日常的にやる。

| # | 操作 | 起きること / 求める挙動 |
|---|---|---|
| **I-1** | テーマを切り替える（Shopify の仕様上、App Embed Block の有効化状態はテーマごとにリセットされる） | 新テーマでウィジェットが無言で消える。埋め込み管理画面側で「ウィジェットが表示されていません。テーマエディタで有効化してください」と検知・案内する（D18 の「真実は R2C 側」を保ちつつ、Block 自体の有効化はテーマ単位の操作であることを利用者に明示する） |
| **I-2** | 開発ストアを複製してステージング環境を作る | `shop` ドメインが変わるため新規テナントとして扱われる（WordPress 版のような「同一ドメインに二重接続」問題ではなく、そもそも別ドメイン＝別テナントが正しい挙動であることをオンボーディングで明示する） |
| **I-3** | アプリをアンインストールしてすぐ再インストールする | `shop/redact` 到着前（48時間以内）ならテナントは残存しており、そのまま再接続できる。D16 の削除保留ケースとは別に、この「即時再インストール」も既存テナントへの復帰として扱う |
| **I-4** | アプリはインストールしたまま、Shopify Billing の課金だけを個別にキャンセルする | `suspensionGate.ts` 相当で機能が停止する（D19）。マーチャントには「課金が停止されたため機能を一時停止しています」と明示し、再度承認すれば復帰できることを伝える |
| **I-5** | 複数のスタッフアカウントが同時に埋め込み管理画面で設定を変更する | 後勝ちで黙って上書きしない。既存の楽観ロック方針（Asana 1217889968865474）に揃える |
| **I-6** | Store owner 権限を持たないスタッフがアプリのインストール・設定を試みる | Shopify のスコープ要件により失敗する。「オーナー権限が必要です」等、原因が分かるメッセージを出す |
| **I-7** | マーチャントが独自ドメイン（カスタムドメイン）を後から設定・変更する | `shop`（`*.myshopify.com`）自体は変わらないため WordPress 版のようなテナント特定の問題は起きない。ただし CORS の Origin 許可リストに独自ドメインが反映されているかを確認する |
| **I-8** | マーチャントのストア所在国・通貨設定が後から変わる | D17 の USD/JPY 表示に影響する。価格表示が動的に切り替わることをオンボーディングで明示する |
| **I-9** | `shop/redact` の削除保留期限が迫っているのに、承認担当者が誰も気づかない | D15 のアラート機構が実際に発火することを確認する（禁止50 型の監視） |
| **I-10** | `customers/redact` の対象顧客が、まさに進行中の会話を持っている | 削除処理と会話継続が競合しないよう、対象顧客の PII のみを削除し会話セッション自体は継続可能な状態を保つ |
| **I-11** | Theme Editor で App Embed Block を有効化したまま、埋め込み管理画面側ではテナントが「未接続」に戻っている（Shopify Billing のキャンセル等で） | 状態不一致を放置しない。埋め込み管理画面が実サーバに問い合わせて現在状態を表示する（WordPress 版 I-5 相当） |
| **I-12** | 開発ストアからの大量の連続インストール（スパム・検証目的） | D19 によりコストは発生しないが、ゴミテナントが DB に蓄積する（U-12、優先度低で別途方針を検討） |
| **I-13** | Shopify Plus の組織で複数ストアを運営するマーチャントが、1つの R2C 契約で全ストアをカバーできると誤解する | D6 の「`shop` ドメイン単位のテナント」原則を、オンボーディング時に明示する（複数ストアは複数テナント・複数契約になる） |
| **I-14** | プラン内の会話数枠を超過した状態でストアフロントを見る | ウィジェットが止まる、または超過課金が発生する（プラン設計次第）。マーチャント側の管理画面で理由が分かること。**エンドユーザーにエラーを見せない**（WordPress 版 I-12 と同型） |
| **I-15** | R2C API が停止している最中にアプリをインストール・設定する | フロントは無傷（X-9 / NFR-03）。埋め込み管理画面は「今は接続できません」と伝え、設定入力自体は失われない |

---

## 付録: 参照した一次資料

### プラットフォーム要件
- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Is it mandatory to use Shopify App Bridge?](https://community.shopify.com/t/is-it-mandatory-to-use-shopify-app-bridge/173572)
- [Is Polaris Web Components mandatory?](https://community.shopify.dev/t/is-polaris-web-components-mandatory-for-shopify-apps-can-i-use-tailwindcss-and-other-libraries-in-a-react-router-app/26734)
- [Script tags deprecation changelog](https://shopify.dev/changelog/online-store-script-tags-deprecation)
- [checkout.liquid](https://shopify.dev/docs/storefronts/themes/architecture/layouts/checkout-liquid)
- [Checkout Extensibility 2026 migration guide](https://revize.app/blog/shopify-checkout-extensibility-migration-guide)
- [Apps in checkout](https://shopify.dev/docs/apps/build/checkout)
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Shopify App Pricing / usage billing / App Events API](https://weaverse.io/blogs/shopify-app-pricing-usage-billing-app-events-api-platform-2026)
- [Revenue share](https://shopify.dev/docs/apps/launch/distribution/revenue-share)
- [Shopify app developers revenue share change (BetaKit)](https://betakit.com/shopify-app-developers-will-no-longer-be-exempt-from-sharing-their-first-1-million-usd-in-revenue-every-year/)
- [About app authentication](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Token exchange reference](https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/docs/reference/auth/tokenExchange.md)
- [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
- [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)
- [EU AI Act と Shopify セラー向け解説](https://www.consentmo.com/blog-posts/preparing-for-eu-ai-act-transparency-what-shopify-sellers-need-to-know)
- [Multiple Shopify Stores](https://www.putler.com/multiple-shopify-stores/)
- [Shopify Sidekick 解説](https://www.ringly.io/blog/ai-sidekick-shopify)
- [TechCrunch: Shopify Sidekick](https://techcrunch.com/2023/07/26/shopify-sidekick-is-like-chatgpt-but-for-ecommerce-merchants)

### 競合調査
- Shopify Inbox（AI sales associate）: apps.shopify.com/inbox
- Tidio (Lyro AI): tidio.com, chatarmin.com
- Gorgias (AI Agent): eesel.ai, hellorep.ai
- Richpanel: apps.shopify.com/customer-support
- Intercom Fin: fin.ai/pricing
- Rep AI: pickyourapp.com, shoplyai.ai
- Certainly: certainly.io/shopify-integration
- Ada: vendr.com
- Zowie: eesel.ai
- Gobot: delightchat.io
- Willdesk: willdesk.com/price
- BestChat: apps.shopify.com/bestchat
- Octane AI: storecensus.com
- iAdvize AI Shopping Assistant: apps.shopify.com/iadvize-ai-copilot
- Daylily（Agentic Salespeople）: apps.shopify.com/interactive-3d-assistant（現在非公開）
- Heyday (Hootsuite): hootsuite.com
