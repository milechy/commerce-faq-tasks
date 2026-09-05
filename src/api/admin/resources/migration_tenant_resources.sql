-- 資料オファー機能: tenant_resources テーブル新設
--
-- Supabase Storage バケット（本 migration では作成しない。人間が事前に用意する）:
--   bucket name: tenant-resources
--   path convention: {tenantId}/{resourceId}.{ext}  (avatar-images バケットの規約に準拠)

CREATE TABLE IF NOT EXISTS tenant_resources (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  title              TEXT        NOT NULL,
  description        TEXT,
  storage_path       TEXT,
  external_url       TEXT,
  file_type          TEXT,
  moderation_status  TEXT        NOT NULL DEFAULT 'pending',
  moderation_reason  TEXT,
  rights_confirmed   BOOLEAN     NOT NULL DEFAULT false,
  is_published       BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN tenant_resources.id IS '資料オファーのID';
COMMENT ON COLUMN tenant_resources.tenant_id IS 'テナントID。UNIQUE制約が「テナントごとに資料オファーは1件」を強制する唯一の仕組み';
COMMENT ON COLUMN tenant_resources.title IS '資料のタイトル（会話中にAIが案内する表示名）';
COMMENT ON COLUMN tenant_resources.description IS '資料の説明文（任意）';
COMMENT ON COLUMN tenant_resources.storage_path IS 'Supabase Storage tenant-resources バケット内のパス（{tenantId}/{resourceId}.{ext}）。PDFアップロード時のみ設定';
COMMENT ON COLUMN tenant_resources.external_url IS '外部URL資料の場合の遷移先URL。storage_path と排他利用（アプリ層で担保）';
COMMENT ON COLUMN tenant_resources.file_type IS 'ファイル種別（例: pdf / external_url）';
COMMENT ON COLUMN tenant_resources.moderation_status IS 'モデレーション状態（pending / approved / rejected）';
COMMENT ON COLUMN tenant_resources.moderation_reason IS 'モデレーションで却下された場合の理由（任意）';
COMMENT ON COLUMN tenant_resources.rights_confirmed IS 'テナントが第三者の著作権等を侵害しないことを確認したか';
COMMENT ON COLUMN tenant_resources.is_published IS '会話でAIが案内してよい状態か。テナントの確認前は false（CLAUDE.md 絶対にやってはいけないこと5）';
COMMENT ON COLUMN tenant_resources.created_at IS '作成日時';
COMMENT ON COLUMN tenant_resources.updated_at IS '更新日時';

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION update_tenant_resources_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_resources_updated_at
  BEFORE UPDATE ON tenant_resources
  FOR EACH ROW EXECUTE FUNCTION update_tenant_resources_updated_at();
