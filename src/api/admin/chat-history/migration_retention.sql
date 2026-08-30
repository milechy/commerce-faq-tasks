-- 会話の保持期間(retention) + テナント退会時のデータ消去 予約フラグ
--
-- 個情法/GDPR 対応の一環。会話本文(chat_messages.content)は現状「無期限・平文」で
-- 保存されており、削除/保持期間/退会消去の導線が無かった。本 migration は additive で、
-- 既存の読み書き経路には一切影響しない(列/索引の追加のみ)。
--
-- 適用は人間が手動で行う前提(CLAUDE.md: migration は人間適用)。適用前は:
--   - 保持バッチ(SCRIPTS/purge-chat-retention.ts)は CHAT_RETENTION_DAYS 未設定なら no-op
--   - テナント退会の「消去予約」API は下記列が無いと 500 になる(既存機能には無害)
-- という状態になる。

-- 1) 保持バッチのカットオフ走査用の索引。
-- 既存の idx_chat_sessions_tenant は (tenant_id, last_message_at DESC) で、
-- テナント横断の `WHERE last_message_at < :cutoff` を効率化しないため単独列索引を足す。
CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_message
  ON chat_sessions(last_message_at);

-- 2) テナント退会時のデータ消去「予約」フラグ。
-- 即時の全消去は取り返しがつかないため、既定は「予約 → 猶予期間後にバッチ消去」。
--   chat_data_purge_requested_at: 消去予約時刻(NULL = 予約なし)
--   chat_data_purged_at:          実際に消去が完了した時刻(監査/再実行防止用)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS chat_data_purge_requested_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS chat_data_purged_at TIMESTAMPTZ;

COMMENT ON COLUMN tenants.chat_data_purge_requested_at IS
  '会話データ消去の予約時刻。NULL=予約なし。TENANT_PURGE_GRACE_DAYS 経過後に purge-chat-retention バッチが消去する。POST /v1/admin/tenants/:id/purge-chat-data で設定/解除。';
COMMENT ON COLUMN tenants.chat_data_purged_at IS
  '会話データ消去が完了した時刻。再消去のスキップ判定と監査に用いる。';
