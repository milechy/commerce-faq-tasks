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
倍率     = free_ad 0 / starter 1.0 / growth 1.5 / enterprise 2.5
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

## 7. 確定価格と課金単位の不一致（2026-08-26 時点の未解決事項）

確定価格（Asana 1217848935050634）は **会話単位**：

| プラン | 初期費用 | 月額 | 込み枠 | 超過 |
|---|---|---|---|---|
| free_ad | ¥0 | ¥0 | 200会話・テキストのみ | 停止 |
| Starter | ¥0 | 純従量 ¥20/会話 | 上限 500会話/月 | Growth案内 |
| Growth | ¥0 | ¥29,800（年払 ¥298,000） | テキスト3,000 + アバター100 | ¥30/テキスト・¥400/アバター |
| Enterprise | ¥0 | 個別 | 無制限 | ×2.5 |

一方 §1 の実装は **リクエスト単位**（`usage_logs` の行数）。「1会話 ≒ 5ターン」は原価試算上の平均で
あって規則ではない。**この2つはまだ接続されていない。** 実装時にどちらかへ寄せること：

- **会話（`chat_sessions`）単位で数える** → LP と一致する。実装が増える
- **リクエスト単価に換算**（¥20 ÷ 5 = ¥4/リクエスト）→ カウント処理は不変だが、
  会話が長いテナントほど割高になり **LP 文言の修正が必要**（CLAUDE.md 禁止54）

**Growth の込み枠はテキストとアバターを別枠で持つ（必須）。** 合算すると、
30% がアバターのテナント（900件 × ¥72 = ¥64,800）で ¥29,800 が大赤字になる。

既存の `PLAN_MULTIPLIERS` は正しいので再設計しない。テキスト超過 ¥20→¥30 はちょうど ×1.5 で整合する。

経緯と実測値は MEMORY.md の収益監査（2026-08-25）を参照。同じ調査を繰り返さない。
