-- LemonSliceペルソナスワップ: 商品カテゴリごとのペルソナ定義
-- キーはカテゴリ名(queryPlanner.ts の filters.category 準拠、例: "product" "returns" 等の
-- 業種依存語彙をテナントが独自定義)、値は LemonSlice Session Control API に渡すペルソナ定義。
ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS category_persona_map JSONB DEFAULT '{}'::jsonb;

-- COMMENT ON ... IS は文字列リテラルのみを受け付ける。|| による連結は
-- 「syntax error at or near "||"」になり、このファイルが最後まで流せなくなる。
-- （ALTER TABLE は先に成功するため、カラムだけ出来てコメントが付かない中途半端な
--   状態になり、ON_ERROR_STOP を付けて実行すると全体が異常終了する）
COMMENT ON COLUMN avatar_configs.category_persona_map IS
  'カテゴリ名 → {image_url, agent_prompt, idle_prompt, voice_id} のマップ。会話中の話題カテゴリ変化に応じて LemonSlice Control API (update-image / update-agent-prompt / update-idle-prompt) でアバターの見た目・人格・声を切り替える際に参照する。';
