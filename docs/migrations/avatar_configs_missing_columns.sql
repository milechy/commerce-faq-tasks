-- avatar_configs: /api/internal/avatar-config の 500 を解消するための欠落カラム補填
-- 冪等マイグレーション（ADD COLUMN IF NOT EXISTS のみ。データ変更なし）
-- 実行タイミング: VPSで手動実行（hkobayashi）
-- 作成日: 2026-08-08
--
-- 背景:
--   GET /api/internal/avatar-config が本番で 500 を返し、avatar-agent がこれを
--   「アバター設定なし」と解釈して、ハードコードされた汎用 LemonSlice エージェント
--   (agent_aee377cb0fec68ea = R2C 公式18体のいずれでもない第三者) へ無言でフォールバック
--   していた。結果、どのテナントでも見ず知らずの人物が配信されていた。
--
--   500 の原因は、同ルートの SELECT が参照する後付けカラムのマイグレーション未適用。
--   下記3ファイルの内容と同一（本番に適用漏れがあるものだけが実際に効く）:
--     src/api/admin/avatar/migration_anam_fields.sql
--     src/api/admin/avatar/migration_agent_prompt.sql
--     src/api/admin/avatar/migration_category_persona.sql
--
--   手順の全文は docs/AVATAR_CONFIG_500_RECOVERY.md を参照。

-- ALTER TABLE は ACCESS EXCLUSIVE ロックを取る。avatar_configs は小さいテーブルだが、
-- 万一詰まったときに本番APIを巻き込んで待たせないよう上限を設ける。
SET lock_timeout = '5s';

-- Phase42: Anam.ai 移行フィールド
-- avatar_provider は NOT NULL DEFAULT 付きだが、PostgreSQL 11 以降は
-- テーブル書き換えを伴わないメタデータ操作で完了する。
ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS anam_avatar_id    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anam_voice_id     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anam_persona_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anam_llm_id       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS avatar_provider   VARCHAR(20) NOT NULL DEFAULT 'lemonslice';

-- Phase50: LemonSlice AvatarSession に渡す動作・アイドルプロンプト
ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS agent_prompt      TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS agent_idle_prompt TEXT DEFAULT NULL;

-- LemonSlice ペルソナスワップ: 商品カテゴリごとのペルソナ定義
ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS category_persona_map JSONB DEFAULT '{}'::jsonb;

-- 注: COMMENT ON ... IS は文字列リテラルのみを受け付け、|| による連結は構文エラーになる
-- （src/api/admin/avatar/migration_category_persona.sql は || を使っており実行できない。
--  同 PR で修正済み）。1つのリテラルとして書くこと。
COMMENT ON COLUMN avatar_configs.category_persona_map IS
  'カテゴリ名 → {image_url, agent_prompt, idle_prompt, voice_id} のマップ。会話中の話題カテゴリ変化に応じて LemonSlice Control API (update-image / update-agent-prompt / update-idle-prompt) でアバターの見た目・人格・声を切り替える際に参照する。';
