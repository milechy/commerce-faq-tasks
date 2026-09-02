-- 是正0-4(GID 1218086067416577): behavioral_events と chat_sessions を結合できるキーを通す
--
-- 背景: behavioral_events.session_id は r2c_sid(sessionStorage、タブ単位で安定、
-- widget.js の EventTracker._getOrCreateSessionId 参照)だが、chat_sessions.session_id は
-- conversationId(widget.js、ページ読込ごとにランダム再生成・永続化なし)であり、
-- 名前が同じだけで別物。behavioral_events側にこの結合キーが無く、
-- G5(measurementHealth.tsのchatOpenDropoff集計)が「説明不能」だった真因だった
-- (project_learning_ux_audit_20260824 / GID 1218086067416577)。
--
-- eventRoutes.ts の EventBatchSchema には既に chat_session_id(conversationId)の
-- 受け口があり、trackConversion / sendAnswerFeedback は既に送っているが、
-- 定期送信の EventTracker.flush() は送っておらず、しかも behavioral_events 側に
-- 保存する列自体が無かった。ここではその列を追加するのみ。
--
-- ★NULL許容・過去データはNULLのまま★
-- 会話が発生していないページのイベント(chat_session_idが無いイベント)もあるため
-- 任意項目。過去のイベントは結合不能なままにする(遡及埋め戻しはしない)。

ALTER TABLE behavioral_events ADD COLUMN IF NOT EXISTS chat_session_id TEXT;

COMMENT ON COLUMN behavioral_events.chat_session_id IS
  'widgetのconversationId(chat_sessions.session_idと同じ値)。behavioral_events.session_id(r2c_sid)とは別物で、chat_sessionsとの結合にのみ使う。会話が発生していないページのイベントではNULL。';

CREATE INDEX IF NOT EXISTS idx_behavioral_events_chat_session_id ON behavioral_events(tenant_id, chat_session_id);
