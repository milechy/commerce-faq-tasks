-- Phase75: conversation_evaluations に (tenant_id, session_id) の UNIQUE 制約を追加
--
-- 背景:
--   judgeEvaluator.ts の INSERT は `ON CONFLICT DO NOTHING` をターゲット無しで書いていたが、
--   このテーブルの唯一の一意制約は SERIAL の id だけだった。SERIAL は採番のたびに新しい値を
--   取るため衝突しえず、結果としてこの ON CONFLICT は完全な no-op で、同一セッションの
--   評価行が何行でも入っていた。
--
--   実害は Gemini の二重課金よりも KPI 汚染の方が大きい。evaluationsRepository の
--   AVG(score) / COUNT(*) は DISTINCT 無しで集計するため、重複したセッションはその回数だけ
--   平均に重み付けされる。そして重複しやすいのはターン予算を超えた長い会話、つまり
--   低スコアになりがちなセッションなので、テナントに見せている品質平均が構造的に下振れする。
--
-- ★適用順序の厳守:
--   このマイグレーションは judgeEvaluator.ts の
--   `ON CONFLICT (tenant_id, session_id) DO NOTHING` より先に適用すること。
--   逆順にすると Postgres が
--   「there is no unique or exclusion constraint matching the ON CONFLICT specification」
--   を返し、全ての評価 INSERT が失敗する。詳細は docs/DEPLOY_CHECKLIST.md を参照。

-- ============================================================
-- 1. 事前確認 (手動実行して結果を目視してから 2 へ進むこと)
-- ============================================================
-- 重複がどれだけあるか:
--   SELECT tenant_id, session_id, COUNT(*) AS dup_count
--   FROM conversation_evaluations
--   GROUP BY tenant_id, session_id
--   HAVING COUNT(*) > 1
--   ORDER BY dup_count DESC;
--
-- 削除対象に承認済みルールが含まれていないか (0件であることを確認する):
--   WITH ranked AS (
--     SELECT id, suggested_rules,
--            ROW_NUMBER() OVER (
--              PARTITION BY tenant_id, session_id
--              ORDER BY
--                (CASE WHEN jsonb_typeof(suggested_rules) = 'array'
--                       THEN EXISTS (SELECT 1 FROM jsonb_array_elements(suggested_rules) e
--                                    WHERE jsonb_exists(e, 'status'))
--                       ELSE false END) DESC,
--                evaluated_at DESC NULLS LAST,
--                id DESC
--            ) AS rn
--     FROM conversation_evaluations
--   )
--   SELECT COUNT(*) FROM ranked
--   WHERE rn > 1
--     AND jsonb_typeof(suggested_rules) = 'array'
--     AND EXISTS (SELECT 1 FROM jsonb_array_elements(suggested_rules) e
--                 WHERE jsonb_exists(e, 'status'));

-- ============================================================
-- 2. 重複行の削除 (UNIQUE INDEX を張る前に必須。残さないと index 作成自体が失敗する)
-- ============================================================
-- 残す行の優先順位:
--   (1) suggested_rules に status(approved/rejected) が付いている行
--       = 人間が承認/却下の判断を下した行。これを消すと運用者の作業が消える
--   (2) 次に evaluated_at が新しい行
--   (3) 最後に id が大きい行 (tie-break)
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, session_id
      ORDER BY
        -- CASE で型を先に確かめる。jsonb_array_elements は配列以外を渡すとエラーになり、
        -- 1行でも配列以外があるとマイグレーション全体が途中で落ちるため。
        (CASE WHEN jsonb_typeof(suggested_rules) = 'array'
              THEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(suggested_rules) e
                WHERE jsonb_exists(e, 'status')
              )
              ELSE false END) DESC,
        evaluated_at DESC NULLS LAST,
        id DESC
    ) AS rn
  FROM conversation_evaluations
)
DELETE FROM conversation_evaluations
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ============================================================
-- 3. UNIQUE 制約 (ON CONFLICT (tenant_id, session_id) のターゲット)
-- ============================================================
-- 1セッションにつき1評価。phase71_learned_memory.sql の
-- uniq_learned_memory_session と同じ考え方。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conv_eval_session
  ON conversation_evaluations (tenant_id, session_id);

COMMENT ON INDEX uniq_conv_eval_session IS
  'Phase75: 1セッション1評価。judgeEvaluator の ON CONFLICT (tenant_id, session_id) のターゲット。KPI集計(AVG/COUNT)が重複行で歪むのを防ぐ。';

-- ============================================================
-- 4. 適用後の確認 (手動実行)
-- ============================================================
-- インデックスが張られたか:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'conversation_evaluations' AND indexname = 'uniq_conv_eval_session';
--
-- 重複が消えたか (0件であること):
--   SELECT COUNT(*) FROM (
--     SELECT 1 FROM conversation_evaluations
--     GROUP BY tenant_id, session_id HAVING COUNT(*) > 1
--   ) d;

-- ============================================================
-- ロールバック
-- ============================================================
-- DROP INDEX IF EXISTS uniq_conv_eval_session;
-- ※削除した重複行は戻らない。適用前に必ず pg_dump でバックアップを取ること。
