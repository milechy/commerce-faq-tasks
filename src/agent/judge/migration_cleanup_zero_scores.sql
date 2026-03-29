-- Phase45 E2E修正: Geminiエラー時に作られた不完全レコードを削除
-- score=0 かつ feedback IS NULL のレコード（正常な0点はfeedbackが入っている）
DELETE FROM conversation_evaluations
WHERE score = 0
AND (feedback IS NULL OR feedback = '{}'::jsonb)
AND psychology_fit_score IS NULL;
