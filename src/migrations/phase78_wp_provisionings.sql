-- Phase78: wp_provisionings（WordPress プラグインのプロビジョニング中間状態）
-- 実行日: VPS で手動実行（★自動実行しない → CLAUDE.md 絶対にやってはいけないこと 8）
-- 対象: VPS PostgreSQL (65.108.159.161)
-- 要件: docs/WORDPRESS_PLUGIN_REQUIREMENTS.md §5.1 / §5.2
--
-- 設計意図:
--   WordPress プラグインからのセルフサインアップは「申告 → サイト所有証明 →
--   メール到達確認 → テナント発行」の多段で、確定するまでの中間状態を持つ。
--   CLAUDE.md「確定前の下書き・生成候補の保持は実体テーブル。プロセス内 Map
--   （knowledgeImportStaging 型）を新設しない」に従い、テーブルとして持つ。
--   面をまたぐ／プロセス再起動で TTL 失効し孤児化するのを避けるため。
--
-- テナント分離方針:
--   この行が作られる時点ではまだテナントが存在しない（テナントを作るための
--   手続きそのもの）。したがって tenant_id は NULL 許容で、発行成功時にだけ
--   埋まる。テナント削除時は SET NULL で履歴を残す — 削除しても「その origin で
--   いつ発行したか」の記録は総量ガードの日次集計と調査に要るため。
--
-- 秘密値の扱い:
--   challenge / poll_token の平文は保存しない。tenant_api_keys.key_hash と
--   同じく SHA-256 ハッシュのみを持つ（src/api/widget/wpProvisionToken.ts）。
--   email は PII のため、ログにはこのテーブルの値を出さない。

-- ============================================================
-- 1. wp_provisionings テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS wp_provisionings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- normalizeWpSiteUrl() が返した正規化済み origin（パス・クエリを含まない）。
  -- 生の site_url は保存しない。照合は常にこの正規化後の値で行う。
  site_origin        TEXT NOT NULL,
  email              TEXT NOT NULL,

  -- 平文は発行時に一度返すだけで保存しない。
  challenge_hash     TEXT NOT NULL,
  poll_token_hash    TEXT NOT NULL UNIQUE,

  -- 「存在しない」と「期限切れ」と「失敗」を同じ値で表現しない（→ 禁止20）。
  -- 区別しないと、プラグイン側に再送導線を出せない（要件書 X-2 / I-7）。
  --   pending        … 申告を受けた。サイト所有証明とメール確認の両方が未了
  --   site_verified  … サイト所有証明が通った。メール確認待ち
  --   provisioned    … テナントとキーを発行済み（確定）
  --   expired        … TTL 超過
  --   failed         … 検証に失敗（失敗理由は failure_reason）
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'site_verified', 'provisioned', 'expired', 'failed')),

  tenant_id          TEXT REFERENCES tenants(id) ON DELETE SET NULL,

  -- プラグインが申告する環境情報（要件書 FR-03 の範囲に限定）。
  -- 投稿内容・ユーザー情報・アクセスログは受け取らないし保存しない。
  site_name          TEXT,
  wp_version         TEXT,
  plugin_version     TEXT,
  locale             TEXT,

  -- status='failed' のときの理由コード。利用者に「なぜ到達できないか」を
  -- 具体的に返すために持つ（要件書 I-8 / I-9）。文言ではなくコードを入れる。
  failure_reason     TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  site_verified_at   TIMESTAMPTZ,
  email_verified_at  TIMESTAMPTZ,
  provisioned_at     TIMESTAMPTZ
);

-- ============================================================
-- 2. インデックス
-- ============================================================

-- ★同一 origin で2つ目のテナントを作らせない（要件書 I-3 / I-4 / X-3）。
-- プラグインを削除して再インストールすると wp_options が消えるため、利用者は
-- 同じドメインから何度でも接続をやり直す。アプリ側の存在チェックだけだと
-- 同時実行で二重に発行され得るので、DB の部分ユニークインデックスで閉じる。
-- 未確定（pending / failed / expired）の行は同じ origin に何本あってもよい。
CREATE UNIQUE INDEX IF NOT EXISTS uq_wp_provisionings_provisioned_site
  ON wp_provisionings (site_origin) WHERE status = 'provisioned';

-- サイト所有証明の照合用。
CREATE INDEX IF NOT EXISTS idx_wp_provisionings_challenge_hash
  ON wp_provisionings (challenge_hash);

-- 「この origin に既存の手続きがあるか」の確認用。
CREATE INDEX IF NOT EXISTS idx_wp_provisionings_site_status
  ON wp_provisionings (site_origin, status);

-- 総量ガード（当日の新規作成数）の集計用。要件書 §5.4 / D7。
CREATE INDEX IF NOT EXISTS idx_wp_provisionings_created_at
  ON wp_provisionings (created_at DESC);

-- 発行済みテナントからの逆引き（サポート・調査用）。
CREATE INDEX IF NOT EXISTS idx_wp_provisionings_tenant_id
  ON wp_provisionings (tenant_id) WHERE tenant_id IS NOT NULL;

-- ============================================================
-- 3. コメント
-- ============================================================

COMMENT ON TABLE wp_provisionings IS
  'Phase78: WordPress プラグインのセルフサインアップにおける確定前の中間状態。申告→サイト所有証明→メール確認→テナント発行の多段手続きを保持する。';
COMMENT ON COLUMN wp_provisionings.site_origin IS
  'normalizeWpSiteUrl() が返した正規化済み origin。生の site_url は保存しない。';
COMMENT ON COLUMN wp_provisionings.challenge_hash IS
  'サイト所有証明のチャレンジ値の SHA-256。平文は保存しない。';
COMMENT ON COLUMN wp_provisionings.poll_token_hash IS
  'プラグインが状態確認に使うトークンの SHA-256。平文は保存しない。';
COMMENT ON COLUMN wp_provisionings.status IS
  'pending / site_verified / provisioned / expired / failed。「存在しない」と「期限切れ」を同じ値で表現しない（禁止20）。';
COMMENT ON COLUMN wp_provisionings.tenant_id IS
  '発行成功時のみ埋まる。テナント削除時は SET NULL で履歴を残す（総量ガードの集計と調査に要る）。';
COMMENT ON COLUMN wp_provisionings.failure_reason IS
  'status=failed のときの理由コード。利用者に具体的な原因を返すために持つ。文言ではなくコードを入れる。';
