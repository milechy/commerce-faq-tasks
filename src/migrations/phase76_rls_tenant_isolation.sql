-- phase76_rls_tenant_isolation.sql
-- P1: テナント分離の恒久バックストップ（多層防御）として Postgres Row Level
-- Security の「足場」を導入する。
--
-- ============================================================================
-- ★このマイグレーションが「達成すること」と「達成しないこと」を最初に明記する★
-- ============================================================================
-- 現状、テナント分離はアプリ層(各クエリの WHERE tenant_id = $n)に 100% 依存
-- しており、どこか 1 本のクエリで述語を書き忘れると無言で越境漏洩する
-- (単一 DB ロール・単一 pg Pool、src/lib/db.ts)。RLS を二層目の防御として敷く。
--
-- 【このファイルが達成すること】
--   1. tenant_id 列を持つ public スキーマの全テーブルに ROW LEVEL SECURITY を
--      ENABLE し、統一ポリシー rls_tenant_isolation を(再)作成する。
--   2. tenants テーブル本体(テナント識別列は id)にも同等のポリシーを敷く。
--   3. ポリシーの述語が読む GUC(app.current_tenant / app.is_super_admin)を
--      解決するヘルパ関数を作る。アプリ側は src/lib/db.ts の withTenant() が
--      トランザクション単位で set_config() によりこれらをセットする。
--
-- 【このファイルが"まだ"達成しないこと(＝運用タスクとして残ること)】
--   ● RLS の「実効化」。ポリシーは ENABLE するが FORCE しない。かつ、現状の
--     アプリ接続ロール(DATABASE_URL のユーザー、通常 postgres)は各テーブルの
--     オーナー/スーパーユーザー相当であり、RLS はテーブルオーナーに対しては
--     バイパスされる。したがって本ファイル適用直後は、アプリの実挙動は一切
--     変わらない(＝既存の全経路・全テストが無影響)。
--   ● RLS を実際に効かせるには「専用の非オーナーDBロールへアプリ接続を切り替える」
--     運用ステップが別途必要。手順はこのファイル末尾の (RUNBOOK) を参照。
--     この切替は影響が全経路に及ぶため、本 PR のゴールにはしない(段階導入)。
--
-- 【後方互換性(＝既存経路を絶対に壊さないための設計)】
--   ポリシー述語は「app.current_tenant が未設定なら全行を許可」する。withTenant()
--   を経由しない既存の 300 本超のクエリ経路は GUC を設定しないため、たとえ将来
--   非オーナーロールへ切り替えても、GUC 未設定のトランザクションは従来どおり
--   全行を見る(＝挙動不変)。越境防御は「withTenant() を通した経路」で二重に効く。
--   移行が進むにつれて、より多くの経路を withTenant() 経由へ寄せていく(別タスク)。
--
-- 冪等性: ヘルパ関数は CREATE OR REPLACE、ポリシーは DROP POLICY IF EXISTS →
--   CREATE。ENABLE ROW LEVEL SECURITY は複数回実行しても安全。対象テーブルは
--   information_schema から動的に発見するため、テーブルが存在しない DB
--   (例: 課金スキーマだけを作る CI)に適用しても、そのテーブルは単にスキップされる。
--   → SCRIPTS/ci-billing-schema.sh のような「一部テーブルだけ作る」CI でも
--     42P01 で落ちない。
--
-- 適用: 本リポジトリには「全 migration を機械的に流す」仕組みは無く、人間が個別に
--   適用する運用(CLAUDE.md 禁止8)。本ファイルも他の migration と同様に、対象 DB へ
--   `psql -v ON_ERROR_STOP=1 -1 "$DATABASE_URL" -f src/migrations/phase76_rls_tenant_isolation.sql`
--   で 1 回適用する。Gate4(Postgres)では構文が通ることを確認する。
--
--   トランザクション制御: このファイルは明示的な BEGIN/COMMIT を持たない。
--   `psql -1`(ci-billing-schema.sh と同じ適用方法)が全体を 1 トランザクションに
--   包む。素の psql で流す場合も各 DDL は Postgres の仕様上トランザクショナルで、
--   冪等なので途中失敗しても再実行で回復する。

-- ---------------------------------------------------------------------------
-- 1. ヘルパ関数: ポリシー述語が参照する GUC を解決する
-- ---------------------------------------------------------------------------
-- app.current_tenant: withTenant() が set_config('app.current_tenant', $tenantId, true)
--   でトランザクションローカルに設定する。空文字/未設定は「制限なし(移行期の後方互換)」。
-- app.is_super_admin: 'on' のとき全テナント横断アクセスを許可(super_admin 経路)。
--
-- current_setting(..., true) の第2引数 true は missing_ok。GUC が一度も設定されて
-- いないトランザクションでもエラーにせず NULL を返す(＝後方互換の要)。
-- STABLE: セッション/トランザクション状態のみに依存し、行ごとに変化しない。

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_tenant', true), '') $$;

CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.is_super_admin', true) = 'on' $$;

COMMENT ON FUNCTION app_current_tenant() IS
  'RLS: 現在のトランザクションに紐づくテナントID(withTenant()が設定)。未設定はNULL=制限なし(後方互換)。';
COMMENT ON FUNCTION app_is_super_admin() IS
  'RLS: 現在のトランザクションが全テナント横断アクセス(super_admin)かどうか。';

-- ---------------------------------------------------------------------------
-- 2. tenant_id 列を持つ全テーブルに RLS を敷く(動的発見・冪等)
-- ---------------------------------------------------------------------------
-- ポリシー述語(USING / WITH CHECK 共通):
--   app_current_tenant() IS NULL   -- 未設定 = 制限なし(既存経路の後方互換)
--   OR app_is_super_admin()        -- super_admin = 全テナント
--   OR tenant_id = app_current_tenant()  -- テナント一致
--
-- ENABLE のみで FORCE しない理由: 本ファイル適用直後にオーナー接続の実挙動を
-- 変えないため(段階導入)。非オーナーロールへ切替後、この ENABLE が効き始める。
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS rls_tenant_isolation ON public.%I', r.table_name);
    EXECUTE format($f$
      CREATE POLICY rls_tenant_isolation ON public.%I
        USING (
          app_current_tenant() IS NULL
          OR app_is_super_admin()
          OR tenant_id = app_current_tenant()
        )
        WITH CHECK (
          app_current_tenant() IS NULL
          OR app_is_super_admin()
          OR tenant_id = app_current_tenant()
        )
    $f$, r.table_name);
    RAISE NOTICE 'RLS enabled + policy (re)created on public.% (tenant_id)', r.table_name;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. tenants テーブル本体(テナント識別列は id、tenant_id ではない)
-- ---------------------------------------------------------------------------
-- 上の動的ループは列名 'tenant_id' を条件にしているため tenants は対象外。
-- tenants は自分自身の行(id = 現在のテナント)だけを見せる。super_admin は全件。
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS rls_tenant_isolation ON public.tenants';
    EXECUTE $f$
      CREATE POLICY rls_tenant_isolation ON public.tenants
        USING (
          app_current_tenant() IS NULL
          OR app_is_super_admin()
          OR id = app_current_tenant()
        )
        WITH CHECK (
          app_current_tenant() IS NULL
          OR app_is_super_admin()
          OR id = app_current_tenant()
        )
    $f$;
    RAISE NOTICE 'RLS enabled + policy (re)created on public.tenants (id)';
  END IF;
END $$;

-- ===========================================================================
-- (RUNBOOK) RLS を「実効化」するための運用ステップ ── 本 PR のスコープ外
-- ===========================================================================
-- 本ファイルは足場(ポリシー+配線)を用意するだけで、適用しても実挙動は変わらない。
-- 実際に RLS を効かせるには、アプリ接続をテーブルオーナーではない専用ロールへ
-- 切り替える。以下は将来の運用タスクのテンプレート(このファイルでは実行しない):
--
--   -- 1) 非オーナーの専用アプリロールを作成
--   CREATE ROLE r2c_app LOGIN PASSWORD '***';
--
--   -- 2) 必要な権限のみ付与(オーナーにはしない ← ここが肝。オーナーは RLS バイパス)
--   GRANT USAGE ON SCHEMA public TO r2c_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO r2c_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO r2c_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO r2c_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT USAGE, SELECT ON SEQUENCES TO r2c_app;
--
--   -- 3) DATABASE_URL を r2c_app 接続へ切り替えて再起動(deploy-vps.sh 経由)。
--   --    この時点で「app.current_tenant を設定したトランザクション」だけが
--   --    テナント行に絞られ、設定しないトランザクションは従来どおり全行を見る
--   --    (後方互換)。段階的に各経路を withTenant() へ寄せていく。
--
--   -- 4) 全経路が withTenant() を通り、GUC 未設定での全行アクセスに依存しなく
--   --    なった段階で、初めて各テーブルに FORCE ROW LEVEL SECURITY を検討する
--   --    (オーナー接続にも RLS を強制。これはさらに後段の別タスク)。
