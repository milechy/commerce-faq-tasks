-- G6: 会話とページ行動・CVを結合するための visitor_id 永続化
-- (学習ループ要件定義 docs/LEARNING_LOOP_REQUIREMENTS.md §9 G6)
--
-- /api/chat は body.visitor_id を受信済みだった(route.ts の zod スキーマ)が、
-- chat_sessions に永続化しておらず、行動コンテキスト取得のためだけに使い捨てていた。
-- widget の visitor_id (localStorage 'r2c_vid') はテナントを跨いで同じ値が
-- 送られうるため、必ず (tenant_id, visitor_id) の複合で扱うこと(単独でキーにしない)。
--
-- 原理的な限界: localStorage 由来のためプライベートブラウズでは毎回新規になる。
-- event_tracking 機能フラグが off のテナントでは visitor_id が一切来ない。
-- 結合率100%は前提にせず、NULL 許容で設計する。

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS visitor_id TEXT;

COMMENT ON COLUMN chat_sessions.visitor_id IS
  'widget EventTracker が生成する localStorage 由来の訪問者ID(r2c_vid)。テナントを跨いで衝突しうるため単独ではキーにしない。NULL許容(プライベートブラウズ・event_tracking無効テナントでは付与されない)。';

CREATE INDEX IF NOT EXISTS idx_chat_sessions_visitor ON chat_sessions(tenant_id, visitor_id);
