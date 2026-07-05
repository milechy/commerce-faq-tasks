-- GID 1216274385106667: FAQ登録フォームの質問/回答欄に、テナントごとの
-- カスタム入力例(プレースホルダー)を設定できるようにする。
-- NULL = 組み込みの汎用プレースホルダーを使う(既存動作を維持)。
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS faq_question_hint TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS faq_answer_hint TEXT;
