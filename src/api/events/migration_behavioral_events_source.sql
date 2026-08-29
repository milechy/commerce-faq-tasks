-- LB-8(5モデル価格ベンチマーク→LB-7調査から派生): behavioral_events に source を追加
--
-- 背景: chatOpenDropoff(measurementHealth.ts)の「開封」数(behavioral_events.chat_open)は
-- e2e/demo/chat_test を除外できず、「会話」数(chat_sessions、source='user'で除外済み)と
-- 分母・分子で扱いが食い違っていた。7月実績でchat_sessionsの82%がE2E由来だった実績を
-- 踏まえると、離脱率が実態より悪く出ている可能性が高い(project_sales_loop_audit_20260823)。
--
-- ★chat_sessions.metadata.sourceと同じ判定・同じallowlistを流用する★
-- (src/lib/traffic/trafficSource.ts の resolveTrafficSource / TrafficSource型)。
-- 新しい判定基準を作らない(基準が2つに割れると集計が食い違う)。
--
-- ★JOINでは補えない、列として直接持つ理由★
-- behavioral_events.session_id は r2c_sid(chat_sessions.session_id とは別物、
-- eventRoutes.ts のコメント参照)であり、しかも「開いただけで一度もメッセージを
-- 送らなかった」訪問者は chat_sessions 行自体が存在しない(saveMessage経由でのみ
-- 作られるため)。behavioral_events側にsourceが無いと、真に無言で去った実訪問者を
-- 事後のJOINで判定する手段が無い。ingestion時点(eventRoutes.ts の POST /api/events)
-- で resolveTrafficSource の結果をそのまま焼き付ける。
--
-- ★NULL許容・過去データはNULLのまま★
-- 過去のイベントは判定不能。集計側は source IS NULL を「不明」として扱い、
-- 'user'扱いに寄せない(母数不足で誤った自信を与えない、CLAUDE.md禁止34と同じ精神)。

ALTER TABLE behavioral_events ADD COLUMN IF NOT EXISTS source TEXT;

COMMENT ON COLUMN behavioral_events.source IS
  'chat_sessions.metadata.sourceと同じ判定(resolveTrafficSource)による記録: user/e2e/chat_test/demo/unknown。ingestion時点でのみ記録し、過去分はNULL(不明。userへ寄せない)。';

CREATE INDEX IF NOT EXISTS idx_behavioral_events_source ON behavioral_events(tenant_id, source);
