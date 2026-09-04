# 安全性の強制点

R2C の安全規則が **どこで守られているか** を1枚にまとめる。CLAUDE.md の「絶対にやってはいけないこと」は
*何を守るか* を書いた文書で、この文書は *誰が守っているか* を書く。両者は対になっている。

規則は3つに分かれる。

| 分類 | 意味 |
|---|---|
| **コードで強制** | その規則を破る入力が来ても、コードが必ず止める。モデルを差し替えても成立する |
| **モデルに頼んでいるだけ** | プロンプトに書いてあるが機械的な強制が無い。モデルが従う限りで成立する |
| **デプロイ・運用の責任** | コード外（env 設定・nginx・DB への migration 適用・承認オペレーション）に依存する |

**この区別が要る理由。** 「コードで強制」の行が破れたら事故だが、「モデルに頼んでいるだけ」の行が破れても
*文章の誤りにとどまる* ように設計されていなければならない。誤った文章は訂正すれば済むが、
誤った書き込み・課金・公開は取り消し作業が要る。**したがって、書き込み・課金・公開の3つは
必ず「コードで強制」の側に置く。** この文書はその配置が実際にそうなっているかを確認するために作った。

行の根拠はすべて実機のソースを読んで採取した `file:line`。**根拠を書けない行はこの表に載せない。**

> [!WARNING]
> 2026-09-04 の初回監査で、書き込みゲートが「モデルに頼んでいるだけ」の側にあることが判明した。
> 該当行は表の中で ⚠️ を付け、末尾の「既知の穴」に起票番号とともに再掲する。
> **この文書は現状の記録であって、あるべき姿の記録ではない。**

## モデルに頼んでいるだけ

ここに並ぶ規則は、**モデルが従わなければ破れる**。破れたときに何が起きるかを右端に書いてある。
「文章の誤りにとどまる」なら設計どおり。**そうでない行は穴であり、末尾に再掲した。**

| 規則 | 書いてある場所 | 破れたときに起きること |
|---|---|---|
| FAQ にない情報は推測で答えない | `src/agent/tools/synthesisTool.ts:195-201` | 文章の誤り。訂正で済む |
| ヒット0件時に価格・在庫・仕様・期間・保証を生成しない | `synthesisTool.ts:181-185`（注入は `:320-322`、`items.length===0` のときのみ） | 文章の誤り。ただし顧客は事実として受け取る |
| 心理学原則をそのまま伝えない / 原則名を言及しない | `synthesisTool.ts:156,162` | 文章の誤り。出力側に原則名の検査は無い |
| 事実は FAQ を優先（採用済み返答が事実を上書きしない） | `tuningRulesRepository.ts:437` の文言 | 文章の誤り。逐語コピー・事実上書きを検出する機構は無い |
| 200文字以内で答える | `synthesisTool.ts:195-201` | **プロンプトは200字、コードの truncate は420字**（`DEFAULT_MAX_CHARS` @ `:166`）。従った時だけ200字 |
| ⚠️ 書き込み前にユーザーの確認を取る | `agentRoutes.ts:1334-1335, :1354` | **書き込みが実行される。** 確認は LLM が自己申告する `confirmed` 引数（`actionExecutor.ts:105-108`）で、サーバは確認状態を保持しない |

### 確認ゲートが「モデルに頼んでいるだけ」である理由

commerce-agents の `docs/safety.md` は merchant agent の承認について
**"A preview card approves nothing; an approval typed in chat sets nothing."** と書いている。
R2C は現状その逆になっている。

- リクエストボディに `confirmed` は存在しない（`chatSchema` @ `agentRoutes.ts:277-288`）
- フロントの確認チップは `"__real:はい、お願いします"` という**自然文をLLMに送り返すだけ**
  （`admin-ui/src/pages/copilot-preview/index.tsx:1190-1220`）
- モデルが次のターンで `confirmed=true` を自分で付ける。署名付き確認トークンも操作IDの紐付けも無い
  （`agentRoutes.ts:903-906` のコメントが「完全な人間-in-the-loop 証跡は別タスク」と自認）

したがって**チャット本文に「はい」と書くことが、そのまま承認として成立している。**

## コードで強制している

破る入力が来てもコードが止める規則。**モデルを差し替えても成立する**のがこの節の条件。

### 認証・テナント境界

| 規則 | 強制箇所 | 限界 |
|---|---|---|
| global ミドルウェア順序（requestId → securityHeaders → json → CORS） | `src/index.ts:136-137, :148, :163` | Stripe webhook のみ `:142-146` で `express.raw` を先行（意図的） |
| `SUPABASE_JWT_SECRET` 未設定で起動を止める | `src/lib/startup/authSecretsGuard.ts:26-58` → `src/index.ts:850` で `process.exit(1)` | `NODE_ENV` が `development`/`test` では warn 止まり |
| `jwt.verify` の `algorithms` 固定（HS256） | `src/auth/verifySupabaseJwt.ts:40`、`src/admin/http/supabaseAuthMiddleware.ts:96` | 2経路とも固定済み。alg confusion は塞がれている |
| 管理面トークンの role allowlist | `src/auth/jwtClaims.ts:6-14` `isAdminUsableToken` → `supabaseAuthMiddleware.ts:100-107` で403 | `anon` 拒否 / `purpose` 保持を拒否 / `super_admin`・`client_admin` 以外を拒否 |
| tenant 不明 JWT を `"demo"` に落とさない | `src/agent/http/authMiddleware.ts:78-84`（401）、`src/api/middleware/roleAuth.ts:83-86`（client_admin の tenant 空は403） | legacy API key 経路は `API_KEY_TENANT_ID ?? "default"` にフォールバック |
| `tenantId` を body から取らない（chat / agent 経路） | `src/api/chat/route.ts:281-283`、`src/agent/http/authMiddleware.ts:14-16, :78` | 管理面は `x-tenant-id` ヘッダを読む経路が残る（下記） |
| body の書き込み宛先（`target`）ガード | `src/api/admin/knowledge/routes.ts:297-306`、PDF は `src/index.ts:561-566` | 各ルートに手書き。共通ミドルウェアは無い |
| super_admin の `?tenant=` 解決 | `src/api/middleware/roleAuth.ts:120-137` `resolveEffectiveTenantId` | 全直接fetch経路がこれを使う保証は無い（禁止18 と同根） |
| widget トークンの鍵分離 | `src/api/widget/widgetGenerator.ts:41-43`（`WIDGET_JWT_SECRET` 未設定は throw）、`:48`（`purpose:"widget-session"`） | ハードコード fallback は**ソースに存在しない**。回帰テスト `widgetGenerator.test.ts:89-97` |
| レートリミット2段（IP / テナント） | `src/index.ts:174, :180`、配線 `:266`(1番目)・`:269`、実装 `src/lib/rate-limit.ts:104-136` | **`/v1/admin/*` には一切かからない**。ストアはプロセス内 Map |
| CORS 許可ヘッダの単一情報源 | `src/lib/cors.ts:38-45` | 第2の許可リストは無い |
| ワイルドカード origin の危険形排除 | `src/api/middleware/originCheck.ts:37, :48-50, :56-60`、照合側 `:87` でも再検査 | 日本の9サフィックスのみ。フル Public Suffix List は未採用 |
| E2E からの管理API書き込み拒否 | `src/api/middleware/e2eWriteGuard.ts:36-39, :47-53`、配線 `src/index.ts:634`（admin ルータ登録より前） | 根拠は `x-r2c-traffic-source: e2e` ヘッダの明示のみ。**外せば無効** |
| プラン fail-safe の落とし先が2箇所に集約 | `src/lib/billing/planFeatures.ts:114-116`（`?? PLAN_RANK.free_ad`）、`:141-152` `parseKnownPlan` | 旧3箇所コピペは解消済み（`:126-140` に経緯） |

### LLM 防御層・RAG

| 規則 | 強制箇所 | 限界 |
|---|---|---|
| Input Sanitizer が `/api/chat` を通る | `src/api/chat/route.ts:411` → `src/middleware/inputSanitizer.ts:183` | `INPUT_SANITIZER_ENABLED=false` で全通し |
| Prompt Firewall が `/api/chat` を通る | `route.ts:423` → `src/middleware/promptFirewall.ts:201` | `PROMPT_FIREWALL_ENABLED=false` で fast-path 素通り |
| Topic Guard が `/api/chat` を通る | `route.ts:430` → `src/middleware/topicGuard.ts:82` | **LLM分類器は未実装スタブで常に `on_topic`/0.8**（`topicGuard.ts:71-76`）。実質 正規表現のみ |
| Output Guard が `/api/chat` を通る | `route.ts:520` → `src/middleware/outputGuard.ts:111` | `OUTPUT_GUARD_ENABLED=false` で素通り |
| 社内呼称の伏せ字 | `outputGuard.ts:53-59, 82-92`、適用は `synthesisTool.ts:506` と `route.ts:541` | **フラグ非依存で常時ON**。ただし正規表現に列挙した語のみ |
| 書籍抜粋 200字 / 3件 | `src/agent/tools/synthesisTool.ts:490`（maxChars）, `:455`（件数）, `:509-512` | 判定は `metadata.source` が `"book"` 始まりかのみ。**source 未付与の書籍チャンクは FAQ 枠（500字/5件）で通る** |
| `tuning_rules` の注入は `buildTuningPromptSection` が唯一の入口 | `synthesisTool.ts:260, :308` → `tuningRulesRepository.ts:214, :459` | grep で他の注入箇所なし |
| `tuning_rules` 本文の行捏造防止 | `tuningRulesRepository.ts:418-421` `flattenForPromptLine`（改行潰し） | **FAQ 本文側には同等の対策が無い** |

### 管理AIエージェント

| 規則 | 強制箇所 | 限界 |
|---|---|---|
| ツール戻り値の文字数上限 | 書き込み系500字 `actionExecutor.ts:824`、閲覧系4000字＋打ち切り注記 `:829-833` | 全 return が両者を経由（機械走査で確認）。素の文字列を返す箇所は無い |
| 書き込む case は必ずリスク階層表に載る | `confirmPolicy.test.ts:42-138`（`actionExecutor.ts` を readFileSync + `MUTATION_PATTERNS` で走査し**完全一致**を要求） | **ツール経路のみ**。HTTP ルート直の書き込みは構造上検出できない（下記） |
| `targetTenantId` は super_admin のみ | `agentRoutes.ts:1250, :1252-1254` | body に tenantId 相当キーは無い |
| 破壊的ツールのテナント述語 | 全 destructive case が tenant 条件を持つ（`delete_faq:1330`, `bulk_delete_faqs:1489`, `delete_tuning_rule:2964`, `reply_to_escalation:4228` 他、機械確認済み） | RLS が無いので各 `WHERE` が唯一の防壁 |
| suggest_* → save_* の同一ターン連鎖ブロック | `agentRoutes.ts:785-798, :505, :520` | 手動列挙。ペアの無い書き込みツールには効かない |
| untrusted-read 直後の書き込みブロック | `agentRoutes.ts:831-838, :521-522, :537` | 6ツールの手動列挙。`:840-846` が登録漏れの再発余地を自認 |
| 管理AI の Groq 呼び出しを計上 | `agentRoutes.ts:1442-1453, :1498-1510`、呼び出し `:1556`。冪等キーは `Date.now()` を含まない形に是正済み | **エラー時は計上されない**（`:1556` は try の最後）。消費トークンが不可視のまま当社負担 |

## デプロイ・運用の責任

コードの外に依存している。**コードを読んでも守られているか分からない**のがこの節の条件。

| 項目 | 依存先 | コード側の担保 |
|---|---|---|
| `X-Real-IP` の上書き注入 | nginx | **無し**。`rate-limit.ts:112` は検証も正規化もしない。`trust proxy` は `src/` に0件のため `req.ip` は常にループバック。ヘッダを毎回変えれば IP 段は無効化できる |
| `X-Internal-Request` の strip | nginx | `internalNetworkOnly` + ヘッダの二重防御（`/health/business`・`/metrics`）。ただし `src/api/internal/ga4SyncRoutes.ts:24, :74, :109` は `internalNetworkOnly` を欠き HMAC 単独 |
| `NODE_ENV` の実値 | 環境変数 | `development`/`test` と**明示した**場合のみ管理面認証が warn 素通しになる（`supabaseAuthMiddleware.ts:66-72`）。未設定・`staging` は fail-closed（503 / `exit(1)`） |
| `ALLOWED_ORIGINS` の実値 | 環境変数 | 未設定 + `NODE_ENV=development` で任意 origin を echo-back。ただし `Allow-Credentials` は付かない設計（`cors.ts:105-108`）でクロスオリジン読み取りは成立しない |
| L5〜L8 の各 `*_ENABLED` | 環境変数 | 4層とも `false` を明示すれば素通り。`NODE_ENV∈{development,test}` では既定OFF（`securityLayerConfig.ts:22,28-31`）。未知の環境名は ON 側に倒れる |
| RLS の適用と接続ロール | DB migration + `DATABASE_URL` | **現状ゼロ**（下記「既知の穴」1） |
| migration の本番適用 | 人間の手動実行（禁止8） | スキーマ↔コード整合テストは migration **ファイルの文字列**を読むだけで、実行中のDBに列があるかは見ない（禁止42） |
| 管理AIの承認オペレーション | 店主・運用者 | **無し**（下記「既知の穴」2） |

## 既知の穴

監査で確認した実際の欠落。**重い順**。起票先は末尾の一覧を参照。

### 1. 承認ゲートが実質存在しない ⚠️ 最重要

書き込みの確認は **LLM が自己申告する `confirmed` 引数**（`actionExecutor.ts:105-108`）だけで、
サーバは確認状態を保持しない。フロントの確認チップは自然文をLLMに送り返すだけ
（`copilot-preview/index.tsx:1190-1220`）。**チャット本文の「はい」がそのまま承認になっている。**

さらに**8ツールは `confirmed` を一切見ない**（引数スキーマにも無い）:
`set_ga4_id` / `set_posthog` / `set_widget_theme` / `set_faq_hints` / `activate_avatar` /
`deactivate_avatar` / **`add_faq`** / **`update_faq`**

- **`add_faq` は禁止5 違反**。`actionExecutor.ts:1219-1222` が `is_published` を**リテラル `true`** で INSERT し、
  確認チップも存在しない（`copilot-preview/index.tsx` の確認分岐8種に `add_faq` は無く、`REAL_WRITE_TOOLS` に
  登録済み＝**書き込み完了として扱われる**）。店主が1回打てば顧客に見えるFAQが公開される。
- **`save_tuning_rule` は禁止29 に隣接**。`actionExecutor.ts:2833-2839` が `is_active` を渡さず、
  `tuningRulesRepository.ts:263` の `params.is_active ?? true` で**既定 true** → 即座に本番プロンプトへ入る。
  Judge / Hermes の自動生成3経路（`evaluationAnalyzer.ts:163-169` / `judgeEvaluator.ts:416-421` /
  `hermes-mcp/routes.ts:376-382`）はいずれも `false` を明示しているのに、チャット経路だけが素通し。

### 2. `confirmPolicy.test.ts` が偽グリーン ⚠️

「分類表に載っているツールの case が `isConfirmed` を呼んでいるか」を見るアサーションが**1本も無い**。

- `:270-274` は全44ツールに `requiresConfirmation() === true` を主張 → 確認を見ない8件も緑
- `:236-242` は `args['confirmed']` の**出現回数の一致**しか見ない → 0回のツールは両辺に寄与せず素通り（実測 36 = 44−8）
- `:104-138` は「書き込む case が階層表に載っているか」の集合一致のみ → 載っているので緑

`confirmPolicy.ts:5-8` が自ら宣言している「分類だけを行い、確認ゲートの挙動は一切変えない」という
**意図的な設計上の分離が、テストの名前（「確認ゲートの対象」）によって実効性があるように見えている**。

### 3. RLS が防御として一切機能していない

`src/migrations/phase76_rls_tenant_isolation.sql` は敷いてあるが:
①`withTenant()` の本番呼び出し元が **0件**（`src/lib/db.ts` 内のコメントと定義のみ）
②ポリシーが `FORCE` されておらず、アプリ接続はテーブルオーナー＝バイパス（sql:22-26）
③述語は「GUC未設定=全行許可」の後方互換設計（sql:31-35）

→ テナント境界は依然として**各ルートの手書き `WHERE` が唯一の防壁**。しかもリポジトリの型は
`tenantId?: string` で述語は条件付き push（`chatHistoryRepository.ts:224, :414`）のため、
**呼び出し側が渡し忘れると全テナント横断クエリになる**（型エラーも実行時エラーも出ない）。

### 4. 監査記録が44ツール中8件のみ

`agentRoutes.ts:88-157` の `AUDITED_SETTINGS_TOOLS` は8件。**未記録36件**に
`delete_faq` / `bulk_delete_faqs` / `delete_tuning_rule` / `delete_engagement_rule` /
`delete_avatar_config`（不可逆な破棄）、`reply_to_escalation` / `resolve_escalation`（顧客の画面に出る・取り消し不可）、
`save_tuning_rule` / `update_tuning_rule`（本番の応答方針が変わる）が含まれる。
別経路で残るのは `delete_chat_session`（`deleteSessionRepository.ts:131`）と
`change_my_plan`（`changeTenantPlan.ts:191`）の2件のみ。

さらに発火条件が**成功文言の部分一致**（`agentRoutes.ts:600-606`）で、
**ツールの成功文言を変えると型チェックもテストも通ったまま監査が無言で止まる**。
`oldValue` は常に NULL（`:171-174`）なので「何から何へ変わったか」は復元できない。

### 5. 書き込み provenance 制約が無い

commerce-agents が `merchant_agent/gates.py` で持っている「このセッションでツールが返した id しか
書き込み対象にできない」という制約が R2C には無い。`update_faq` は任意の `faq_id` を受け取り、
テナント所有チェック（`actionExecutor.ts:1265-1276, :1284`）だけが防壁。
唯一の例外は FAQ 一括取り込みで、`knowledgeImportStaging` にステージ済みの内容しか commit できない。

### 6. 確認ゲートを迂回する HTTP ルートが1本

`POST /v1/admin/agent/faq-import/commit-selected`（`agentRoutes.ts:1591-1642`）が
`commitTextFaqs` / `commitScrapeFaqs` を直接呼んで `faq_docs` に INSERT する（`:1631-1634`）が、
`isConfirmed` も `requiresConfirmation` も呼ばず監査も残さない。
`confirmPolicy.test.ts` は switch の case を走査する設計なので、**このルートは構造上検出できない**。

### 7. `GET /v1/admin/knowledge/jobs/:jobId` に認可が無い

`src/index.ts:610-624`。`...apiStack` のみで `supabaseAuthMiddleware`・ロール判定・所有チェックが無い。
姉妹の `POST /v1/admin/knowledge/pdf`（`:544`）が `requireRole("super_admin")` まで付けているのと非対称で、
**任意のテナントAPIキー（widget が配る `x-api-key`）で到達できる**。

ただし**漏れるのはメタデータのみ**。`runOcrPipeline` の戻り値は `{ pages, chunks }`（`src/lib/ocrPipeline.ts:240`）で、
失敗時は200字に切った `err.message`。**書籍本文は載らない。** jobId は `uuidv4()`、TTL 30分。

### 8. 第三者テキストに fence が無い

`synthesisTool.ts:361-363` の userPrompt は `参考FAQ:\n${faqContext}` の素の文字列連結で、
`buildFaqContext` の出力も `FAQ1:\nQ: ...\nA: ...`（`:496, :499`）— 閉じ記号も区切りトークンも無い。
**FAQ 本文に `FAQ2:` や指示文を書けば構造を偽装できる。**
`tuning_rules` 側だけは `flattenForPromptLine`（`tuningRulesRepository.ts:418-421`）で行捏造対策があるが、FAQ 側には無い。

さらに **FAQ 本文（`faq_docs.question` / `answer`）は `sanitizeInput` も `applyPromptFirewall` も通らない**
（`synthesisTool.ts:494-495` は空白潰しと truncate のみ）。URL取込・PDF取込で外部テキストが `faq_docs` に
入る経路にも sanitize が無い。**禁止33 に対する穴。**

### 9. Topic Guard の LLM 分類器が未実装スタブ

`topicGuard.ts:71-76` が常に `on_topic` / 0.8 を返す。実質 Stage1 の正規表現マッチのみで動いている。

### 10. 書籍200字の判定が `metadata.source` 依存

`synthesisTool.ts:428-431` が `source` の `"book"` 前方一致だけで判定するため、
**索引側で `source` が付いていない／別値の書籍チャンクは FAQ 枠（500字/5件）で通る**。
著作権制約（`BOOK_EXCERPT_MAX_CHARS`）が索引データの品質に依存している。

### 11. blocked 判定の文字列がサーバとフロントで非対称

サーバは `"確認が必要です"`（`agentRoutes.ts:36-38`）、フロントは `"確認が必要"`
（`copilot-preview/index.tsx:435-441`、「です」が無い）。
「確認が必要な場合は」のような文をツールが返すと、**サーバは ok と数えるのにフロントは確認待ちチップを出す**。
禁止12 の構造が現役で、しかも二重管理されている。

### 12. 管理AIツールの behavioral eval が存在しない

`tests/` に eval ハーネスは無く、注入シナリオはすべて `global.fetch` をモックして
**tool_calls をテストが決め打ちした**結合テスト（`agentRoutes.test.ts:28-30`）。
したがって「**実際のLLMが `confirmed=true` を勝手に付けるか**」は一度も検証されていない。
穴1 の深刻度を測る手段が現状無い。

### 13. その他（実害は無いが是正候補）

- **`X-Real-IP` は詐称可能**（`rate-limit.ts:112-117`）。nginx の上書きが唯一の担保
- **`/v1/admin/*` にレートリミットが無い**（apiStack を通るのは chat/agent/search 系のみ）
- **`originCheck` は DB 例外時 fail-open**（`originCheck.ts:139-142`）
- **`e2eWriteGuard` は `x-r2c-traffic-source` ヘッダを外せば無効**、適用は `/v1/admin`・`/admin` のみ
- **`_wt` を検証するサーバ経路が存在しない**（widget の実認証は `x-api-key`）。
  「widget セッションを検証している」前提のタスクを起こさないこと
- **`X-Tenant-ID` が CORS 許可ヘッダに残っている**（`cors.ts:42`）。読む3箇所はガード済みだが誤ったシグナル
- **`src/api/internal/ga4SyncRoutes.ts` が `internalNetworkOnly` を欠く**（HMAC 単独。他3ルータは二重防御）
- **管理AIのエラー時に usage が計上されない**（`agentRoutes.ts:1556` は try の最後）。原価が不可視のまま当社負担
- **`faqImport.ts:116-118` の requestId フォールバックが `Date.now()` + 乱数**。
  `ON CONFLICT (request_id)` の重複排除が効かず二重計上しうる（命名規則違反）
- **プラン判定のキャッシュで剥奪が最大60秒遅延**（`planFeatures.ts:207, :218-228`）。プロセスローカル

## CLAUDE.md との不一致（この監査で判明）

- **禁止38 の「24時間キャッシュ」は失効。** 現行は `Cache-Control: public, max-age=300`
  （`src/api/widget/routes.ts:127`。`:125-126` に「24h(旧 max-age=86400)から5分に短縮」の経緯）
- **層番号がコードと逆。** CLAUDE.md は L6 Prompt Firewall / L7 Topic Guard だが、
  実装は `promptFirewall.ts:157` が "L7"、`topicGuard.ts:69` が "L6" と自称
- **プロンプトの「200文字以内」とコードの420字（`DEFAULT_MAX_CHARS`）が不一致**

## 未確認（推測で埋めていない）

- 本番DBに `phase76_rls_tenant_isolation.sql` が適用済みか、本番接続ロールがオーナーか
- 本番 nginx が `X-Real-IP` / `X-Internal-Request` を実際に strip / 上書きしているか
- 本番の `ALLOWED_ORIGINS` / `NODE_ENV` の実値
- インライン認可判定を持つ16ルータの全ハンドラ網羅（突き合わせ済みは `knowledge/routes.ts` のみ）

## 起票（2026-09-04）

すべて RAJIUCE Development（`1213607637045514`）。

| 穴 | タスク | GID |
|---|---|---|
| 1 | [P1] 管理AI: 確認なしで公開・有効化される3経路を塞ぐ（禁止5 / 禁止29） | `1218170942437134` |
| 2 | [P1] confirmPolicy.test.ts の偽グリーンを是正する | `1218170942604659` |
| 1（設計） | [P2] 管理AIの承認を「サーバが保持する承認マーク」にする | `1218170825242147` |
| 4 | [P2] 管理AIの監査記録を全書き込みツールへ拡張し、文言依存の発火条件を廃止する | `1218170835375077` |
| 7 | [P2] GET /v1/admin/knowledge/jobs/:jobId に認可と所有チェックを追加する | `1218170825242271` |
| 8 | [P2] FAQ本文が防御層を通らない / プロンプトに fence が無い（禁止33） | `1218170870912285` |
| 3 | [P2] RLS が防御として一切機能していない | `1218170835044399` |
| 9 | [P2] Topic Guard の LLM分類器が未実装スタブのまま稼働している | `1218170885315924` |
| 12 | [P3] 管理AIツールの behavioral eval 基盤を作る | `1218170825242471` |
| 5・6・10・11・13 | [P3] 監査で判明した小さい是正と、CLAUDE.md の失効記述の訂正 | `1218170942549672` |

## この文書の出自

`anthropics/commerce-agents` の `docs/safety.md` を下敷きにしている。
参考にしたのは**形式**（3分類 + 強制箇所の列）だけで、コードは1行も持ち込んでいない
（あちらは Python + Anthropic Messages API、R2C は TypeScript + Groq）。

同リポジトリから今後 R2C に取り込む価値があると判断したもの:
- `merchant_agent/gates.py` の **staging provenance と host approval** の考え方 → 穴1・穴5
- `commerce_common/fencing.py` の **固定ラベル fence** → 穴8
- `plugins/commerce-builder/skills/commerce-evals` の **case shape と authoring rules** → 穴12
