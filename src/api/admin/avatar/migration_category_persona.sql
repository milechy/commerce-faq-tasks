-- LemonSliceペルソナスワップ: 商品カテゴリごとのペルソナ定義
-- キーはカテゴリ名(queryPlanner.ts の filters.category 準拠、例: "product" "returns" 等の
-- 業種依存語彙をテナントが独自定義)、値は LemonSlice Session Control API に渡すペルソナ定義。
ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS category_persona_map JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN avatar_configs.category_persona_map IS
  'カテゴリ名 → {image_url, agent_prompt, idle_prompt, voice_id} のマップ。' ||
  '会話中の話題カテゴリ変化に応じて LemonSlice Control API (update-image / update-agent-prompt / ' ||
  'update-idle-prompt) でアバターの見た目・人格・声を切り替える際に参照する。';
