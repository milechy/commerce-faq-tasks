-- src/lib/billing/migration_usage_logs_session_id.sql
-- usage_logs に会話(chat_sessions)への紐付けを追加する。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ必要か（適用前は会話単位で請求できない）
-- 確定した課金単位はテキスト＝「会話(セッション)」だが(.claude/rules/billing.md §7)、
-- 適用前の usage_logs は `request_id`(リクエスト毎のランダム UUID)しか持たず、
-- **どの行が同じ会話に属するかを復元する手段が存在しなかった**。
-- そのため請求は「1行=1リクエスト」でしか数えられず、
-- 「会話を長く良くする」という製品目標がそのままテナントの値上げになっていた
-- (CLAUDE.md 禁止56)。この列があってはじめて
-- stripeSync.ts の computeExpectedBilling が COUNT(DISTINCT session_id) を取れる。
--
-- ■ NULL を許す理由（NOT NULL にしてはいけない）
-- 1. 本マイグレーション適用前に記録された既存行は当然 NULL のままになる。
--    NULL 行は「会話が不明」であって「会話ではない」ではないため、
--    computeExpectedBilling では従来どおり 1行=1単位 として数える
--    (取りこぼすと過少請求になる)。
-- 2. 管理系(admin_guide / admin_agent / admin_tuning 等)やアバター設定系の計上は
--    そもそもエンドユーザーの会話ではないので、恒久的に NULL のままが正しい。
-- 3. アバター経路(POST /api/internal/usage ← avatar-agent/agent.py)は
--    LiveKit の room 名しか知らず、R2C の chat_sessions.session_id を
--    受け取る配線が無い(2026-08-26 時点)。アバターは分単位
--    (SUM(avatar_session_ms))で請求でき会話のグルーピングを必要としないため、
--    この列は当面 NULL のままで支障が無い。
--
-- ■ 外部キーを張らない理由
-- chat_sessions の主キーは id(UUID)で、業務キーは (tenant_id, session_id) の複合。
-- FK を張るには usage_logs 側にも複合参照が要るうえ、chat_sessions には
-- Right to Erasure の削除経路(deleteSessionRepository.ts)がある。
-- FK + CASCADE を張ると**会話を削除した瞬間に利用記録=請求根拠ごと消える**。
-- usage_logs は毎リクエスト書き込まれる最高トラフィックの表でもあり、
-- ここで参照制約違反を出すと利用記録そのものが失われる
-- (migration_usage_logs_plan_snapshot.sql が CHECK 制約を張らなかったのと同じ理由)。
-- 突合は computeExpectedBilling 側の LEFT JOIN で行い、
-- 対応する chat_sessions 行が無い場合も請求を落とさない。

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS session_id TEXT;

COMMENT ON COLUMN usage_logs.session_id IS
  'この行が属する会話。chat_sessions.session_id と (tenant_id, session_id) で対応する。'
  'テキストチャット(/api/chat)のみが値を入れる。'
  'アバター経路(POST /api/internal/usage)は session_id を知らないため NULL のままで、'
  'アバターは分(avatar_session_ms)で請求するのでグルーピングを必要としない。'
  '管理系の計上は会話ではないため恒久的に NULL。'
  'NULL = 会話不明であって「会話ではない」ではない。請求では 1行=1単位 にフォールバックする。';

-- 請求集計(computeExpectedBilling)は tenant_id + created_at で絞ったうえで
-- session_id ごとに DISTINCT ON を取る。会話数の多いテナントのソートを避ける。
CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_session
  ON usage_logs(tenant_id, session_id)
  WHERE session_id IS NOT NULL;
