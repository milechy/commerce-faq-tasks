-- Phase75: tuning_rules に (tenant_id, trigger_pattern) の UNIQUE 制約を追加
--
-- 背景:
--   judgeEvaluator.ts の tuning_rules INSERT も conversation_evaluations と同じく
--   ターゲット無しの `ON CONFLICT DO NOTHING` で、SERIAL の id にしか反応できず no-op だった。
--   evaluationAnalyzer.ts は「trigger_pattern と tenant_id でユニーク判定」とコメントで
--   明言しているが、その制約は DB に存在しなかった。低スコア評価が繰り返されるたびに
--   同じ提案ルールが積み上がる。
--
-- ★このマイグレーションは conversation_evaluations 側より慎重に扱うこと:
--   tuning_rules の行には運用者の作業結果が乗っている
--   (approved_at / rejected_at / edited_by / edited_at / original_text / approved_responses)。
--   重複削除でこれらを失わないよう、下の ORDER BY は「人が触った行」を最優先で残す。
--
-- ★適用順序の厳守:
--   judgeEvaluator.ts の `ON CONFLICT (tenant_id, trigger_pattern) DO NOTHING` より
--   先に適用すること。逆順だと提案ルールの INSERT が全て失敗する
--   (judgeEvaluator 側は try/catch で握って warn ログに落とすため、
--    評価自体は成功するが提案ルールだけが静かに保存されなくなる)。

-- ============================================================
-- 1. 事前確認 (手動実行して結果を目視してから 2 へ進むこと)
-- ============================================================
-- 重複の実数:
--   SELECT tenant_id, trigger_pattern, COUNT(*) AS dup_count
--   FROM tuning_rules
--   GROUP BY tenant_id, trigger_pattern
--   HAVING COUNT(*) > 1
--   ORDER BY dup_count DESC;
--
-- 削除対象に「人が触った行」が含まれていないか (0件であることを確認する):
--   WITH ranked AS (
--     SELECT id, approved_at, rejected_at, edited_at, approved_responses,
--            ROW_NUMBER() OVER (
--              PARTITION BY tenant_id, trigger_pattern
--              ORDER BY
--                (approved_at IS NOT NULL) DESC,
--                (rejected_at IS NOT NULL) DESC,
--                (edited_at IS NOT NULL) DESC,
--                (CASE WHEN jsonb_typeof(approved_responses) = 'array'
--                       THEN jsonb_array_length(approved_responses) > 0
--                       ELSE false END) DESC,
--                is_active DESC,
--                id DESC
--            ) AS rn
--     FROM tuning_rules
--   )
--   SELECT COUNT(*) FROM ranked
--   WHERE rn > 1
--     AND (approved_at IS NOT NULL OR rejected_at IS NOT NULL OR edited_at IS NOT NULL
--          OR (jsonb_typeof(approved_responses) = 'array'
--              AND jsonb_array_length(approved_responses) > 0));
--
-- btree のインデックスサイズ上限(約2704バイト)に触れる長い trigger_pattern が無いか
-- (0件であること。あれば UNIQUE INDEX 作成が失敗するので、先に該当行を短縮/削除する):
--   SELECT id, tenant_id, length(trigger_pattern) AS len
--   FROM tuning_rules
--   WHERE octet_length(trigger_pattern) > 2000
--   ORDER BY len DESC;

-- ============================================================
-- 2. 重複行の削除
-- ============================================================
-- 残す行の優先順位: 承認済み > 却下済み > 編集済み > 採用返答あり > 有効 > id が大きい
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, trigger_pattern
      ORDER BY
        (approved_at IS NOT NULL) DESC,
        (rejected_at IS NOT NULL) DESC,
        (edited_at IS NOT NULL) DESC,
        -- jsonb_array_length は配列以外でエラーになるため型を先に確かめる
        (CASE WHEN jsonb_typeof(approved_responses) = 'array'
              THEN jsonb_array_length(approved_responses) > 0
              ELSE false END) DESC,
        is_active DESC,
        id DESC
    ) AS rn
  FROM tuning_rules
)
DELETE FROM tuning_rules
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ============================================================
-- 3. UNIQUE 制約 (ON CONFLICT (tenant_id, trigger_pattern) のターゲット)
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tuning_rules_tenant_trigger
  ON tuning_rules (tenant_id, trigger_pattern);

COMMENT ON INDEX uniq_tuning_rules_tenant_trigger IS
  'Phase75: 同一テナント内で trigger_pattern は一意。judgeEvaluator の ON CONFLICT (tenant_id, trigger_pattern) のターゲット。evaluationAnalyzer が前提にしていた一意性を DB 側で保証する。';

-- ============================================================
-- 4. 適用後の確認 (手動実行)
-- ============================================================
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'tuning_rules' AND indexname = 'uniq_tuning_rules_tenant_trigger';
--
--   SELECT COUNT(*) FROM (
--     SELECT 1 FROM tuning_rules
--     GROUP BY tenant_id, trigger_pattern HAVING COUNT(*) > 1
--   ) d;

-- ============================================================
-- ロールバック
-- ============================================================
-- DROP INDEX IF EXISTS uniq_tuning_rules_tenant_trigger;
-- ※削除した重複行は戻らない。適用前に必ず pg_dump でバックアップを取ること。
