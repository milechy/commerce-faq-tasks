---
name: billing
description: R2C 収益パイプラインの不変ルール — 請求数量の定義、金額の単位、単一の出どころ、fail-safe の向き
version: 1.0.0
paths:
  - "src/lib/billing/**"
  - "src/api/internal/usageRoutes.ts"
  - "admin-ui/src/pages/admin/billing/**"
  - "src/agent/llm/**"
  - "src/lib/gemini/client.ts"
---

# 収益パイプラインの不変ルール

## 1. 請求数量の定義（これが唯一の課金単位）

```
請求数量 = Σ( 単位数 × その行の plan_multiplier )   ※ billable = true の行のみ
単位数   = 1 行 = 1 リクエスト（anam_session のみ 秒→分の切り上げ）
倍率     = free_ad 0 / starter 1.0 / standard 1.25 / growth 1.5 / enterprise 2.5
```

- **`cost_total_cents` は請求額ではない。** 原価 × マージン（USD セント）であり、
  Stripe の実請求とは別系統。突合・赤字検知のための値。
- 倍率は **利用時点で `usage_logs.plan_multiplier` に焼き付ける**。請求バッチ時点の
  `tenants.plan` を月全体に掛けると、月中のプラン変更が月初まで遡る
  （enterprise で1か月使い月末に free_ad へ落とすと全額 0 円になる）。
- `plan_multiplier IS NULL` は **「未確定」であって「無料(0)」ではない**。
  DEFAULT を置かない。NULL 行は `tenants.plan` 由来の倍率にフォールバックする。
- 同一リクエスト内の追加 LLM 呼び出し（planner / 蒸留 / チャンク処理）は
  **`extraLlmUsages` に内包して 1 行に保つ**。別行にすると請求数量がそのまま水増しされる。

## 2. 単一の出どころ

| 関心事 | 唯一の置き場所 |
|---|---|
| 請求数量・請求予定額の算出 | `stripeSync.ts` の `computeExpectedBilling`（送信・突合・画面すべてがこれを通す） |
| プラン倍率 | `planPricing.ts` の `PLAN_MULTIPLIERS` / `planMultiplier`（`stripeSync.ts` に re-export を置かない） |
| 単価表・原価計算 | `costCalculator.ts`（`LLM_COSTS` と各外部APIの単価定数） |
| 計上 | `usageTracker.ts` の `trackUsage`（fire-and-forget、`ON CONFLICT (request_id) DO NOTHING`） |
| 金額の表示整形 | `admin-ui/src/pages/admin/billing/utils.ts`（**単位ごとに別関数**） |

**集計SQLを書き写さない。** 式を2箇所に書くと、片方だけ直したときにサイレントにドリフトし、
「突合ジョブは一致と報告するが、実は両方とも同じバグを踏んでいるだけ」という状態になる。

## 3. 金額の単位

- `*_cents` = **USD セント**（原価系）。`*_jpy` = **円**。JPY はゼロデシマル通貨なので
  Stripe の `amount_due` は**そのまま円**であり 100 で割らない。
- リポジトリに USD→JPY の換算処理は**存在しない**。原価表示を「円」と称さない。
- 単位を持たない `amount` / `cost` という名前を新設しない。

## 4. fail-safe の向きは 2 系統ある（統合しない）

| 用途 | ファイル | 未確定時の落とし先 | 取り違えたときの事故 |
|---|---|---|---|
| 機能ゲート | `planFeatures.ts` | **最も制限の強い段** | 請求側に寄せると DB 障害時にプラン外機能が開く |
| 請求 | `planPricing.ts` | **`starter` 1.0** | 機能側に寄せると DB 障害時に請求が 0 円で固着する |

`usageTracker` は `queryTenantPlanResult`（確定できなければ `null`）を使う。
機能ゲート用の `getTenantPlan`（失敗時 free_ad へ倒す）を請求に流用しない —
DB が一瞬詰まっただけでその分の請求が恒久的に 0 円で固着する。

## 5. 壊れやすい前提（触る前に実物を確認する）

- **列があるか。** `usage_logs.plan` / `plan_multiplier`、`stripe_usage_reports.billed_quantity`、
  `stripe_webhook_events` は migration 未適用だと 42703 で無言劣化する。
  migration を足したら `SCRIPTS/ci-billing-schema.sh` の `FILES` 配列に**同じ PR で**追加する。
- **env があるか。** `STRIPE_SECRET_KEY` 未設定で請求バッチは**無言で存在しなくなる**。
  `SLACK_WEBHOOK_URL` 未設定でアラートは全てサイレント return する。
  `LEMONSLICE_/LIVEKIT_/PLATFORM_MONTHLY_FEE_JPY` 未設定で固定費按分は無効（既定 OFF）。
- **`feature_used` の allowlist が3箇所で一致しているか。** `FeatureUsed` 型 / DB の CHECK 制約 /
  `NON_BILLABLE_FEATURES`。片方だけ足すと CHECK 違反で INSERT が落ち、利用記録ごと消える。

## 6. 変更時チェックリスト

1. 外部APIを呼ぶ経路を足した → `trackUsage` を同一リクエストパスに入れたか（漏れ＝当社負担）
2. `tenantId` を渡したか（`unknown` 計上は請求できない原価になる）
3. 行数が増えていないか（`extraLlmUsages` に内包したか）
4. 単価が `costCalculator.ts` にあるか（無いと 0 円計上で赤字が不可視）
5. 表示を触った → 単位と語彙は正しいか（原価を「請求額」と呼んでいないか）
6. 定期処理を触った → 起動直後に走るか / tick が重ならないか
7. 本番で 1 周したか（`status='sent'` / `completed_at` / `billing_status='paid'` が各 1 件以上）

## 7. 確定価格と課金単位（2026-08-26 確定）

確定価格（Asana 1217848935050634）は **会話単位**：

| プラン | 初期費用 | 月額 | 年払い | 込み枠 | 超過 | アバター |
|---|---|---|---|---|---|---|
| free_ad | ¥0 | ¥0 | — | 200会話・テキストのみ | 停止 | ✗ |
| Starter | ¥0 | 純従量 ¥20/会話 | — | 上限 500会話/月 | Growth案内 | ✗ |
| **Standard** | ¥0 | **¥9,800** | ¥98,000 | テキスト1,000会話 + **アバター30分** | ¥25/会話・**¥100/分** | **既定のみ** |
| Growth | ¥0 | ¥29,800 | ¥298,000 | テキスト3,000会話 + **アバター150分** | ¥30/会話・**¥80/分** | カスタム可 |
| Enterprise | ¥0 | 個別 | 個別 | 無制限 | ×2.5 | カスタム可 |

### 課金単位（テキスト＝会話 / アバター＝分）

**テキストは「会話（セッション）」で数える。** 課金対象は `chat_sessions.message_count >= 2`
（＝1往復以上）のセッション。本番実測（90日）では **0 件が 325 セッション（23%）** あり、
ウィジェットを開いただけのものは課金しない。`message_count = 1`（応答が返っていない）も課金しない。
セッション継続時間は中央値 0 分・最大 2.2 分なので、**再訪問者のセッション境界問題は実質発生しない** —
`chat_sessions.session_id` をそのまま使ってよい。

**アバターは「分」で数える。** 原価は回数ではなく時間に比例する（実測 **¥25.9/分**）。
1 セッションあたりの原価は 1 分未満 819 件で ¥19、**15 分以上が 72 件（7.6%）で ¥799 と 42 倍の開き**があり、
回数あたりの定額では長時間セッション 1 件で赤字になる。`anam_session` が既に
`CEIL(anam_session_seconds/60.0)` で分換算しているのと**同じ扱いを全アバターに適用する**。
アバターを使ったセッションは**アバターとしてのみ計上**し、テキスト会話と二重計上しない。

超過単価 ¥100/分 は原価 ¥25.9/分 の約 3.9 倍で、30 分の長時間セッションでも ¥3,000 回収でき赤字にならない。
Growth は ¥80/分（×0.8）で、**上位プランほど分単価が下がる**。この向きを逆にしない。

**`usage_logs` に `session_id` が無い（2026-08-26 時点）。** 列は `request_id`（リクエスト毎の
ランダム UUID）のみで、**会話を復元する手段が存在しない**。会話単位の計上には
`session_id` を足す migration と、チャット／アバター経路の `trackUsage` への配線が要る
（管理系の計上は会話ではないので不要）。セッション内で `plan_multiplier` が割れた場合は
**最初の行の値**を採用する（会話開始時点のプラン）。

### 機能ゲート（`FEATURE_MIN_PLAN`）

| 機能 | free_ad | Starter | Standard | Growth | Enterprise |
|---|---|---|---|---|---|
| `avatar`（既定アバターの利用） | ✗ | ✗ | **✓** | ✓ | ✓ |
| `avatar_customize`（自社アバターの作成）★新設 | ✗ | ✗ | ✗ | **✓** | ✓ |
| `premium_avatar` | ✗ | ✗ | ✗ | ✓ | ✓ |
| `voice_clone` | ✗ | ✗ | ✗ | ✗ | ✓ |
| `analytics` / `conversion` / `hide_branding` | ✗ | ✗ | ✗ | ✓ | ✓ |

★ `avatar_customize` は実装済み（`src/api/admin/avatar/avatarCustomizeGate.ts` が唯一の判定）。
`generationRoutes.ts` の4ルート（generate-image / match-voice / design-voice / generate-prompt）と
`falGenerationRoutes.ts` の1ルートが、外部APIを呼ぶ前にこのゲートを通す。
以前はロール認可のみだったため、client_admin なら全プランで素通りしていた。
**`avatar` と `avatar_customize` を1つのゲートに統合しないこと** —
統合すると、Standard の売り（既定アバターで安く始められる）か
Growth の売り（自社アバターを作れる）のどちらかが必ず消える。

§1 の実装は **リクエスト単位**（`usage_logs` の行数）のままなので、**上記の課金単位とはまだ接続されていない**。
なお原価試算で使われていた「1会話 ≒ 5ターン」は**実測で否定されている** — 本番 90 日の実データでは
`message_count` は中央値 2・p99 も 2（＝1往復）で、テキスト原価は ¥0.55 ではなく **¥0.11/会話**。
この数字を根拠に据えているドキュメントを見つけたら実測値に直すこと。

**込み枠はテキストとアバターを別枠で持つ（必須）。** 合算すると、アバターに偏ったテナント 1 社で
月額が丸ごと飛ぶ（アバターは ¥25.9/分で、30 分セッション 1 件が ¥799）。

`PLAN_MULTIPLIERS` は既存値（free_ad 0 / starter 1.0 / growth 1.5 / enterprise 2.5）を再設計せず、
**`standard: 1.25` を追加するだけ**にする。テキスト超過は ¥20 →（×1.25）¥25 →（×1.5）¥30 と倍率どおりに整合する。
**アバターの分単価は倍率と逆向き**（Standard ¥100 → Growth ¥80）なので、
倍率をそのまま掛けて算出しない — 分単価はプランごとの定数として持つ。

経緯と実測値は MEMORY.md の収益監査（2026-08-25）を参照。同じ調査を繰り返さない。
