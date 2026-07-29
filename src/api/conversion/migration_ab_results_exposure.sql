-- src/api/conversion/migration_ab_results_exposure.sql
-- GID 1216978855735482: アバター効果A/Bテスト基盤
--
-- 従来のab_resultsは成果(converted)確定時にのみ1行INSERTする想定で
-- converted NOT NULLだった。露出(割当)時点で1行先にINSERTし、成果は
-- 後から更新できるようにconvertedをNULL許容にする。
-- 同一セッションへの重複露出記録を防ぐため (experiment_id, session_id) にユニーク制約を追加する。

ALTER TABLE ab_results ALTER COLUMN converted DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ab_results_exp_session
  ON ab_results(experiment_id, session_id)
  WHERE session_id IS NOT NULL;

-- 主要指標「2往復以上に進んだセッションの割合」を保持するカラム。
-- 集計のたびに chat_sessions.message_count と突合して更新する（reconcileAbResultOutcomes）。
ALTER TABLE ab_results ADD COLUMN IF NOT EXISTS reached_two_plus_exchanges BOOLEAN;
