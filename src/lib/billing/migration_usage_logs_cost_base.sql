-- src/lib/billing/migration_usage_logs_cost_base.sql
-- usage_logs に「マージン前の総原価」を記録する列を追加する。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ必要か（粗利が計算できない）
-- テナント別の粗利(売上 − API原価)を出すには「マージンを掛ける前の総原価」が要る。
-- ところが既存の2列はどちらもそれではない:
--   cost_llm_cents   … LLM分のみ。TTS/avatar/anam/OCR/ASR/画像/server cost を含まない
--   cost_total_cents … マージン適用後(= calculateBillingAmountCents の戻り値)
-- つまり「実際にいくら払ったか」を保持している列が1つも無い。
--
-- ■ 過去行を逆算で埋めない理由（DEFAULT も UPDATE も置かない）
-- cost_total_cents は Math.ceil(totalUSD * margin * 100) で、margin は
--   usage.marginOverride ?? (isEndUser ? MARGIN_MULTIPLIER : 1)
-- (costCalculator.ts:368)。ここから原価を割り戻すのは3つの理由で不完全:
--   1. marginOverride は列に残らない。margin=1 で記録された end-user 機能の行
--      (perplexityProvider.ts / options/routes.ts / feedbackAI.ts の3経路が実在)を
--      cost_total_cents / MARGIN_MULTIPLIER すると原価を 1/MARGIN 倍に過小評価する
--   2. MARGIN_MULTIPLIER は env(MARGIN_RATE)で、変更履歴が DB にもコードにも無い
--      (2026-09-04 時点の本番実値は 10。.env.example の 0.3 は実態と乖離しており別途是正)
--   3. Math.ceil が二重に効くので割り戻しても元の値には戻らない
-- ★ここを DEFAULT や一括 UPDATE で埋めてはいけない★ — 埋めると「実測した原価」と
-- 「逆算した推計」が同じ列に混ざり、二度と区別できなくなる。読み取り側
-- (tenantEconomics.ts)が NULL の行だけを推計にフォールバックし、レスポンスに
-- estimation_method='derived' を立てて呼び出し元に開示する。
--
-- ■ NULL の意味（「未記録」であって「原価ゼロ」ではない）
-- 本マイグレーション適用前に記録された既存行は NULL のままになる。
-- plan_multiplier(migration_usage_logs_plan_snapshot.sql)と同じ設計で、
-- 0 と NULL は別物なので DEFAULT を置かないのは意図的(CLAUDE.md 禁止20)。
--
-- ■ CHECK 制約を張らない理由
-- usage_logs は毎リクエスト書き込まれる最高トラフィックのテーブルで、
-- ここで CHECK 違反を起こすと利用記録そのものが失われる(= 請求不能)。
-- plan_multiplier と同じ判断で、値の妥当性は書き込み側(usageTracker.ts)で担保する。

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS cost_base_cents INTEGER;

COMMENT ON COLUMN usage_logs.cost_base_cents IS
  'この行の実原価(USDセント、マージン適用前)。LLM/TTS/avatar/ASR/画像/server cost の合計。'
  'cost_total_cents = この値にマージン倍率を掛けたもの(ただし Math.ceil が両方に効くため厳密な整数倍ではない)。'
  'NULL = 未記録(本カラム追加前の既存行)。0 とは別物なので DEFAULT を置かないこと。'
  'NULL 行の原価は tenantEconomics.ts が読み取り時に cost_total_cents から推計し、'
  'estimation_method=derived としてレスポンスに開示する(過去行を UPDATE で埋めない)。';
