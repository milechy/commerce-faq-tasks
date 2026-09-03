-- src/api/admin/tuning/migration_proposal_type.sql
-- D8-2: tuning_rules に提案種別を足し、「承認しても本番プロンプトに入らない提案」を
-- 同じテーブルで安全に扱えるようにする。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ tuning_rules に相乗りするのか（新テーブルを作らない）
-- 提案の受け皿は judge提案 / suggested_rules / knowledge_gaps / Hermes の4系統で
-- 打ち止め(src/api/hermes-mcp/CLAUDE.md「提案の受け皿を増やさない」、
-- docs/LEARNING_LOOP_REQUIREMENTS.md R6)。hermes_strategy_proposals を承認導線として
-- 育てないという決定も同じ場所で明文化されている。アップセル提案もこの決定に従い、
-- 新テーブルではなく既存 tuning_rules に着地させ、種別だけをこの1列で分ける。
--
-- ■ なぜ DEFAULT 'behavior' なのか
-- この列を知らない既存の INSERT 経路(judgeEvaluator / insertTuningRuleFromSuggestion /
-- createRule)の挙動を1ミリも変えないため。既存行もすべて behavior になる。
-- 逆に upsell を作る経路は POST /v1/hermes-mcp/proposals の1本だけで、そこでは
-- 必ず明示的に渡す(列を省略してスキーマ既定に委ねない — is_active を省略すると
-- DEFAULT true で即本番プロンプトに入る、という既知の事故と同じ理由)。

ALTER TABLE tuning_rules
  ADD COLUMN IF NOT EXISTS proposal_type TEXT NOT NULL DEFAULT 'behavior';

COMMENT ON COLUMN tuning_rules.proposal_type IS
  'D8-2: 提案の種別。'
  'behavior=応答方針(従来。承認すると is_active=true になり本番プロンプトへ入る) / '
  'upsell=営業提案(承認しても is_active は false のまま。getActiveRulesForTenant には永久に載らない)。'
  'DEFAULT が behavior なのは、この列を知らない既存 INSERT 経路の挙動を変えないため。'
  'upsell を作る経路は POST /v1/hermes-mcp/proposals の1本だけで、そこでは必ず明示的に渡す。';

-- 値の allowlist。増やすときはここと UpsellSignal / TuningRule 型を同じ PR で。
ALTER TABLE tuning_rules DROP CONSTRAINT IF EXISTS tuning_rules_proposal_type_check;
ALTER TABLE tuning_rules ADD  CONSTRAINT tuning_rules_proposal_type_check
  CHECK (proposal_type IN ('behavior', 'upsell'));

-- ★D8-2 の不変条件を DB 側でも固定する★
-- コード側3箇所(approveTuningRule / rejectTuningRule / updateRule)の分岐が
-- 1つでも漏れたら、ここで 23514 になって「静かに本番プロンプトへ入る」より前に落ちる。
ALTER TABLE tuning_rules DROP CONSTRAINT IF EXISTS tuning_rules_upsell_never_active_check;
ALTER TABLE tuning_rules ADD  CONSTRAINT tuning_rules_upsell_never_active_check
  CHECK (proposal_type <> 'upsell' OR is_active = false);

COMMENT ON CONSTRAINT tuning_rules_upsell_never_active_check ON tuning_rules IS
  'D8-2: is_active=true になれるのは proposal_type=''behavior'' の行だけ。'
  'getActiveRulesForTenant は is_active しか見ない(D8)ため、注入経路を1文字も変えずに'
  'アップセル提案の本番混入を構造的に不能にする唯一の砦。'
  '★getActiveRulesForTenant の WHERE に proposal_type 条件を足さないこと★ — '
  '足すと本マイグレーション未適用のままデプロイした瞬間に 42703 で全テナントの回答経路が落ちる。';

CREATE INDEX IF NOT EXISTS idx_tuning_rules_proposal_type_status
  ON tuning_rules (proposal_type, status);

-- ■ D8 不変条件の再定義（migration_approval_state.sql は書き換えず、ここで拡張する）
--   D8   (behavior): status='active'   ⇒ is_active=true
--                    status='rejected' ⇒ is_active=false
--   D8-2 (upsell)  : status='active'   ⇒ is_active=false （常に）
--                    status='rejected' ⇒ is_active=false
--   共通(強化形)   : is_active=true    ⇒ proposal_type='behavior'
-- 「status → is_active」ではなく「is_active=true になれるのは behavior だけ」を
-- 唯一の真実に据え直すのがこのマイグレーションの要点。

-- ============================================================
-- 確認クエリ (適用後に手動確認)
-- ============================================================
-- \d tuning_rules
-- SELECT proposal_type, status, is_active, count(*) FROM tuning_rules GROUP BY 1,2,3;
--   → upsell かつ is_active=true の行が 0 件であること
--
-- ロールバック
-- ALTER TABLE tuning_rules DROP CONSTRAINT IF EXISTS tuning_rules_upsell_never_active_check;
-- ALTER TABLE tuning_rules DROP CONSTRAINT IF EXISTS tuning_rules_proposal_type_check;
-- ALTER TABLE tuning_rules DROP COLUMN IF EXISTS proposal_type;
