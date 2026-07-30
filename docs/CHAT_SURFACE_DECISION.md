# チャットUI 2面（パネル / 全画面）の関係性の決定 — 調査と推奨

**Asana:** チャット面の統合方針の決定 — GID `1217007298217504`
**位置づけ:** 実装ではなく **人間のプロダクト判断のための入力**。本ドキュメントは調査結果と 1 つの推奨案を示す。最終決定は hkobayashi。
**調査時点:** 2026-07-30 / `origin/main` = `5f5b2ed4` (#570)
**調査方法:** 記憶や過去の説明ではなく、上記コミット時点の実コードを読んで記述している。表中の行番号はすべて実測値。

---

## 0. 何が決まっていないのか（本ドキュメントが解こうとしている問題）

R2C には同じバックエンド（`POST /v1/admin/agent/chat`, `src/api/admin/agent/agentRoutes.ts`）を叩くチャットUIが **2 面** ある。

- **Surface A（パネル）** — `admin-ui/src/components/AdminAgent/` 一式。旧UIの全ページに右下FABとして重なるオーバーレイ。
- **Surface B（全画面）** — `admin-ui/src/pages/copilot-preview/index.tsx`（854行）。`/copilot-preview` のチャットファースト画面。

この 2 面の **役割分担が一度も決まっていない**。その結果、次の 3 つが決められないまま止まっている。

1. 会話の永続化（リロードを跨いだ会話の保持）を **どこに置くか** — 共有ストア 1 本か、面ごとに 2 本か。
2. 監査・メトリクスの **帰属先** — 現状リクエストからは面を判別できない（後述 §1.9）。
3. Surface A を **将来畳むのか** — 畳むならその条件は何か。

---

## 1. 機能差分表（実コード実測）

### 1.1 入口・可視条件・マウント位置

| 観点 | Surface A（パネル） | Surface B（全画面） |
|---|---|---|
| 入口 | 右下FAB `AdminAgent/AdminAgentButton.tsx:11-63` | URL `/copilot-preview`、および着地パスの乗っ取り `App.tsx:124-127` |
| マウント箇所 | `App.tsx:255-271`（`<Routes>` の外側 = SPA内遷移で状態が生き残る） | `App.tsx:136-145` の早期 return（旧UIシェルを一切通らない） |
| 可視条件 | `showAIChat = isClientAdmin && location.pathname !== "/admin/chat-test"` (`App.tsx:103`) | `/copilot-preview` 直アクセス、または着地パス(`/`, `/admin`)で `isChatFirstDefaultEnabled()` か `previewMode` が真 (`App.tsx:124-127`) |
| 既定化のオプトイン | なし | `lib/chatFirstDefault.ts:7` の localStorage キー `r2c_chat_first_default`、UIトグルは `copilot-preview/index.tsx:677-715` |
| 相互排他性 | `/copilot-preview` では **マウントされない**（`App.tsx:136` の早期 return より前に到達しないため） | 旧UIページ上には存在しない |

> 重要な構造的事実: **2 面が同時に画面に存在することはない**。`App.tsx:136` の早期 return がそれを保証している。つまり「2 面の併存」は UI 上の併存ではなく、**コードベース上の併存**である。

### 1.2 レンダリングするカード / 応答型

| 応答型 | Surface A | Surface B |
|---|---|---|
| プレーンテキストのバブル | ○ `AdminAgentMessage.tsx:38-56` | ○ `index.tsx:730-734` |
| ツール実行結果（汎用） | ○ 緑バブル `AdminAgentMessage.tsx:59-86` | ○ `agentAction` カード `index.tsx:783-792` |
| ツール名の日本語ラベル | △ **9 件のみ** `AdminAgentMessage.tsx:4-14`（`list_faqs`/`add_faq` 等。現行ツール群に対して著しく不足） | ○ **47 件** `index.tsx:42-88` |
| FAQ下書きカード | ✕ | ○ `index.tsx:793-801`（パーサ `:124-130`） |
| 指示ルール下書きカード | ✕ | ○ `index.tsx:802-809`（パーサ `:132-137`） |
| 声がけルール下書きカード | ✕ | ○ `index.tsx:810-817`（パーサ `:139-168`） |
| 保存成功カード | ✕ | ○ `index.tsx:818-823`（判定 `:178`） |
| 旧UIへの案内リンクカード | ✕ | ○ `index.tsx:824-841`（パーサ `:170-176`、別タブ固定 `:829-833`） |
| `answered_from` の出典ラベル | ○ `AdminAgentPanel.tsx:21-25, 190-194` | ✕（`data.answered_from` を受け取っていない `index.tsx:309`） |
| タイプライター演出 | ✕ | ○ `index.tsx:185-209`（`prefers-reduced-motion` 尊重） |
| 実書き込み件数バッジ | ✕ | ○ `index.tsx:717-724` / 対象ツール集合 `:91-106` |

### 1.3 チップ / 確認UX

| 観点 | Surface A | Surface B |
|---|---|---|
| 確認チップ | **なし**（`AgentMessage.needsConfirmation` は型に存在するが `useAdminAgent.ts:11` で未使用。UIに描画箇所なし） | ○ `index.tsx:371-391` |
| 対応する確認フロー | — | suggest_*（保存して/やめておく）、`request_sai_task`、`reply_to_escalation`/`resolve_escalation`、`import_industry_faq_templates` |
| チップ消費（二度押し防止） | — | ○ `index.tsx:279-280, 736` |
| 未決定チップによる操作ロック | — | ○ `awaitingUserDecision` → `busy` `index.tsx:470-473` |
| 確認は自然文で返す方式 | ユーザーが自分で「保存して」と打つしかない | チップが `__real:` プレフィックス付きで自然文を代理送信 `index.tsx:457-461` |

### 1.4 カテゴリ / ナビゲーション構造

| 観点 | Surface A | Surface B |
|---|---|---|
| 左レール | なし | 6 カテゴリ `index.tsx:230-237`（アシスタント/今週のまとめ/会話の履歴/知識データ/指示ルール/アバター） |
| カテゴリの実装 | — | 各カテゴリは **定型プロンプトの実API送信** `index.tsx:476-493`（画面遷移ではない） |
| 会話中のカテゴリ切替 | — | ロックする `index.tsx:476-477, 546-548`（応答の混線防止） |
| 起動時フロー | 固定の挨拶文 1 行 `AdminAgentPanel.tsx:19, 180-182` | ブートストラップ `index.tsx:416-446`: 新規テナント（`onboarding_completed_at` 未設定）は業種選択チップ `:114-118`、既存テナントは週次ブリーフィング自動取得 `:109-110` |
| 種まき質問での起動 | ○ `initialQuery` → 自動送信 `AdminAgentPanel.tsx:56-62`（AppSwitcher のロックタブ用） | ✕ |

### 1.5 通知・シェル機能の統合

| 観点 | Surface A | Surface B |
|---|---|---|
| 通知ベル | パネル自体は持たない（旧UIシェル側 `AppSidebar.tsx:221, 434` が持つ） | ○ ヘッダーに常設 `index.tsx:614`（ドロワーの overflow 影響を避けるため rail ではなく header 配置） |
| 担当者返信（相談窓口）の未読 | ○ **A のみ**。FABの赤ドット `App.tsx:259` / `AdminAgentButton.tsx:47-59`、60秒ポーリング `useFeedbackReplies.ts:14, 37-41` | ✕ |
| 返信カード（解決した/まだ解決しない） | ○ `AdminAgentPanel.tsx:170-177` + `ReplyCard.tsx:12-110` | ✕ |
| 回答後の「解決しましたか？」導線 | ○ `AdminAgentPanel.tsx:195-199` + `FeedbackPrompt.tsx:12-68` | ✕ |
| テーマ切替 / 言語切替 / ログアウト | 旧UIシェル（`AppSidebar`）側が持つ | ○ 自前で持つ `index.tsx:571`（ThemeToggle）, `:574`（LangSwitcher）, `:576-588`（ログアウト、`handleLogout` `:452-455`） |
| AppSwitcher (R2C ⇄ R2C2) | 旧UIシェル側 | ○ rail 内 `index.tsx:538` |

### 1.6 会話の永続化（リロードを跨ぐか）

| 観点 | Surface A | Surface B |
|---|---|---|
| 会話の保持先 | コンポーネントローカル `useState` `useAdminAgent.ts:25` | ページローカル `useState` `index.tsx:255, 259` |
| sessionId | `crypto.randomUUID()` を 1 回だけ `useAdminAgent.ts:29` | `useRef(crypto.randomUUID())` `index.tsx:258` |
| SPA内ページ遷移で残るか | ○ 残る（`<Routes>` の外にマウント、`if (!isOpen) return null` は hooks の後 `AdminAgentPanel.tsx:96`） | — （B は単一ページなので該当なし。旧UIへのリンクは別タブ固定 `index.tsx:829-833` で会話を守っている） |
| リロード / タブ復帰で残るか | **✕ 消える** | **✕ 消える** |
| sessionStorage / localStorage 利用 | なし（admin-ui 内の sessionStorage 利用は `auth/useAuth.tsx:61-89` の previewMode 永続化のみ） | なし |
| 履歴の送信方式 | 直近20件・各4000字上限 `useAdminAgent.ts:36-39` | 直近20件・**文字数上限なし** `index.tsx:294, 310-316` |

> **サーバ側に session 紐付き状態が実在する**: FAQ一括登録のステージングが `(tenantId, sessionId)` キーで 30 分 TTL で保持される（`src/api/admin/agent/knowledgeImportStaging.ts:45-48`、書き込み `actionExecutor.ts:1029, 1097`、確定 `:1138-1162`）。
> したがって **リロードで sessionId が再生成されると、確定待ちのFAQ一括登録が到達不能なまま TTL 切れになる**。会話永続化は「見た目の便利さ」ではなく、**サーバ側の未確定状態と整合を取る必須要件** である。

### 1.7 IME（日本語入力）の扱い

| 観点 | Surface A | Surface B |
|---|---|---|
| 入力要素 | `<textarea>` 複数行 `AdminAgentPanel.tsx:234-259` | `<input>` 単一行 `index.tsx:633-640` |
| Enter送信のガード | ○ **3 重に正しい** `AdminAgentPanel.tsx:83-94`: `e.nativeEvent.isComposing` / React state `isComposing`（`onCompositionStart/End` `:239-240`）/ `keyCode !== 229` | **✕ ガードなし** `index.tsx:636` — `onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}` |
| 影響 | — | 日本語変換確定の Enter が **そのまま送信** になる。変換途中の文字列が送られ、入力が失われる |
| Shift+Enterでの改行 | ○ | ✕（単一行 input のため改行自体が不可能） |

### 1.8 モバイル対応

| 観点 | Surface A | Surface B |
|---|---|---|
| レイアウト | `position: fixed` の 380×**600px 固定** `AdminAgentPanel.tsx:100-117` |フル画面 flex `index.tsx:504-515` |
| 狭幅対応 | `maxWidth: "calc(100vw - 32px)"` のみ（**高さは 600px 固定**。小さい端末では画面外にはみ出る） | `height: calc(100dvh - var(--cp-banner-h))` `index.css:228-235`（100vh フォールバック付き） |
| ブレークポイント | なし（インラインstyleのみ、CSSクラス無し） | `@media (max-width: 767px)` で rail をドロワー化 `index.css:255-290` |
| ドロワー / ハンバーガー | — | ○ `index.tsx:517-519, 528-534, 596-604` |
| タップ領域 44px | ○ 概ね確保 | ○ 概ね確保 |

### 1.9 対象テナントの決定方法（client_admin JWT vs super_admin previewMode）

| 観点 | Surface A | Surface B |
|---|---|---|
| 認証情報の取得元 | `App.tsx:101-107`（`useAuth`）→ **props で流し込む** | `useAuth()` を **ページが直接呼ぶ** `index.tsx:248` |
| 実効テナントID | `effectiveTenantId = previewMode ? (previewTenantId ?? null) : (user?.tenantId ?? null)` `App.tsx:107` | `previewTenantId`（`previewMode` 時のみ使用）`index.tsx:295` |
| `targetTenantId` の送信条件 | `isSuperAdmin` の時だけ送る `AdminAgentPanel.tsx:60, 69` | `previewMode && previewTenantId` の時だけ送る `index.tsx:295` |
| client_admin の場合 | 送らない → サーバがJWTの tenant_id を使う | 送らない → 同じ |
| 差異 | super_admin が **previewMode でない**（テナント未選択）状態でもパネルは表示され、`effectiveTenantId` は null。`showAIChat` は `isClientAdmin` 依存で、previewMode 中は true になる旨がコメント済み `App.tsx:104-107` | previewMode でなければ super_admin は `targetTenantId` なしで送る。加えてブートストラップの新規テナント判定は `!previewMode && user?.role === "client_admin"` に限定 `index.tsx:423` |
| 実質的な結論 | **判定ロジックが 2 箇所に別実装されている**（同じ意図・違う条件式）。片方を直してももう片方は直らない | — |

---

## 2. 重複インベントリ

### 2.1 両面が独立に実装しているもの（= 共有されていない重複）

| # | 重複している関心事 | Surface A | Surface B | 現状の乖離 |
|---|---|---|---|---|
| 1 | `POST /v1/admin/agent/chat` の呼び出し・エラー処理 | `useAdminAgent.ts:31-101` | `index.tsx:285-411` | B は `errBody.error` を表示、A は固定文言のみ |
| 2 | sessionId の生成・保持 | `useAdminAgent.ts:29` | `index.tsx:258` | 同じ意図の別実装。面を跨ぐと別セッションになる |
| 3 | 履歴ウィンドウ（直近20件） | `useAdminAgent.ts:36-39` | `index.tsx:294, 310-316` | A は各4000字上限あり、B は上限なし |
| 4 | `targetTenantId` の導出 | `App.tsx:107` + `AdminAgentPanel.tsx:60, 69` | `index.tsx:295` | §1.9 の通り条件式が別物 |
| 5 | ツール名 → 日本語ラベル | `AdminAgentMessage.tsx:4-14`（9件） | `index.tsx:42-88`（47件） | A が完全に取り残されている。A では大半のツールが生の英語名で表示される |
| 6 | Enter送信 + IME合成の扱い | `AdminAgentPanel.tsx:83-94` | `index.tsx:636` | **A は正しく、B は壊れている**（§3.1） |
| 7 | 末尾への自動スクロール | `AdminAgentPanel.tsx:44-46` | `index.tsx:264-267` | 実装は別だが挙動はほぼ同じ |
| 8 | 送信中インジケータ | `AdminAgentPanel.tsx:204-219`（「考え中...」バブル） | `index.tsx:641-643`（ボタンが「…」） | 表現が不統一 |
| 9 | 送信失敗の文言 | `useAdminAgent.ts:67, 94` | `index.tsx:304, 407` | 同一文言が計 4 箇所にハードコード |
| 10 | 同種の IME 実装の 3 本目 | — | — | `pages/admin/chat-test/index.tsx:660-662` に **3 本目の手書きコピー** が存在 |

### 2.2 本当に面固有のもの（共有すべきでないもの）

- **A 固有**: FAB とオーバーレイの座標・z-index (`AdminAgentButton.tsx:16-33`, `AdminAgentPanel.tsx:100-117`) / 相談窓口ループ（`useFeedbackReplies.ts`, `ReplyCard.tsx`, `FeedbackPrompt.tsx`）/ `answered_from` の出典ラベル / `initialQuery` 種まき起動。
- **B 固有**: 左レールとカテゴリロック / タイプライター演出 / カードパーサ群とカードUI / 確認チップ / 実書き込み件数バッジ / ブートストラップ（オンボーディング分岐・週次ブリーフィング）/ シェル機能パリティ（ベル・テーマ・言語・ログアウト・AppSwitcher）/ Phase4 既定化トグル。

> 注意: A 固有とした **相談窓口ループ（担当者返信）は「A に置くべき」ものではなく「B に無いだけ」** である。B を主面とするなら移植対象。

---

## 3. 現在の曖昧さが既に払っているコスト（仮定ではなく実測）

### 3.1 IME 重複が実際にバグを産んでいる（確定事実）

git 履歴で追える事実：

| 事実 | 根拠 |
|---|---|
| Surface A は **誕生時から** 正しい IME ガードを持っていた | `git log -S 'keyCode !== 229'` → `17fccc46` (#383), 2026-06-14 |
| Surface B は **1 ヶ月後に新規作成され**、ガードを持たずに実装された | `git log --diff-filter=A -- admin-ui/src/pages/copilot-preview/index.tsx` → `95b33329` (#489), 2026-07-17 |
| Surface B は **調査時点(2026-07-30)の `origin/main` でもまだ壊れている** | `index.tsx:636`、`origin/main` = `5f5b2ed4` |

つまり **正しい実装が同一リポジトリ内に 1 ヶ月以上前から存在していたのに、新しい面はそれを再利用せず、日本語入力が壊れた状態で約 13 日間本番相当のコードに載っていた**。日本語入力が主要ユースケースのプロダクトで、これは軽微な見落としではない。

さらに、この修正は現在 `fix/copilot-composer-ime-and-pending-draft` ブランチで別途進行中である（本ドキュメント執筆時点でコミットなし）。**このまま「B 側に手書きで正しいガードを足す」形で修正すると、同じロジックの手書きコピーが 3 本目 → 4 本目（`chat-test` 含む）に増える**。これは同じ事故の再発条件をそのまま残すことになる。

**→ これは「重複はリスクである」という一般論ではなく、「この 2 面の間の無主の重複は、既に一度ユーザー影響のあるバグを産んだ」という記録済みの事実である。**

### 3.2 共有コンテキストの片側だけが消費者を持っている（2 件目の実害）

- `copilot-preview` は rail 内に `AppSwitcher` を描画する (`index.tsx:538`)。
- `AppSwitcher` の R2C2 タブは、R2C2 未契約テナントに対して `openWithQuery("R2C2について教えて")` を呼ぶ (`AppSwitcher.tsx:81`)。
- `openWithQuery` は `AdminAgentUIContext` の state を立てるだけ (`AdminAgentUIContext.tsx:22-25`)。
- その state を消費するのは **Surface A のパネルだけ** (`App.tsx:255-271`)。
- ところが `/copilot-preview` では `App.tsx:136` の早期 return によりパネルはマウントされない。

**→ `/copilot-preview` 上で R2C2 タブを押しても何も起きない（無反応クリック）。** 「共有コンポーネントは片面にしか繋がっていない」という構造そのものが原因で、面固有の破綻が黙って生まれている。

### 3.3 監査・メトリクスが面を区別できない

- リクエストスキーマに面の識別子がない (`agentRoutes.ts:77-86`)。両面とも `crypto.randomUUID()` の sessionId を送るだけ。
- LLM 呼び出しのログ用 requestId も `admin-agent-${sessionId}-${Date.now()}` (`agentRoutes.ts:539, 570`) で、面の情報を含まない。
- システムプロンプトに sessionId が入るのみ (`agentRoutes.ts:465`)。

**→ 「どちらの面がどれだけ使われ、どちらでツール実行が失敗しているか」を後から集計できない。** 役割分担を決めても、その決定が正しかったかを測る手段が今は存在しない。

---

## 4. 3 つの選択肢

### 選択肢 (a) 1 面に統合する

2 通りの形がある。

**(a-1) パネルを廃止し、旧UIの起動点を `/copilot-preview` に飛ばす**

- 変えるもの: `App.tsx:255-271` の `AdminAgentButton`/`AdminAgentPanel` を削除。FAB は `/copilot-preview` へのリンク（別タブ or 同タブ）に置換。`components/AdminAgent/` は相談窓口ループ（`useFeedbackReplies` / `ReplyCard` / `FeedbackPrompt`）だけを B へ移植して残りを削除。
- コスト: 旧UIで作業中のユーザーが **その場で質問できなくなる**。設定作業の途中で画面ごと飛ばされる（同タブなら作業中の入力が消え、別タブならタブが増え続ける）。旧UIにしか存在しない設定画面がまだ多数ある現状では、体験としてほぼ改悪。
- 実装量: 小〜中。リスク: **高**（旧UI利用者の日常動線を直接壊す）。

**(a-2) Surface B のスレッド/コンポーザ/カードを埋め込み可能に切り出し、パネルはその薄いシェルにする**

- 変えるもの: `copilot-preview/index.tsx`（854行）を `components/agentChat/` へ分解 — `useAgentChat`（transport: sessionId・history・targetTenantId・エラー文言）/ `AgentComposer`（IME・Enter・Shift+Enter）/ `AgentThread` + `CardView`・パーサ群 / `AgentChips`。レール・ブートストラップ・バッジは props かフラグで外出し。パネル側は「レール無し・ブートストラップ無し・幅380のシェル」として同じ中身を描画。
- コスト: A と B は **スタイル体系が違う**（A は `rgba(15,23,42,0.98)` 等のダーク固定インライン `AdminAgentPanel.tsx:100-117`、B は `var(--background)` 等の CSS 変数 `index.tsx:506-515`）。統合には配色の統一パスが必須で、A の見た目は必ず変わる。854行の分解は複数PRに分割が必要。
- 実装量: **大**（複数PR）。リスク: 中（挙動は両面で不変を保てるため、リスクは主にリグレッション検知コスト）。

**永続化の置き場所（(a) の場合）: 共有ストア 1 本。** ユーザー単位（super_admin の previewMode 中は + テナント単位）で `sessionId` と `messages` を永続化し、どの入口から入っても同じスレッドが続く。統合するなら 2 本持つ理由が消える。

### 選択肢 (b) 役割分担を明示的に決める

- 位置づけ: パネル = 旧UIで作業しながらの **その場の短い質問**。全画面 = **日常の主面**。
- これが「ラベルを貼っただけの重複」に堕ちないための条件（= 役割分担でも **共有しなければならない層**）:
  1. **コンポーザ/送信セマンティクス（IME・Enter・Shift+Enter）** — §3.1 の事故が起きた層。最低限これは共有必須。現在進行中の IME 修正を「B へのコピー追加」ではなく **共有コンポーネント/フックへの抽出** として着地させることが条件。
  2. **transport 層** — sessionId 生成、履歴ウィンドウ（件数・文字数上限）、`targetTenantId` 導出（§1.9 の別実装を 1 本化）、エラー文言。
  3. **ツール名→日本語ラベル** — §2.1 #5 の 9件 vs 47件の乖離は、共有すれば構造的に消える。
  4. **セッション/履歴ストア** — 下記。
  - 逆に共有してはいけないもの: §2.2 の面固有項目（レイアウト、レール、演出、バッジ、ブートストラップ）。
- コスト: 抽出作業は (a-2) の 6〜7 割。加えて **役割分担を維持する規律を人間側が持ち続ける必要がある**（どの機能をどちらに入れるかの判断が毎回発生する）。
- 実装量: 中。リスク: 中（技術的リスクは低いが、**終期がないため再び乖離しうる**）。

**永続化の置き場所（(b) の場合）: 共有ストア 1 本（ユーザー単位キー）。** 2 本にしてはならない理由が 2 つある。
1. 面を跨いだ瞬間に「どちらが本当の会話履歴か」が決められなくなる。
2. `knowledgeImportStaging`（`(tenantId, sessionId)` キー・30分TTL、§1.6）は面を跨ぐと **確定待ちのFAQ一括登録が孤児化する**。sessionId を共有しない限りこの穴は塞がらない。
- 2 本を許容できるのは、**パネルを明示的に「使い捨て（永続化しない）」と規定し、UI 上でもそう見せる**場合のみ。その場合パネルからは `import_industry_faq_templates` 等の複数ターン確認フローを **使わせない** 制約が付く。

### 選択肢 (c) パネルは「橋」— 旧UIページの閉鎖に合わせて畳む

- 位置づけ: パネルの存在理由は **旧UIページが存在すること** に完全に従属する。旧UIページが閉じるにつれ、パネルの守備範囲は自動的に縮む。最後の旧UIページが閉じた時点でパネルを削除する。
- 前提: 旧UIページの閉鎖条件は並行タスクで定義中（ブランチ `docs/legacy-ui-sunset`。**調査時点では `docs/LEGACY_UI_SUNSET.md` は `origin/main` に未着地**）。本方針はその閉鎖基準ドキュメントと対で成立する。
- 変えるもの:
  1. **パネルを機能凍結する** — 新機能はパネルに入れない（カード、チップ、レール、ブートストラップを B から移植しない）。
  2. **(b) の共有層抽出はそのまま実施する** — 凍結対象は「面固有の新機能」であって「共有層のバグ修正」ではない。IME 抽出は最優先で行う。
  3. **B に無い A 固有機能（相談窓口ループ・`answered_from` ラベル）を B へ移植する** — 移植完了がパネル削除の前提条件になる。
  4. パネル削除の条件を明文化する: 「`showAIChat` が真になり得る旧UIパスが 0 になった時」(`App.tsx:103`)。
- コスト: 一定期間 2 面が残るため、その間の共有層メンテは必要（= (b) と同じ抽出コストを払う）。ただし **終期が定義されるため、払うコストの総量に上限が付く**。
- 実装量: 中（(b) と同等）。リスク: 低（既存動線を壊さず、削除は旧UI閉鎖の副産物として起きる）。

**永続化の置き場所（(c) の場合）: 共有ストア 1 本。ただし実装は Surface B 側に置く。** 具体的には `lib/agentSession.ts` 相当を新設し（sessionId + messages を sessionStorage にユーザー単位キーで保持）、B が主実装・A はそれを読み書きするだけにする。**畳む予定のコンポーネントのために 2 本目の永続化機構を作らない**、が原則。

---

## 5. 永続化の置き場所（まとめ — 追随タスクへの回答）

| 選択肢 | 会話永続化 | ストア数 | キー | 備考 |
|---|---|---|---|---|
| (a) 統合 | 共有 1 本 | 1 | user（super_admin previewMode 時は user + previewTenantId） | 統合後は 2 本持つ理由が消える |
| (b) 役割分担 | 共有 1 本 | 1 | 同上 | 2 本は `knowledgeImportStaging` の孤児化を招くため不可。2 本にするならパネルを「永続化しない使い捨て」と明示し複数ターン確認フローを封じる |
| (c) 橋 | 共有 1 本（実装は B 側に置き A は利用者） | 1 | 同上 | 畳む側に永続化機構を作らない |

**3 案すべてで「共有ストア 1 本」が答えになる。** これは選択肢の分岐点ではなく、`(tenantId, sessionId)` キーのサーバ側ステージング状態（`knowledgeImportStaging.ts:45-48`）から演繹される制約である。したがって **会話永続化の実装は、面の役割分担の決定を待たずに着手できる**。

---

## 6. 推奨

# → 選択肢 (c)「パネルは橋。旧UIページ閉鎖に合わせて畳む」を推奨する。

### 理由（すべて実コードの観測に紐づく）

1. **パネルの存在理由は構造上すでに旧UIに従属している。** パネルは `showAIChat = isClientAdmin && pathname !== "/admin/chat-test"` (`App.tsx:103`) というパス条件で可視化され、`/copilot-preview` では `App.tsx:136` の早期 return により **原理的にマウントされない**。つまり「旧UIページの上に浮くもの」以外の役割をコードは一度も持っていない。役割分担を新たに定義するのではなく、**既にコードが表明している従属関係を明文化する** のが (c) である。

2. **機能の非対称が一方向に振り切れている。** B が持って A が持たないものは 10 項目以上（カード6種・チップ・レール・ブートストラップ・演出・進捗バッジ・47件のツールラベル・dvh対応・ドロワー、§1.2〜§1.8）。逆に A が持って B が持たないものは **2 項目だけ**（相談窓口ループ、`answered_from` ラベル）で、どちらも移植可能。この非対称は「対等な 2 面」ではなく「主面と暫定面」の形をしている。

3. **§3.1 の IME 事故は、終期のない役割分担 (b) が既に一度失敗した記録である。** 現状は事実上 (b) を暗黙に運用していた状態であり、その結果として正しい実装が 1 ヶ月以上前から同リポジトリにあるのに再利用されず、日本語入力が約 13 日壊れた。(b) を明示的に選び直しても、**乖離を止める強制力（終期）が増えない**。(c) は (b) の共有層抽出をすべて含みつつ、終期という強制力を追加する。§3.2 の無反応クリックも同じ構造から生まれており、2 面が対等に増え続ける限り同種の破綻は再生産される。

4. **(a) を今やるのは早い。** 旧UIにしか存在しない設定画面がまだ多く、閉鎖基準ドキュメント（`docs/LEGACY_UI_SUNSET.md`）が `origin/main` にまだ無い。閉鎖条件が未定義のまま (a-1) でパネルを消せば旧UI利用者の動線が壊れ、(a-2) で今すぐ 854行を分解しても、どこまでを共通化すべきかの基準（=どの面が生き残るか）が確定していない状態での大規模リファクタになる。(c) は **(a-2) の抽出を段階的に前倒しで進めつつ、統合の完了時点を旧UI閉鎖に同期させる**ため、同じ着地点により低いリスクで到達する。

### (c) を選んだ場合の即時アクション（優先順）

1. **進行中の IME 修正（`fix/copilot-composer-ime-and-pending-draft`）を「B への手書きコピー追加」ではなく「共有コンポーネント抽出」として着地させる。** これを外すと §3.1 の再発条件がそのまま残る（`chat-test` 含め 3 本目・4 本目の手書きコピーになる）。
2. **transport 層（sessionId / 履歴ウィンドウ / `targetTenantId` 導出 / エラー文言）を共有フックに 1 本化**（§2.1 #1〜#4, #9）。特に §1.9 の `targetTenantId` 別実装は認可に触れるため優先。
3. **会話永続化を共有ストア 1 本で実装**（B 主実装、ユーザー単位キー、sessionId も永続化）。§5 の通り役割分担の決定を待つ必要はない。
4. **`POST /v1/admin/agent/chat` に `surface: "panel" | "fullscreen"` を追加**（`agentRoutes.ts:77-86` のスキーマ、ログの requestId `:539, 570`）。移行の進捗と効果を測れるようにする。
5. **パネル機能凍結の明文化**と、A 固有 2 機能（相談窓口ループ・`answered_from`）の B への移植。移植完了をパネル削除の前提条件として `docs/LEGACY_UI_SUNSET.md` 側に条件として書き込む。
6. **`/copilot-preview` 上の AppSwitcher 無反応クリック（§3.2）の解消** — B 側で `openWithQuery` 相当を自前のスレッドへの送信に繋ぐ。

### 本推奨が誤りだと判明する条件（反証条件）

- 旧UIページを **畳まない** 経営判断が出た場合。パネルの終期が消えるため (c) の前提が崩れ、(b) を明示的に選んで共有層を恒久化する必要がある。
- `/copilot-preview` の全画面UXが評価されず主面にならない場合。この場合は A が主面となり、A 側にカード・チップを移植する逆方向の統合（(a-2) の鏡像）になる。判断には §3.3 の面別メトリクス（即時アクション 4）が必要。
